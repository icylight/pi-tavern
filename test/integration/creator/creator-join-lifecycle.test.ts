import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import type { CharacterCard } from "../../../src/config/character-card.js";
import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";
import { decodeServerMessage, encodeMessage } from "../../../src/protocol/codec.js";

const temporaryDirectories: string[] = [];
const runtimes: CreatorRuntime[] = [];
const sockets: WebSocket[] = [];

const characters: CharacterCard[] = [
	{
		characterId: "characters/architect.md",
		name: "Architect",
		description: "Architecture",
		path: "/characters/architect.md",
		prompt: "Architect prompt",
	},
	{
		characterId: "characters/developer.md",
		name: "Developer",
		description: "Development",
		path: "/characters/developer.md",
		prompt: "Developer prompt",
	},
];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-join-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const socket of sockets.splice(0)) {
		socket.terminate();
	}
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CreatorRuntime Character join lifecycle", () => {
	it("keeps a Character pending until ready, then exposes state and broadcasts", async () => {
		const runtime = await startRuntime();
		const peer = await connectPeer(runtime);

		peer.send({ id: "join", type: "join_group_chat", session_id: "session-1" });
		expect(await peer.next()).toEqual({
			id: "join",
			type: "response",
			command: "join_group_chat",
			success: true,
			data: {
				available_characters: characters.map(toSummaryMessage),
			},
		});
		expect(runtime.state.onlineCharacters.size).toBe(0);

		peer.send({
			id: "claim",
			type: "claim_character",
			character_id: characters[0]?.characterId,
		});
		expect(await peer.next()).toEqual({
			id: "claim",
			type: "response",
			command: "claim_character",
			success: true,
			data: {
				character: {
					...toSummaryMessage(characters[0] as CharacterCard),
					path: characters[0]?.path,
				},
			},
		});
		expect(runtime.state.characterReservations.get(characters[0]?.characterId as string)).toBe("session-1");
		expect(runtime.state.onlineCharacters.size).toBe(0);

		peer.send({ id: "ready", type: "character_ready" });
		expect(await peer.next()).toEqual({
			id: "ready",
			type: "response",
			command: "character_ready",
			success: true,
		});
		expect(await peer.next()).toEqual({
			type: "message_history",
			messages: [],
			cursor: null,
			has_more: false,
			total_messages: 0,
		});
		expect(await peer.next()).toEqual({
			type: "character_joined",
			character: toSummaryMessage(characters[0] as CharacterCard),
		});

		// 方案 A (ISSUE-014/#14): membership changes also broadcast a
		// group_chat_update 使其他角色刷新其快照。
		// 加入时：尚无消息，故 latest_sequence=0 / 预览为空。
		expect(await peer.next()).toEqual({
			type: "group_chat_update",
			latest_sequence: 0,
			preview_messages: [],
			total_messages: 0,
		});

		expect(runtime.state.characterReservations.size).toBe(0);
		expect(runtime.connections.get("session-1")?.readyState).toBe(WebSocket.OPEN);
		expect(runtime.state.onlineCharacters.get("session-1")).toMatchObject({
			sessionId: "session-1",
			character: {
				characterId: characters[0]?.characterId,
				name: "Architect",
			},
			isStreaming: false,
			handRaised: false,
		});

		peer.send({ id: "state", type: "get_group_chat_state" });
		expect(await peer.next()).toMatchObject({
			id: "state",
			type: "response",
			command: "get_group_chat_state",
			success: true,
			data: {
				round: null,
				online_characters: [
					{
						character_id: characters[0]?.characterId,
						is_self: true,
						is_streaming: false,
						hand_raised: false,
					},
				],
			},
		});

		peer.send({ type: "update_character_state", is_streaming: true });
		await vi.waitFor(() => expect(runtime.state.onlineCharacters.get("session-1")?.isStreaming).toBe(true));
	});

	it("prevents the same Character from being reserved twice", async () => {
		const runtime = await startRuntime();
		const first = await connectPeer(runtime);
		const second = await connectPeer(runtime);
		await joinGroupChat(first, "session-1");
		await joinGroupChat(second, "session-2");

		await claim(first, "claim-1", characters[0]?.characterId as string);
		second.send({
			id: "claim-2",
			type: "claim_character",
			character_id: characters[0]?.characterId,
		});
		expect(await second.next()).toEqual({
			id: "claim-2",
			type: "response",
			command: "claim_character",
			success: false,
			error: "Character is no longer available",
		});

		first.send({ id: "ready", type: "character_ready" });
		await first.next();
		await first.next();
		await first.next();
		second.send({ id: "refresh", type: "join_group_chat", session_id: "session-2" });
		expect(await second.next()).toMatchObject({
			data: {
				available_characters: [toSummaryMessage(characters[1] as CharacterCard)],
			},
		});
	});

	it("releases a reservation before closing a timed-out pending connection", async () => {
		const runtime = await startRuntime(30);
		const peer = await connectPeer(runtime);
		await joinGroupChat(peer, "session-1");
		await claim(peer, "claim", characters[0]?.characterId as string);

		await peer.closed;

		expect(runtime.state.characterReservations.size).toBe(0);
		expect(runtime.state.onlineCharacters.size).toBe(0);
	});

	it("removes members once for active leave and unexpected disconnect", async () => {
		const runtime = await startRuntime();
		const first = await connectAndReady(runtime, "session-1", characters[0]?.characterId as string);
		const second = await connectAndReady(runtime, "session-2", characters[1]?.characterId as string);
		// 方案 A (ISSUE-014/#14): drain first's queue — its own join-time
		// group_chat_update，然后是第二个角色的加入广播
		//（character_joined + group_chat_update）。
		await first.next();
		await first.next();
		await first.next();

		first.send({ id: "leave", type: "leave_group_chat" });
		// 方案 A (ISSUE-014/#14): second still has its own join-time
		// 队列中先于离开广播的 group_chat_update。
		expect(await second.next()).toMatchObject({ type: "group_chat_update" });
		expect(await second.next()).toEqual({
			type: "character_left",
			character: toSummaryMessage(characters[0] as CharacterCard),
			reason: "left",
		});
		// 方案 A: the leave broadcast carries a group_chat_update too; the
		// snapshot must no longer contain the departed member (A4 真值).
		expect(await second.next()).toMatchObject({ type: "group_chat_update" });
		second.send({ id: "state-after-leave", type: "get_group_chat_state" });
		expect(await second.next()).toMatchObject({
			id: "state-after-leave",
			type: "response",
			command: "get_group_chat_state",
			success: true,
			data: {
				online_characters: [
					{
						character_id: characters[1]?.characterId,
						is_self: true,
						is_streaming: false,
						hand_raised: false,
					},
				],
			},
		});
		expect(await first.next()).toEqual({
			id: "leave",
			type: "response",
			command: "leave_group_chat",
			success: true,
		});
		await first.closed;
		expect(runtime.connections.has("session-1")).toBe(false);
		expect(runtime.state.onlineCharacters.has("session-1")).toBe(false);

		second.socket.terminate();
		await second.closed;
		await vi.waitFor(() => expect(runtime.state.onlineCharacters.size).toBe(0));
		expect(runtime.connections.size).toBe(0);
	});

	it("rejects a second ready connection for the same pi session", async () => {
		const runtime = await startRuntime();
		const first = await connectPeer(runtime);
		const second = await connectPeer(runtime);
		await joinGroupChat(first, "same-session");
		await joinGroupChat(second, "same-session");
		await claim(first, "claim-1", characters[0]?.characterId as string);
		await claim(second, "claim-2", characters[1]?.characterId as string);

		first.send({ id: "ready-1", type: "character_ready" });
		await first.next();
		await first.next();
		await first.next();
		const firstOwnedConnection = runtime.connections.get("same-session");
		second.send({ id: "ready-2", type: "character_ready" });
		expect(await second.next()).toEqual({
			id: "ready-2",
			type: "response",
			command: "character_ready",
			success: false,
			error: "This pi session is already in the group chat",
		});
		expect(runtime.connections.get("same-session")).toBe(firstOwnedConnection);
		expect(runtime.state.onlineCharacters.get("same-session")?.character.name).toBe("Architect");
	});

	it("rejects the wrong identity path and closes malformed protocol connections without state", async () => {
		const runtime = await startRuntime();
		const descriptor = runtime.activeDescriptor;
		const wrongPath = new WebSocket(`ws://${descriptor.host}:${descriptor.port}/wrong/path`);
		sockets.push(wrongPath);
		await expect(
			new Promise<void>((resolve, reject) => {
				wrongPath.once("open", resolve);
				wrongPath.once("error", reject);
			}),
		).rejects.toThrow();

		const peer = await connectPeer(runtime);
		peer.socket.send("{broken");
		await peer.closed;

		expect(runtime.state.characterReservations.size).toBe(0);
		expect(runtime.state.onlineCharacters.size).toBe(0);
		expect(runtime.connections.size).toBe(0);
	});
});

