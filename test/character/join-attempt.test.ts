import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
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
});

async function startCreator(): Promise<{
	creator: CreatorRuntime;
	character: CharacterCard;
}> {
	const root = await createTemporaryDirectory();
	const characterPath = join(root, "characters", "architect.md");
	const configPath = join(root, "tavern.json");
	await mkdir(join(root, "characters"), { recursive: true });
	await writeFile(characterPath, "---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt");
	const character = await loadCharacterCard(characterPath, configPath);
	const creator = await CreatorRuntime.startNew({
		cwd: join(root, "project"),
		agentDir: join(root, "agent"),
		characters: [character],
	});
	creatorRuntimes.push(creator);
	return { creator, character };
}
