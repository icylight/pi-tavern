import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { loadCharacterCard } from "../../../src/config/character-card.js";
import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";

/**
 * A5（验收清单 #20-A5）：hand_raised 真值流转——round-limit 拒绝后自动举手。
 *
 * 场景对应 User 实证（#20）：发言配额用尽举手后 TUI 无显示。
 * 协议无独立举手消息（websocket-protocol.md:640：hand_raised 由 creator
 * 按规则维护）；现有规则 = round-limit 拒绝时自动置位
 * （creator-runtime setHandRaised(true)）。本测试锁定真值层：
 * 拒绝响应 + 运行时状态 + 状态快照三处 hand_raised=true。
 */

const temporaryDirectories: string[] = [];
const runtimes: CreatorRuntime[] = [];
const sockets: WebSocket[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-a5-"));
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

function waitForOpen(socket: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.once("open", () => resolve());
		socket.once("error", (error) => reject(error));
	});
}

function waitForMessage(socket: WebSocket, expectedType: string): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expectedType}`)), 5000);
		const onMessage = (data: WebSocket.RawData) => {
			const message = JSON.parse(data.toString()) as Record<string, unknown>;
			if (message.type === expectedType) {
				clearTimeout(timeout);
				socket.off("message", onMessage);
				resolve(message);
			}
		};
		socket.on("message", onMessage);
	});
}

async function startRuntime(roundMaxMessages: number): Promise<CreatorRuntime> {
	const root = await createTemporaryDirectory();
	const characterPath = join(root, "characters", "dev.md");
	const configPath = join(root, "tavern.json");
	await mkdir(join(root, "characters"), { recursive: true });
	await writeFile(characterPath, "---\nname: Developer\ndescription: Writes code\n---\nDeveloper prompt");
	const character = await loadCharacterCard(characterPath, configPath);
	const runtime = await CreatorRuntime.startNew({
		cwd: join(root, "project"),
		agentDir: join(root, "agent"),
		characters: [character],
	});
	runtimes.push(runtime);
	// Create the first round with the intended quota: setMaxMessages applies
	// to the NEXT round (current round unaffected), so set before the first
	// User Persona message.
	await runtime.setMaxMessages(roundMaxMessages);
	await runtime.submitUserPersonaMessage("First");
	return runtime;
}

async function joinCharacter(runtime: CreatorRuntime, sessionId: string): Promise<WebSocket> {
	const client = new WebSocket(
		`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
	);
	sockets.push(client);
	await waitForOpen(client);
	client.send(JSON.stringify({ id: "1", type: "join_group_chat", session_id: sessionId }));
	await waitForMessage(client, "response");
	client.send(JSON.stringify({ id: "2", type: "claim_character", character_id: "characters/dev.md" }));
	await waitForMessage(client, "response");
	client.send(JSON.stringify({ id: "3", type: "character_ready" }));
	await waitForMessage(client, "response");
	return client;
}

describe("A5: hand_raised truth flow on round-limit refusal", () => {
	it("raises the hand on round-limit refusal: refusal response, runtime state, and snapshot agree", async () => {
		const runtime = await startRuntime(1);
		const client = await joinCharacter(runtime, "session-1");

		// First speak fits the quota (round max = 1).
		client.send(JSON.stringify({ id: "s1", type: "speak", content: "first" }));
		const first = await waitForMessage(client, "response");
		expect(first).toMatchObject({
			id: "s1",
			command: "speak",
			success: true,
			data: { published: true },
		});

		// Second speak exceeds the quota → round_limit_reached refusal with
		// hand raised (User-observed #20 chain: 配额用尽 → 自动举手).
		client.send(JSON.stringify({ id: "s2", type: "speak", content: "second" }));
		const refusal = await waitForMessage(client, "response");
		expect(refusal).toMatchObject({
			id: "s2",
			command: "speak",
			success: true,
			data: {
				published: false,
				reason: "round_limit_reached",
				hand_raised: true,
				round: {
					round_max_messages: 1,
					used_messages: 1,
					remaining_messages: 0,
				},
			},
		});

		// Runtime state: the character's hand is up.
		expect(runtime.state.onlineCharacters.get("session-1")?.handRaised).toBe(true);

		// Snapshot truth: get_group_chat_state reports hand_raised=true.
		client.send(JSON.stringify({ id: "state", type: "get_group_chat_state" }));
		const snapshot = await waitForMessage(client, "response");
		expect(snapshot).toMatchObject({
			id: "state",
			command: "get_group_chat_state",
			success: true,
			data: {
				online_characters: [
					{
						character_id: "characters/dev.md",
						is_self: true,
						hand_raised: true,
					},
				],
			},
		});
	});

	it("clears the hand on the next round (new User Persona message)", async () => {
		const runtime = await startRuntime(1);
		const client = await joinCharacter(runtime, "session-1");

		client.send(JSON.stringify({ id: "s1", type: "speak", content: "first" }));
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ id: "s2", type: "speak", content: "second" }));
		await waitForMessage(client, "response");
		expect(runtime.state.onlineCharacters.get("session-1")?.handRaised).toBe(true);

		// A new User Persona message opens a fresh round and clears hands
		// (creator-runtime round reset semantics).
		await runtime.submitUserPersonaMessage("Second");
		expect(runtime.state.onlineCharacters.get("session-1")?.handRaised).toBe(false);
		expect(runtime.state.round?.usedMessages).toBe(0);
	});
});
