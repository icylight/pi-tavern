import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { CharacterRuntime } from "../../../src/character/character-runtime.js";

/**
 * #138 拉取附加上下文窗口（方案 A，零协议变更）：fetchMessagesSince 第二参
 * contextWindow（默认 0 行为不变）——拉取起点前移 max(0, since - window)，
 * 游标存储值不动、pageOlderHistory 不叠加。unit 层窗口边界钉（Arch 主）：
 * since=0/1 不越界、默认 0 不变、空洞退化不越界（按 sequence 号前移，
 * 不查条数）、游标值不因窗口而变、reload 移交后窗口仍生效。
 */

interface MockSocket extends EventEmitter {
	readyState: number;
	sent: Array<Record<string, unknown>>;
	send: (data: string) => void;
	terminate: () => void;
	close: () => void;
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
	socket.close = (() => {
		socket.readyState = WebSocket.CLOSED;
	}) as unknown as MockSocket["close"];
	return socket;
}

function injectResponse(socket: MockSocket, id: string | number, payload: Record<string, unknown>): void {
	socket.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, ...payload })), false);
}

function lastSentFrame(socket: MockSocket): Record<string, unknown> {
	const sent = socket.sent.at(-1) as Record<string, unknown>;
	if (!sent) {
		throw new Error("no frame sent");
	}
	return sent;
}

const CHARACTER = {
	characterId: "tester",
	name: "Tester",
	description: "Tests",
	path: "characters/tester.md",
	prompt: "Test prompt",
};

describe("CharacterRuntime.fetchMessagesSince 上下文窗口（#138）", () => {
	const sockets: MockSocket[] = [];
	const runtimes: CharacterRuntime[] = [];

	afterEach(() => {
		for (const runtime of runtimes) {
			(runtime as unknown as { stopHeartbeat(): void }).stopHeartbeat();
		}
		runtimes.length = 0;
		sockets.length = 0;
	});

	function createRuntime(options?: { getFetchContextWindow?: () => number }): { runtime: CharacterRuntime; socket: MockSocket } {
		const socket = createMockSocket();
		sockets.push(socket);
		const runtime = CharacterRuntime.prepare({
			groupChatId: "group-1",
			sessionId: "session-1",
			character: CHARACTER,
			heartbeatIntervalMs: 60_000,
			heartbeatTimeoutMs: 60_000,
			requestTimeoutMs: 5_000,
			...(options?.getFetchContextWindow !== undefined
				? { getFetchContextWindow: options.getFetchContextWindow }
				: {}),
		});
		runtime.activate({ socket: socket as unknown as WebSocket, bufferedMessages: [] });
		runtimes.push(runtime);
		return { runtime, socket };
	}

	async function fetchAndResolve(
		runtime: CharacterRuntime,
		socket: MockSocket,
		since: number,
		window?: number,
	): Promise<void> {
		const pending = window === undefined ? runtime.fetchMessagesSince(since) : runtime.fetchMessagesSince(since, window);
		const frame = lastSentFrame(socket);
		const id = frame.id as string | number;
		injectResponse(socket, id, {
			result: {
				messages: [],
				latest_sequence: since,
				total_messages: since,
			},
		});
		await pending;
	}

	it("W1 窗口=1：请求起点前移 = max(0, since-1)（since=10 → 9）", async () => {
		const { runtime, socket } = createRuntime();
		await fetchAndResolve(runtime, socket, 10, 1);
		const frame = lastSentFrame(socket);
		expect(frame.params).toEqual({ since_sequence: 9 });
	});

	it("W2 窗口=1：since=1 不越界（max(0, 0)）", async () => {
		const { runtime, socket } = createRuntime();
		await fetchAndResolve(runtime, socket, 1, 1);
		const frame = lastSentFrame(socket);
		expect(frame.params).toEqual({ since_sequence: 0 });
	});

	it("W3 窗口>since：since=0 不越界（max(0, 0-5) → 0）", async () => {
		const { runtime, socket } = createRuntime();
		await fetchAndResolve(runtime, socket, 0, 5);
		const frame = lastSentFrame(socket);
		expect(frame.params).toEqual({ since_sequence: 0 });
	});

	it("W4 默认 0 行为不变：不传窗口 = since 原样（既有调用零影响）", async () => {
		const { runtime, socket } = createRuntime();
		await fetchAndResolve(runtime, socket, 10);
		const frame = lastSentFrame(socket);
		expect(frame.params).toEqual({ since_sequence: 10 });
	});

	it("W5 显式窗口=0：行为同默认（since 原样）", async () => {
		const { runtime, socket } = createRuntime();
		await fetchAndResolve(runtime, socket, 10, 0);
		const frame = lastSentFrame(socket);
		expect(frame.params).toEqual({ since_sequence: 10 });
	});

	it("W6 空洞退化不越界：前移按 sequence 号（since-window）而非条数", async () => {
		// 服务端消息存在 sequence 空洞（驳回不占号）时，窗口语义 = 前移 N 个
		// sequence 号（取到少于 N 条由服务端自然返回），不得按条数向前多拉。
		const { runtime, socket } = createRuntime();
		await fetchAndResolve(runtime, socket, 8, 2);
		const frame = lastSentFrame(socket);
		expect(frame.params).toEqual({ since_sequence: 6 });
	});

	it("W7 游标存储值不动：窗口前移不改变请求对 latest 语义的消费（窗口仅起点前移）", async () => {
		const { runtime, socket } = createRuntime();
		await fetchAndResolve(runtime, socket, 10, 1);
		const frame = lastSentFrame(socket);
		// 窗口只影响 since_sequence 起点；latest_sequence 消费语义（游标推进）
		// 由 deliver 侧保持——此处断言请求仍只带 since_sequence 单参（协议零变更）。
		expect(Object.keys(frame.params as Record<string, unknown>)).toEqual(["since_sequence"]);
	});

	it("W8 reload 移交后窗口仍生效：detach 快照携带 getter + takeHandoff 透传（join/reload 行为一致）", async () => {
		const { runtime, socket } = createRuntime({ getFetchContextWindow: () => 1 });
		const handoff = await runtime.detachForReload("session-2");
		// ① 快照携带 getter（对抗模式⑬：跨移交依赖显式转移，不静默丢失）。
		expect(handoff.getFetchContextWindow).toBeDefined();
		expect(handoff.getFetchContextWindow?.()).toBe(1);

		// ② 接管侧透传：新 runtime 拉取窗口生效（起点前移 max(0, since-1)）。
		const taken = await CharacterRuntime.takeHandoff(handoff, undefined, () => undefined);
		runtimes.push(taken);
		await fetchAndResolve(taken, socket, 10, undefined);
		const frame = lastSentFrame(socket);
		expect(frame.params).toEqual({ since_sequence: 9 });
	});

	it("W9 reload 移交无 getter：窗口 0 兜底（缺省 undefined → 行为不变）", async () => {
		const { runtime, socket } = createRuntime();
		const handoff = await runtime.detachForReload("session-2");
		expect(handoff.getFetchContextWindow).toBeUndefined();

		const taken = await CharacterRuntime.takeHandoff(handoff, undefined, () => undefined);
		runtimes.push(taken);
		await fetchAndResolve(taken, socket, 10, undefined);
		const frame = lastSentFrame(socket);
		expect(frame.params).toEqual({ since_sequence: 10 });
	});
});
