import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";

// #85 J3 钉测（QA，2026-08-03）：WS 半开 60s+（延迟/恢复一致性）回归。
// 场景：连接不响应心跳 → 统一 disconnected 清理（其他成员见 character_left）
// → 同 session 重连 → 历史无遗漏恢复（含半开期间消息）+ 重连后投递恢复 + 无重复。
// 定位：半开恢复一致性回归钉（现有心跳用例只钉「清理」，本钉补「恢复」面）。
// 绿 = 现有实现钉住；红基线 = 重连丢历史/恢复后重复投递。

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-j3-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function waitForOpen(socket: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.once("open", () => resolve());
		socket.once("error", (error) => reject(error));
	});
}

function waitForMessage(socket: WebSocket, expectedType: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expectedType}`)), timeoutMs);
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

async function joinCharacter(
	runtime: CreatorRuntime,
	sessionId: string,
	characterId: string,
	options: { autoPong?: boolean } = {},
): Promise<{ client: WebSocket; messageHistory: Record<string, unknown> }> {
	const client = new WebSocket(
		`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		{ autoPong: options.autoPong ?? true },
	);
	await waitForOpen(client);
	client.send(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "join_group_chat", params: { session_id: sessionId } }));
	await waitForMessage(client, "response");
	client.send(JSON.stringify({ jsonrpc: "2.0", id: "2", method: "claim_character", params: { character_id: characterId } }));
	await waitForMessage(client, "response");
	client.send(JSON.stringify({ jsonrpc: "2.0", id: "3", method: "character_ready" }));
	const historyPromise = waitForMessage(client, "message_history");
	await waitForMessage(client, "response");
	const messageHistory = await historyPromise;
	return { client, messageHistory };
}

function historySequences(messageHistory: Record<string, unknown>): number[] {
	const messages = ((messageHistory.params as Record<string, unknown>).messages as Array<{
		params?: { sequence?: number };
	}>) ?? [];
	return messages.map((m) => m.params?.sequence ?? -1);
}

describe("CreatorRuntime #85 J3 半开断连恢复一致性", () => {
	it("J3: 半开清理后同 session 重连——历史无遗漏（含半开期间消息）+ 投递恢复 + 无重复", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew(
			{
				cwd: join(root, "project"),
				agentDir: join(root, "agent"),
				characters: [
					{ characterId: "dev", name: "Dev", description: "", path: "/x.md", prompt: "" },
					{ characterId: "qa", name: "QA", description: "", path: "/y.md", prompt: "" },
				],
			},
			{ heartbeatIntervalMs: 30, heartbeatTimeoutMs: 120 },
		);

		// ① 双成员：healthy 正常心跳；j3 半开（不响应 pong）。
		const { client: healthy } = await joinCharacter(runtime, "session-healthy", "dev", { autoPong: true });
		const { client: deadClient } = await joinCharacter(runtime, "session-j3", "qa", { autoPong: false });

		// ② 半开清理：healthy 收到 character_left（disconnected）→ j3 移出在线表。
		const left = await waitForMessage(healthy, "character_left", 5000);
		expect((left.params as Record<string, unknown>).reason).toBe("disconnected");
		expect(runtime.state.onlineCharacters.has("session-j3")).toBe(false);
		expect(runtime.connections.has("session-j3")).toBe(false);
		deadClient.terminate();

		// ③ 半开期间群聊消息照常记录（广播无 j3 接收者，仅历史可恢复）。
		runtime.submitUserPersonaMessage("during-half-open-1");
		runtime.submitUserPersonaMessage("during-half-open-2");

		// ④ 同 session 重连（恢复）：message_history 完整——半开期间 2 条无遗漏。
		const { client: revived, messageHistory } = await joinCharacter(runtime, "session-j3", "qa", { autoPong: true });
		// 半开期间 2 条全部进入历史——恢复无遗漏。
		expect(historySequences(messageHistory)).toEqual([1, 2]);
		expect(runtime.state.onlineCharacters.has("session-j3")).toBe(true);

		// ⑤ 重连后投递恢复：新消息正常广播到达（sequence 3 在预览中）。
		// 注：preview = 最近 3 条（含历史），重投控制属 character 侧游标拉取语义
		// （M7 A3/A4 已钉），creator 侧只验证广播恢复。
		runtime.submitUserPersonaMessage("after-reconnect");
		const update = await waitForMessage(revived, "group_chat_update", 5000);
		const preview = (
			(update.params as Record<string, unknown>).preview_messages as Array<{ params?: { sequence?: number } }>
		) ?? [];
		expect(preview.map((m) => m.params?.sequence)).toContain(3);

		healthy.close();
		revived.close();
		await runtime.close();
	});
});
