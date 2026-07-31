import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { CharacterRuntime } from "../../src/character/character-runtime.js";
import { JoinAttempt } from "../../src/character/join-attempt.js";
import { type CharacterCard, loadCharacterCard } from "../../src/config/character-card.js";
import { CreatorRuntime } from "../../src/creator/creator-runtime.js";
import type { ActiveGroupChatDescriptor } from "../../src/discovery/active-descriptor.js";

const temporaryDirectories: string[] = [];
const creatorRuntimes: CreatorRuntime[] = [];
const servers: WebSocketServer[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-attempt-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(creatorRuntimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					for (const socket of server.clients) {
						socket.terminate();
					}
					server.close(() => resolve());
				}),
		),
	);
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JoinAttempt and CharacterRuntime", () => {
	it("claims a Character, transfers one connection, and uses online state requests", async () => {
		const { creator, character } = await startCreator();
		const disconnected = vi.fn();
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1", { onDisconnected: disconnected });

		expect(attempt.availableCharacters).toEqual([
			{
				character_id: character.characterId,
				name: character.name,
				description: character.description,
			},
		]);

		const runtime = await attempt.claimCharacter(character.characterId);
		expect(runtime.character).toEqual(character);
		expect(creator.state.onlineCharacters.get("session-1")?.character.name).toBe("Architect");
		expect(() => attempt.takeConnection()).toThrow(/already transferred/i);

		await expect(runtime.getGroupChatState()).resolves.toMatchObject({
			online_characters: [
				{
					character_id: character.characterId,
					is_self: true,
				},
			],
		});
		runtime.updateStreaming(true);
		await vi.waitFor(() => expect(creator.state.onlineCharacters.get("session-1")?.isStreaming).toBe(true));

		await runtime.close();
		await vi.waitFor(() => expect(creator.state.onlineCharacters.has("session-1")).toBe(false));
		expect(disconnected).toHaveBeenCalledTimes(1);
	});

	it("closes the pending connection when the claimed file no longer matches", async () => {
		const { creator, character } = await startCreator();
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1");
		await writeFile(character.path, "---\nname: Changed\ndescription: Architecture\n---\nChanged prompt");

		await expect(attempt.claimCharacter(character.characterId)).rejects.toThrow(/no longer matches/i);
		await vi.waitFor(() => expect(creator.state.characterReservations.size).toBe(0));
		expect(creator.state.onlineCharacters.size).toBe(0);
	});

	it("times out a silent join server and closes its socket", async () => {
		const root = await createTemporaryDirectory();
		const server = new WebSocketServer({
			host: "127.0.0.1",
			port: 0,
			path: "/group-1/instance-1",
		});
		servers.push(server);
		await new Promise<void>((resolve, reject) => {
			server.once("listening", resolve);
			server.once("error", reject);
		});
		const descriptor: ActiveGroupChatDescriptor = {
			instanceId: "instance-1",
			groupChatId: "group-1",
			name: null,
			cwd: root,
			pid: process.pid,
			host: "127.0.0.1",
			port: (server.address() as AddressInfo).port,
			startedAt: "2026-07-27T00:00:00.000Z",
		};

		await expect(JoinAttempt.connect(descriptor, "session-1", { requestTimeoutMs: 30 })).rejects.toThrow(/timed out/i);
		await vi.waitFor(() => expect(server.clients.size).toBe(0));
	});

	it("observes group closure once on the transferred Character connection", async () => {
		const { creator, character } = await startCreator();
		const disconnected = vi.fn();
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1", { onDisconnected: disconnected });
		const runtime = await attempt.claimCharacter(character.characterId);

		await creator.close();

		await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1));
		expect(runtime.receivedMessages).toContainEqual({
			type: "group_chat_closed",
			group_chat_id: creator.state.groupChat.groupChatId,
		});
	});

	it("does not treat heartbeat frames as environment messages", async () => {
		const { creator, character } = await startCreator({ heartbeatIntervalMs: 30, heartbeatTimeoutMs: 120 });
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1");
		const runtime = await attempt.claimCharacter(character.characterId);
		const messageCountAfterJoin = runtime.receivedMessages.length;

		// Several ping/pong cycles happen without any new environment message.
		await new Promise((resolve) => setTimeout(resolve, 250));

		expect(runtime.receivedMessages.length).toBe(messageCountAfterJoin);
	});

	it("terminates the connection when the creator stops sending heartbeats", async () => {
		const { creator, character } = await startCreator({
			// Creator never pings within the test window.
			heartbeatIntervalMs: 60_000,
			heartbeatTimeoutMs: 60_000,
		});
		const disconnected = vi.fn();
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1", {
			onDisconnected: disconnected,
			heartbeatIntervalMs: 30,
			heartbeatTimeoutMs: 120,
		});
		await attempt.claimCharacter(character.characterId);

		// The Character actively terminates the half-open connection.
		await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1), { timeout: 2000 });
		expect(creator.state.onlineCharacters.has("session-1")).toBe(false);
	});

	it("detaches for reload and takes over with the same live connection (BC-8)", async () => {
		const { creator, character } = await startCreator({ heartbeatIntervalMs: 30, heartbeatTimeoutMs: 120 });
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1");
		const runtime = await attempt.claimCharacter(character.characterId);

		const handoff = await runtime.detachForReload("session-1");
		expect(handoff.kind).toBe("character");
		expect(handoff.groupChatId).toBe(creator.state.groupChat.groupChatId);

		// The same connection stays alive across the reload window.
		expect(handoff.socket.readyState).toBe(WebSocket.OPEN);

		// The creator still considers the member online.
		expect(creator.state.onlineCharacters.has("session-1")).toBe(true);

		// A reload-window frame (creator broadcast) is buffered.
		await creator.submitUserPersonaMessage("Hello during reload");
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(handoff.bufferedFrames.length).toBeGreaterThan(0);

		const taken = await CharacterRuntime.takeHandoff(handoff);
		expect(taken.groupChatId).toBe(runtime.groupChatId);
		expect(taken.character.characterId).toBe(character.characterId);

		// The buffered broadcast was replayed into the new runtime.
		expect(taken.receivedMessages.some((m) => m.type === "public_message" && m.content === "Hello during reload")).toBe(
			true,
		);

		// The new runtime serves the same live connection: further broadcasts arrive.
		await creator.submitUserPersonaMessage("Hello after reload");
		await vi.waitFor(() =>
			expect(
				taken.receivedMessages.some((m) => m.type === "public_message" && m.content === "Hello after reload"),
			).toBe(true),
		);

		await taken.close();
	});
});

async function startCreator(
	creatorOverrides: Partial<import("../../src/creator/creator-runtime.js").CreatorRuntimeDependencies> = {},
): Promise<{
	creator: CreatorRuntime;
	character: CharacterCard;
}> {
	const root = await createTemporaryDirectory();
	const characterPath = join(root, "characters", "architect.md");
	const configPath = join(root, "tavern.json");
	await mkdir(join(root, "characters"), { recursive: true });
	await writeFile(characterPath, "---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt");
	const character = await loadCharacterCard(characterPath, configPath);
	const creator = await CreatorRuntime.startNew(
		{
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [character],
		},
		creatorOverrides,
	);
	creatorRuntimes.push(creator);
	return { creator, character };
}
