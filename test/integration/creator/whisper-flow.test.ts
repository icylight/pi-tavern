import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { loadCharacterCard } from "../../../src/config/character-card.js";
import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";

/**
 * #152：whisper（Character 间私信）管线集成钉测——WH2 目标校验 / WH3 共用
 * 递增器无空洞 / WH4 三视角投影不泄露正文 / WH5 额度与失败 / WH6 占位未读。
 * 测试属主=Arch（integration 域），编写=后端（#154 先例同款分工）。
 */

const temporaryDirectories: string[] = [];
const runtimes: CreatorRuntime[] = [];
const sockets: WebSocket[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-whisper-"));
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
			if (expectedType === "response" ? "result" in message || "error" in message : message.method === expectedType) {
				clearTimeout(timeout);
				socket.off("message", onMessage);
				resolve(message);
			}
		};
		socket.on("message", onMessage);
	});
}

async function startRuntime(characterIds: string[], roundMaxMessages = 10): Promise<CreatorRuntime> {
	const root = await createTemporaryDirectory();
	const configPath = join(root, "tavern.json");
	const characters = [];
	for (const characterId of characterIds) {
		const characterPath = join(root, "characters", `${characterId}.md`);
		await mkdir(join(root, "characters"), { recursive: true });
		await writeFile(
			characterPath,
			`---\nname: ${characterId}\ndescription: ${characterId} card\n---\n${characterId} prompt`,
		);
		characters.push(await loadCharacterCard(characterPath, configPath));
	}
	const runtime = await CreatorRuntime.startNew({
		cwd: join(root, "project"),
		agentDir: join(root, "agent"),
		characters,
	});
	runtimes.push(runtime);
	await runtime.setMaxMessages(roundMaxMessages);
	await runtime.submitUserPersonaMessage("First");
	return runtime;
}

