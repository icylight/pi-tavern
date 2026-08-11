import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";

//  复现测试 ①（PM 领办）： 懒重扫 = join/claim/query 热路径唯一新增阻塞点
// （await 磁盘重扫、无超时保护）。本测试注入「永不 resolve 的 loadCharacters」，
// 断言 join_group_chat 仍应在时限内响应——f2ac85f（含 ）预期红（join 被挂起
// 的重扫无限阻塞 = 缺陷证实）；d5aa913（无 ）预期绿（无阻塞点）。
const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-join-blocked-"));
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

describe("CreatorRuntime  join 阻塞复现（懒重扫无超时）", () => {
	it("loadCharacters 挂起时 join_group_chat 仍应在 2s 内响应（结构性缺陷钉死）", async () => {
		const root = await createTemporaryDirectory();
		// 可控挂起的 loadCharacters（deferred，永不自行 resolve）
		let release: (() => void) | undefined;
		const blocked = new Promise<void>((resolveBlocked) => {
			release = resolveBlocked;
		});
		expect(release).toBeDefined();

		const runtime = await CreatorRuntime.startNew(
			{ cwd: join(root, "project"), agentDir: join(root, "agent") },
			//  懒重扫注入面：挂起的重扫 = 磁盘重扫 hang 的极端形态
			{ loadCharacters: () => blocked.then(() => []) },
		);

		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "join_group_chat", params: { session_id: "s1" } }));

		// 断言：挂起的重扫不得阻塞 join 响应（2s 窗口）
		await expect(waitForMessage(client, "response", 2000)).resolves.toMatchObject({ id: "1" });

		// 清理：释放挂起重扫，关闭
		release?.();
		client.close();
		await runtime.close();
	});
});
