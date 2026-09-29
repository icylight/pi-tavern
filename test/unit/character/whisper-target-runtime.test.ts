import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { CharacterRuntime } from "../../../src/character/character-runtime.js";

/**
 * #183 目标解析的 runtime 取数链（Dev 钉面，unit 层）：
 *
 * 名册新鲜获取（`get_group_chat_state`）→ 失败回退 `lastGroupChatState`
 * 缓存 → 两者皆无 `roster-unavailable`（调用方放行原串交服务端判，
 * 不把客户端故障伪报为「目标不存在」）。
 */

interface MockSocket extends EventEmitter {
	readyState: number;
	sent: Array<Record<string, unknown>>;
	send: (data: string) => void;
	terminate: () => void;
}

function createMockSocket(): MockSocket {
	const socket = new EventEmitter() as MockSocket;
	socket.readyState = WebSocket.OPEN;
	socket.sent = [];
	socket.send = ((data: string) => {
		socket.sent.push(JSON.parse(data) as Record<string, unknown>);
	}) as unknown as MockSocket["send"];
	socket.terminate = (() => {
		socket.readyState = WebSocket.CLOSED;
	}) as unknown as MockSocket["terminate"];
	return socket;
}

function lastRequestId(socket: MockSocket): string | number {
	const sent = socket.sent.at(-1) as Record<string, unknown>;
	if (typeof sent.id !== "string" && typeof sent.id !== "number") {
		throw new Error(`expected a request with string|number id, got ${JSON.stringify(sent)}`);
	}
	return sent.id;
}

function injectResult(socket: MockSocket, id: string | number, result: unknown): void {
	socket.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result })), false);
}

function injectError(socket: MockSocket, id: string | number, message: string): void {
	socket.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } })), false);
}

const CHARACTER = {
	characterId: "../characters/dev.md",
	name: "Dev",
	description: "Dev",
	path: "characters/dev.md",
	prompt: "Dev prompt",
};

const ONLINE = [
	{
		character_id: "../characters/dev.md",
		name: "Dev",
		description: "Dev",
		is_self: true,
		is_streaming: false,
		hand_raised: false,
	},
	{
		character_id: "../角色卡/admin.md",
		name: "Admin",
		description: "Admin",
		is_self: false,
		is_streaming: false,
		hand_raised: false,
	},
];

describe("CharacterRuntime.resolveWhisperTarget 取数链（#183）", () => {
	const runtimes: CharacterRuntime[] = [];

	afterEach(() => {
		for (const runtime of runtimes) {
			(runtime as unknown as { stopHeartbeat(): void }).stopHeartbeat();
		}
		runtimes.length = 0;
	});

	function createRuntime(): { runtime: CharacterRuntime; socket: MockSocket } {
		const socket = createMockSocket();
		const runtime = CharacterRuntime.prepare({
			groupChatId: "group-1",
			sessionId: "session-1",
			character: CHARACTER,
			heartbeatIntervalMs: 60_000,
			heartbeatTimeoutMs: 60_000,
			requestTimeoutMs: 5_000,
		});
		runtime.activate({ socket: socket as unknown as WebSocket, bufferedMessages: [] });
		runtimes.push(runtime);
		return { runtime, socket };
	}

	it("新鲜快照命中 → resolved（注册名 → 路径形态 id）", async () => {
		const { runtime, socket } = createRuntime();
		const pending = runtime.resolveWhisperTarget("Admin");
		const request = socket.sent.at(-1) as Record<string, unknown>;
		expect(request.method).toBe("get_group_chat_state");
		injectResult(socket, lastRequestId(socket), {
			group_chat: {
				group_chat_id: "group-1",
				name: null,
				created_at: "2026-09-29T00:00:00.000Z",
				group_max_messages: 100,
			},
			round: null,
			online_characters: ONLINE,
		});
		await expect(pending).resolves.toMatchObject({ kind: "resolved", character_id: "../角色卡/admin.md" });
	});

	it("新鲜获取失败 → 回退 lastGroupChatState 缓存命中", async () => {
		const { runtime, socket } = createRuntime();
		// 先成功取一次，填充缓存。
		const first = runtime.resolveWhisperTarget("Admin");
		injectResult(socket, lastRequestId(socket), {
			group_chat: {
				group_chat_id: "group-1",
				name: null,
				created_at: "2026-09-29T00:00:00.000Z",
				group_max_messages: 100,
			},
			round: null,
			online_characters: ONLINE,
		});
		await first;
		// 再取时服务端报错 → 用缓存解析（不伪报「目标不存在」）。
		const second = runtime.resolveWhisperTarget("Admin");
		injectError(socket, lastRequestId(socket), "boom");
		await expect(second).resolves.toMatchObject({ kind: "resolved", character_id: "../角色卡/admin.md" });
	});

	it("新鲜获取失败且无缓存 → roster-unavailable（调用方放行原串）", async () => {
		const { runtime, socket } = createRuntime();
		const pending = runtime.resolveWhisperTarget("../角色卡/admin.md");
		injectError(socket, lastRequestId(socket), "boom");
		await expect(pending).resolves.toMatchObject({ kind: "roster-unavailable" });
	});
});