async function joinCharacter(runtime: CreatorRuntime, sessionId: string, characterId: string): Promise<WebSocket> {
	const client = new WebSocket(
		`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
	);
	sockets.push(client);
	await waitForOpen(client);
	client.send(
		JSON.stringify({ jsonrpc: "2.0", id: "1", method: "join_group_chat", params: { session_id: sessionId } }),
	);
	await waitForMessage(client, "response");
	client.send(
		JSON.stringify({
			jsonrpc: "2.0",
			id: "2",
			method: "claim_character",
			params: { character_id: `characters/${characterId}.md` },
		}),
	);
	await waitForMessage(client, "response");
	client.send(JSON.stringify({ jsonrpc: "2.0", id: "3", method: "character_ready" }));
	await waitForMessage(client, "response");
	return client;
}

describe("WH5: whisper success path — singlecast to recipient, placeholder to bystanders, zero events to sender", () => {
	it("delivers full frame to the recipient and placeholder to a bystander", async () => {
		const runtime = await startRuntime(["alice", "bob", "carol"]);
		const alice = await joinCharacter(runtime, "session-alice", "alice");
		const bob = await joinCharacter(runtime, "session-bob", "bob");
		const carol = await joinCharacter(runtime, "session-carol", "carol");

		// alice → bob：alice 收到成功响应（result.sequence），bob 收到完整帧，carol 收到占位帧。
		const receivedByBob = waitForMessage(bob, "whisper_message");
		const receivedByCarol = waitForMessage(carol, "whisper_placeholder");
		alice.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id: "w1",
				method: "whisper",
				params: { character_id: "characters/bob.md", content: "psst, secret plan" },
			}),
		);

		const response = await waitForMessage(alice, "response");
		expect(response).toMatchObject({
			id: "w1",
			result: { sequence: 2 },
		});

		const full = await receivedByBob;
		expect(full).toMatchObject({
			method: "whisper_message",
			params: {
				sequence: 2,
				sender: { type: "character", character_id: "characters/alice.md" },
				recipient: { type: "character", character_id: "characters/bob.md" },
				content: "psst, secret plan",
			},
		});

		const placeholder = await receivedByCarol;
		expect(placeholder).toMatchObject({
			method: "whisper_placeholder",
			params: {
				sequence: 2,
				sender: { type: "character", character_id: "characters/alice.md" },
				recipient: { type: "character", character_id: "characters/bob.md" },
			},
		});
		// 占位帧无正文、无 round（客户端「无 round 帧」约定）。
		expect(placeholder.params).not.toHaveProperty("content");
		expect(placeholder.params).not.toHaveProperty("round");
	});

	it("does not deliver any event to the sender", async () => {
		const runtime = await startRuntime(["alice", "bob"]);
		const alice = await joinCharacter(runtime, "session-alice", "alice");
		await joinCharacter(runtime, "session-bob", "bob");

		const unexpected: string[] = [];
		alice.on("message", (data) => {
			const message = JSON.parse(data.toString()) as Record<string, unknown>;
			if (message.method === "whisper_message" || message.method === "whisper_placeholder") {
				unexpected.push(message.method);
			}
		});

		alice.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id: "w1",
				method: "whisper",
				params: { character_id: "characters/bob.md", content: "hello bob" },
			}),
		);
		await waitForMessage(alice, "response");

		// 给投递一个时间窗：发送者不应收到任何 whisper 事件。
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(unexpected).toEqual([]);
	});
});

describe("WH3: shared sequence — no gaps across speak and whisper", () => {
	it("assigns contiguous sequences interleaving speak and whisper", async () => {
		const runtime = await startRuntime(["alice", "bob"]);
		const alice = await joinCharacter(runtime, "session-alice", "alice");
		const bob = await joinCharacter(runtime, "session-bob", "bob");

		alice.send(JSON.stringify({ jsonrpc: "2.0", id: "s1", method: "speak", params: { content: "public one" } }));
		const speakResponse = await waitForMessage(alice, "response");
		expect(speakResponse).toMatchObject({ id: "s1", result: { published: true, sequence: 2 } });

		const receivedByBob = waitForMessage(bob, "whisper_message");
		alice.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id: "w1",
				method: "whisper",
				params: { character_id: "characters/bob.md", content: "private one" },
			}),
		);
		const whisperResponse = await waitForMessage(alice, "response");
		expect(whisperResponse).toMatchObject({ id: "w1", result: { sequence: 3 } });
		await receivedByBob;

		// 无空洞：1 = User Persona 首条，2 = speak，3 = whisper。
		expect(runtime.state.nextSequence).toBe(3);
	});
});

describe("WH2: target validation — offline and self reject without consuming quota", () => {
	it("rejects an offline target with WHISPER_TARGET_OFFLINE without consuming quota", async () => {
		const runtime = await startRuntime(["alice", "bob"]);
		const alice = await joinCharacter(runtime, "session-alice", "alice");
		// bob 未 join（离线）。

		alice.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id: "w1",
				method: "whisper",
				params: { character_id: "characters/bob.md", content: "are you there" },
			}),
		);
		const response = await waitForMessage(alice, "response");
		expect(response).toMatchObject({
			id: "w1",
			error: { code: -32110 },
		});
		// 拒绝不占额度：后续 speak 仍可发布。
		expect(runtime.state.round?.usedMessages).toBe(0);
	});

	it("rejects self-whisper with WHISPER_SELF", async () => {
		const runtime = await startRuntime(["alice"]);
		const alice = await joinCharacter(runtime, "session-alice", "alice");

		alice.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id: "w1",
				method: "whisper",
				params: { character_id: "characters/alice.md", content: "to myself" },
			}),
		);
		const response = await waitForMessage(alice, "response");
		expect(response).toMatchObject({
			id: "w1",
			error: { code: -32111 },
		});
	});
});

describe("WH5: shared quota pool — whisper consumes the same round quota as speak", () => {
	it("rejects whisper with round_limit_reached when the pool is exhausted by speak", async () => {
		const runtime = await startRuntime(["alice", "bob"], 1);
		const alice = await joinCharacter(runtime, "session-alice", "alice");
		await joinCharacter(runtime, "session-bob", "bob");

		alice.send(JSON.stringify({ jsonrpc: "2.0", id: "s1", method: "speak", params: { content: "using the pool" } }));
		await waitForMessage(alice, "response");

		alice.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id: "w1",
				method: "whisper",
				params: { character_id: "characters/bob.md", content: "over quota" },
			}),
		);
		const response = await waitForMessage(alice, "response");
		expect(response).toMatchObject({
			id: "w1",
			result: { published: false, reason: "round_limit_reached", hand_raised: true },
		});
	});
});

describe("WH4: history projection — full frame for participant, placeholder for bystander", () => {
	it("projects whisper frames per requester character_id in fetch_messages_since", async () => {
		const runtime = await startRuntime(["alice", "bob", "carol"]);
		const alice = await joinCharacter(runtime, "session-alice", "alice");
		const bob = await joinCharacter(runtime, "session-bob", "bob");
		const carol = await joinCharacter(runtime, "session-carol", "carol");

		const receivedByBob = waitForMessage(bob, "whisper_message");
		alice.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id: "w1",
				method: "whisper",
				params: { character_id: "characters/bob.md", content: "secret content here" },
			}),
		);
		await waitForMessage(alice, "response");
		await receivedByBob;

		// bob（接收者）历史拉取 → 完整帧（含正文）。
		bob.send(
			JSON.stringify({ jsonrpc: "2.0", id: "h1", method: "fetch_messages_since", params: { since_sequence: 0 } }),
		);
		const bobHistory = await waitForMessage(bob, "response");
		const bobMessages = (bobHistory.result as { messages: Record<string, unknown>[] }).messages;
		const bobWhisper = bobMessages.find((m) => m.method === "whisper_message");
		expect(bobWhisper).toMatchObject({
			params: { content: "secret content here", recipient: { character_id: "characters/bob.md" } },
		});

		// carol（旁观者）历史拉取 → 占位帧（无正文）。
		carol.send(
			JSON.stringify({ jsonrpc: "2.0", id: "h2", method: "fetch_messages_since", params: { since_sequence: 0 } }),
		);
		const carolHistory = await waitForMessage(carol, "response");
		const carolMessages = (carolHistory.result as { messages: Record<string, unknown>[] }).messages;
		const carolWhisper = carolMessages.find((m) => m.method === "whisper_placeholder");
		expect(carolWhisper).toMatchObject({
			params: { sender: { character_id: "characters/alice.md" }, recipient: { character_id: "characters/bob.md" } },
		});
		expect(carolWhisper?.params).not.toHaveProperty("content");
	});
});
