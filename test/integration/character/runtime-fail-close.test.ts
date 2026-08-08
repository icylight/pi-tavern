import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";

import { JoinAttempt } from "../../../src/character/join-attempt.js";
import type { ActiveGroupChatDescriptor } from "../../../src/data/discovery/active-descriptor.js";

const temporaryDirectories: string[] = [];
const servers: WebSocketServer[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-failclose-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/**
 * #139 错误帧 fail-close 钉（QA 属主，假服务器 = 真实 WS 发送路径）：
 * character runtime 收到非法帧 → failConnection 断线（不静默吞、不悬挂 pending）。
 *
 * 锚定现有行为（handleIncomingData：二进制帧 / codec 拒帧 → failConnection；
 * L230-237 路径不经 response-gate）——#139 方案 B 清理后同批回归锚，行为零变化。
 */
describe("#139 错误帧 fail-close（character runtime 侧，假服务器注入）", () => {
	/**
	 * 假 creator：按 method 回合法 result（id echo，join/claim/ready 协议帧），
	 * 并暴露对 runtime socket 的注入通道。
	 */
	async function startFakeCreator(): Promise<{
		descriptor: ActiveGroupChatDescriptor;
		characterPath: string;
		inject: (data: WebSocket.RawData) => void;
	}> {
		const root = await createTemporaryDirectory();
		const characterPath = join(root, "characters", "qa.md");
		await mkdir(join(root, "characters"), { recursive: true });
		await writeFile(characterPath, "---\nname: QA\ndescription: QA\n---\nQA prompt");

		const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		servers.push(server);
		await new Promise<void>((resolve, reject) => {
			server.once("listening", resolve);
			server.once("error", reject);
		});
		const descriptor: ActiveGroupChatDescriptor = {
			instanceId: "instance-fc",
			groupChatId: "group-fc",
			name: null,
			cwd: root,
			pid: process.pid,
			host: "127.0.0.1",
			port: (server.address() as AddressInfo).port,
			startedAt: "2026-07-27T00:00:00.000Z",
		};

		let served: WebSocket | null = null;
		server.on("connection", (socket) => {
			served = socket;
			socket.on("message", (data) => {
				let frame: { id?: string | number; method?: string };
				try {
					frame = JSON.parse(String(data)) as { id?: string | number; method?: string };
				} catch {
					return;
				}
				const id = frame.id;
				if (id === undefined) {
					return; // notification
				}
				const method = frame.method ?? "";
				let result: unknown;
				if (method === "join_group_chat") {
					result = { available_characters: [{ character_id: "char-qa", name: "QA", description: "QA" }] };
				} else if (method === "claim_character") {
					result = { character: { character_id: "char-qa", name: "QA", description: "QA", path: characterPath } };
				} else if (method === "character_ready") {
					result = { latest_sequence: 0 };
				} else {
					result = {};
				}
				socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
			});
		});

		return { descriptor, characterPath, inject: (data) => served?.send(data) };
	}

	async function connectRuntime(): Promise<{
		runtime: Awaited<ReturnType<typeof JoinAttempt.prototype.claimCharacter>>;
		disconnected: ReturnType<typeof vi.fn>;
		inject: (data: WebSocket.RawData) => void;
	}> {
		const { descriptor, characterPath, inject } = await startFakeCreator();
		const disconnected = vi.fn();
		const attempt = await JoinAttempt.connect(descriptor, "session-failclose", {
			onDisconnected: disconnected,
		});
		const runtime = await attempt.claimCharacter("char-qa");
		void characterPath;
		return { runtime, disconnected, inject };
	}

	it("二进制帧 → failConnection 断线（ERROR_BINARY_FRAME_RECEIVED）", async () => {
		const { runtime, disconnected, inject } = await connectRuntime();
		inject(Buffer.from([0x00, 0x01, 0x02, 0x03]));
		await vi.waitFor(() => expect(disconnected).toHaveBeenCalled());
		// 断线后拉取返回 null（disconnected 语义），不悬挂。
		await expect(runtime.fetchMessagesSince(0)).resolves.toBeNull();
	});

	it("非法 JSON 帧 → codec 拒帧 → failConnection 断线", async () => {
		const { runtime, disconnected, inject } = await connectRuntime();
		inject(Buffer.from("{ not json"));
		await vi.waitFor(() => expect(disconnected).toHaveBeenCalled());
		await expect(runtime.fetchMessagesSince(0)).resolves.toBeNull();
	});

	it("协议拒帧（未知 method 服务器帧）→ failConnection 断线", async () => {
		const { runtime, disconnected, inject } = await connectRuntime();
		inject(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "totally_unknown_server_method", params: {} })));
		await vi.waitFor(() => expect(disconnected).toHaveBeenCalled());
		await expect(runtime.fetchMessagesSince(0)).resolves.toBeNull();
	});
});
