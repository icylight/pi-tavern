import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import type { CharacterCard } from "../../../src/config/character-card.js";
import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";
import { decodeServerMessage, encodeMessage } from "../../../src/protocol/codec.js";
import { DEFAULT_WELCOME_MESSAGE } from "../../../src/shared/constants.js";

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
	it("#123 WL1/WL2 红钉：ready 后收 1 条 system_message 且不再自动推 message_history", async () => {
		// 与 #123 指定默认文案一致（DEFAULT_WELCOME_MESSAGE 待实现落定后引用）。
		const WELCOME = DEFAULT_WELCOME_MESSAGE;

		const runtime = await startRuntime();
		const peer = await connectPeer(runtime);

		peer.send({
			jsonrpc: "2.0",
			id: "join",
			method: "join_group_chat",
			params: { session_id: "session-1" },
		});
		expect(await peer.next()).toEqual({
			jsonrpc: "2.0",
			id: "join",
			result: {
				available_characters: characters.map(toSummaryMessage),
			},
		});

		peer.send({
			jsonrpc: "2.0",
			id: "claim",
			method: "claim_character",
			params: { character_id: characters[0]?.characterId },
		});
		expect(await peer.next()).toEqual({
			jsonrpc: "2.0",
			id: "claim",
			result: {
				character: {
					...toSummaryMessage(characters[0] as CharacterCard),
					path: characters[0]?.path,
				},
			},
		});

		// ready 后帧序：响应 → system_message 单播 → character_joined 广播。
		peer.send({ jsonrpc: "2.0", id: "ready", method: "character_ready" });
		expect(await peer.next()).toEqual({
			jsonrpc: "2.0",
			id: "ready",
			// P1-4 方案 a：ready 携带进入时刻水位 latest_sequence（契约流程 WL1 帧序钉更新）。
			result: { latest_sequence: 0 },
		});
		expect(await peer.next()).toEqual({
			jsonrpc: "2.0",
			method: "system_message",
			params: { content: WELCOME },
		});
		expect(await peer.next()).toEqual({
			jsonrpc: "2.0",
			method: "character_joined",
			params: { character: toSummaryMessage(characters[0] as CharacterCard) },
		});

		expect(runtime.state.onlineCharacters.get("session-1")).toMatchObject({
			sessionId: "session-1",
			character: {
				characterId: characters[0]?.characterId,
				name: "Architect",
			},
		});
	});

	it("keeps a Character pending until ready, then exposes state and broadcasts", async () => {
		const runtime = await startRuntime();
		const peer = await connectPeer(runtime);

		peer.send({
			jsonrpc: "2.0",
			id: "join",
			method: "join_group_chat",
			params: { session_id: "session-1" },
		});
		expect(await peer.next()).toEqual({
			jsonrpc: "2.0",
			id: "join",
			result: {
				available_characters: characters.map(toSummaryMessage),
			},
		});
		expect(runtime.state.onlineCharacters.size).toBe(0);

		peer.send({
			jsonrpc: "2.0",
			id: "claim",
			method: "claim_character",
			params: { character_id: characters[0]?.characterId },
		});
		expect(await peer.next()).toEqual({
			jsonrpc: "2.0",
			id: "claim",
			result: {
				character: {
					...toSummaryMessage(characters[0] as CharacterCard),
					path: characters[0]?.path,
				},
			},
		});
		expect(runtime.state.characterReservations.get(characters[0]?.characterId as string)).toBe("session-1");
		expect(runtime.state.onlineCharacters.size).toBe(0);

		peer.send({ jsonrpc: "2.0", id: "ready", method: "character_ready" });
		expect(await peer.next()).toEqual({
			jsonrpc: "2.0",
			id: "ready",
			// P1-4 方案 a：ready 携带进入时刻水位 latest_sequence（契约流程 WL1 帧序钉更新）。
			result: { latest_sequence: 0 },
		});
		// #123：ready 后不再自动推 message_history，改发 system_message 欢迎单播。
		expect(await peer.next()).toEqual({
			jsonrpc: "2.0",
			method: "system_message",
			params: {
				content: DEFAULT_WELCOME_MESSAGE,
			},
		});
		expect(await peer.next()).toEqual({
			jsonrpc: "2.0",
			method: "character_joined",
			params: { character: toSummaryMessage(characters[0] as CharacterCard) },
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

		peer.send({ jsonrpc: "2.0", id: "state", method: "get_group_chat_state" });
		expect(await peer.next()).toMatchObject({
			jsonrpc: "2.0",
			id: "state",
			result: {
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

		peer.send({ jsonrpc: "2.0", method: "update_character_state", params: { is_streaming: true } });
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
			jsonrpc: "2.0",
			id: "claim-2",
			method: "claim_character",
			params: { character_id: characters[0]?.characterId },
		});
		expect(await second.next()).toEqual({
			jsonrpc: "2.0",
			id: "claim-2",
			error: { code: -32103, message: "Character is no longer available" },
		});

		first.send({ jsonrpc: "2.0", id: "ready", method: "character_ready" });
		await first.next();
		await first.next();
		await first.next();
		second.send({
			jsonrpc: "2.0",
			id: "refresh",
			method: "join_group_chat",
			params: { session_id: "session-2" },
		});
		expect(await second.next()).toMatchObject({
			result: {
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
		// 第二个角色加入只广播 character_joined；group_chat_update 已收窄为
		// 公共消息水位通知。
		expect(await first.next()).toMatchObject({ method: "character_joined" });

		first.send({ jsonrpc: "2.0", id: "leave", method: "leave_group_chat" });
		expect(await second.next()).toEqual({
			jsonrpc: "2.0",
			method: "character_left",
			params: {
				character: toSummaryMessage(characters[0] as CharacterCard),
				reason: "left",
			},
		});
		second.send({ jsonrpc: "2.0", id: "state-after-leave", method: "get_group_chat_state" });
		expect(await second.next()).toMatchObject({
			jsonrpc: "2.0",
			id: "state-after-leave",
			result: {
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
			jsonrpc: "2.0",
			id: "leave",
			result: null,
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

		first.send({ jsonrpc: "2.0", id: "ready-1", method: "character_ready" });
		await first.next();
		await first.next();
		await first.next();
		const firstOwnedConnection = runtime.connections.get("same-session");
		second.send({ jsonrpc: "2.0", id: "ready-2", method: "character_ready" });
		expect(await second.next()).toEqual({
			jsonrpc: "2.0",
			id: "ready-2",
			error: { code: -32101, message: "This pi session is already in the group chat" },
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
	peer.send({
		jsonrpc: "2.0",
		id: `join-${sessionId}`,
		method: "join_group_chat",
		params: { session_id: sessionId },
	});
	await peer.next();
}

async function claim(peer: Peer, id: string, characterId: string): Promise<void> {
	peer.send({ jsonrpc: "2.0", id, method: "claim_character", params: { character_id: characterId } });
	await peer.next();
}

async function connectAndReady(runtime: CreatorRuntime, sessionId: string, characterId: string): Promise<Peer> {
	const peer = await connectPeer(runtime);
	await joinGroupChat(peer, sessionId);
	await claim(peer, `claim-${sessionId}`, characterId);
	peer.send({ jsonrpc: "2.0", id: `ready-${sessionId}`, method: "character_ready" });
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