async function startRuntime(readyTimeoutMs = 5_000): Promise<CreatorRuntime> {
	const root = await createTemporaryDirectory();
	const runtime = await CreatorRuntime.startNew(
		{
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters,
		},
		{ readyTimeoutMs },
	);
	runtimes.push(runtime);
	return runtime;
}

interface Peer {
	socket: WebSocket;
	send(message: unknown): void;
	next(): Promise<unknown>;
	closed: Promise<void>;
}

async function connectPeer(runtime: CreatorRuntime): Promise<Peer> {
	const descriptor = runtime.activeDescriptor;
	const socket = new WebSocket(
		`ws://${descriptor.host}:${descriptor.port}/${descriptor.groupChatId}/${descriptor.instanceId}`,
	);
	sockets.push(socket);
	const messages: unknown[] = [];
	const waiters: Array<(message: unknown) => void> = [];
	socket.on("message", (data) => {
		const message = decodeServerMessage(data);
		const waiter = waiters.shift();
		if (waiter) {
			waiter(message);
		} else {
			messages.push(message);
		}
	});
	const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});

	return {
		socket,
		send(message) {
			socket.send(encodeMessage(message));
		},
		next() {
			const message = messages.shift();
			if (message) {
				return Promise.resolve(message);
			}
			return new Promise((resolve) => waiters.push(resolve));
		},
		closed,
	};
}

async function joinGroupChat(peer: Peer, sessionId: string): Promise<void> {
	peer.send({ id: `join-${sessionId}`, type: "join_group_chat", session_id: sessionId });
	await peer.next();
}

async function claim(peer: Peer, id: string, characterId: string): Promise<void> {
	peer.send({ id, type: "claim_character", character_id: characterId });
	await peer.next();
}

async function connectAndReady(runtime: CreatorRuntime, sessionId: string, characterId: string): Promise<Peer> {
	const peer = await connectPeer(runtime);
	await joinGroupChat(peer, sessionId);
	await claim(peer, `claim-${sessionId}`, characterId);
	peer.send({ id: `ready-${sessionId}`, type: "character_ready" });
	await peer.next();
	await peer.next();
	await peer.next();
	return peer;
}

function toSummaryMessage(character: CharacterCard) {
	return {
		character_id: character.characterId,
		name: character.name,
		description: character.description,
	};
}
