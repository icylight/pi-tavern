import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { JoinAttempt } from "../../../src/character/join-attempt.js";
import { ERROR_UNEXPECTED_CLAIM_RESPONSE, ERROR_UNEXPECTED_SPEAK_RESPONSE } from "../../../src/shared/messages.js";

/**
 * #119 阻断②回归（苍蓝星 2026-08-06）：响应按 id 关联后必须按预期 method
 * 校验 result 形状——同 id 的错 result（如 board_query result 冒充
 * get_group_chat_state）必须 fail-close，而非让调用方断言到 undefined/异常。
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

/** 从 mock socket 已发送帧中提取最近一次请求的 id（v9 库数字 id / schema 已放宽 string|number）。 */
function lastRequestId(socket: MockSocket): string | number {
	const sent = socket.sent.at(-1) as Record<string, unknown>;
	if (typeof sent.id !== "string" && typeof sent.id !== "number") {
		throw new Error(`expected a request with string|number id, got ${JSON.stringify(sent)}`);
	}
	return sent.id;
}

function injectResponse(socket: MockSocket, id: string | number, payload: Record<string, unknown>): void {
	socket.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, ...payload })), false);
}

const CHARACTER = {
	characterId: "tester",
	name: "Tester",
	description: "Tests",
	path: "characters/tester.md",
	prompt: "Test prompt",
};

describe("CharacterRuntime pending 响应按 method 校验（阻断②）", () => {
	const sockets: MockSocket[] = [];
	const runtimes: CharacterRuntime[] = [];

	afterEach(() => {
		for (const runtime of runtimes) {
			(runtime as unknown as { stopHeartbeat(): void }).stopHeartbeat();
		}
		runtimes.length = 0;
		sockets.length = 0;
	});

	function createRuntime(): { runtime: CharacterRuntime; socket: MockSocket } {
		const socket = createMockSocket();
		sockets.push(socket);
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

	it("B1 同 id 但 result 形状不符 → 及时 reject（fail-close，不悬挂）", async () => {
		const { runtime, socket } = createRuntime();
		const request = (runtime as unknown as { request(m: { method: string; params: unknown }): Promise<unknown> })
			.request;
		const promise = request.call(runtime, { method: "speak", params: { content: "hello" } });
		const id = lastRequestId(socket);

		// 注入 board_query 形状的 result（合法信封、错误 method 关联——冒充 speak 响应）。
		// 二轮评审阻断①（苍蓝星）：错误 result 必须 fail-close 及时 reject，
		// 不得静默丢弃悬挂到超时。
		injectResponse(socket, id, { result: { boards: {} } });

		const start = Date.now();
		await expect(promise).rejects.toThrow(ERROR_UNEXPECTED_SPEAK_RESPONSE);
		expect(Date.now() - start).toBeLessThan(1_000);
	});

	it("chain: whisper stale→success→stale（#152 二轮 B 级：成功后重置共享自愈预算）", async () => {
		const { runtime, socket } = createRuntime();
		const ROUND = { round_max_messages: 10, used_messages: 6, remaining_messages: 4 };
		const staleResult = {
			published: false,
			reason: "stale",
			missing_sequences: { from: 3, to: 5 },
			round: ROUND,
		};
		const publishedResult = { published: true, sequence: 7, round: ROUND };

		// ① stale 拒绝 → 消耗预算（autoRecover true）。
		let p = runtime.whisper("qa", "hello");
		let id = lastRequestId(socket);
		injectResponse(socket, id, { result: staleResult });
		let res = await p;
		expect(res.published).toBe(false);
		expect(res.reason).toBe("stale");
		expect(res.autoRecover).toBe(true);

		// ② whisper 成功 → 预算重置（与 speak 同语义）。
		p = runtime.whisper("qa", "hello2");
		id = lastRequestId(socket);
		injectResponse(socket, id, { result: publishedResult });
		res = await p;
		expect(res.published).toBe(true);
		expect(res.sequence).toBe(7);

		// ③ 同 round key 再次 stale → 重新获得完整预算（autoRecover true）。
		p = runtime.whisper("qa", "hello3");
		id = lastRequestId(socket);
		injectResponse(socket, id, { result: staleResult });
		res = await p;
		expect(res.published).toBe(false);
		expect(res.reason).toBe("stale");
		expect(res.autoRecover).toBe(true);
	});

	it("B2 请求 in-flight 时 socket close → 即时 reject（非 5s 超时）", async () => {
		const { runtime, socket } = createRuntime();
		const request = (runtime as unknown as { request(m: { method: string; params: unknown }): Promise<unknown> })
			.request;
		const promise = request.call(runtime, { method: "speak", params: { content: "hello" } });

		// 断线：dispose 库内拒绝（-32097）→ request() 映射断线原因立即 reject。
		socket.readyState = WebSocket.CLOSED;
		socket.emit("close");

		const start = Date.now();
		await expect(promise).rejects.toThrow();
		expect(Date.now() - start).toBeLessThan(1_000);
	});

	it("B3 连接延续态：连续请求 id 单调（跨 handoff 不重置序列）", async () => {
		const { runtime, socket } = createRuntime();
		const request = (runtime as unknown as { request(m: { method: string; params: unknown }): Promise<unknown> })
			.request;
		const first = request.call(runtime, { method: "speak", params: { content: "a" } });
		const firstId = lastRequestId(socket);
		const second = request.call(runtime, { method: "speak", params: { content: "b" } });
		const secondId = lastRequestId(socket);

		// 同一 connection 序列单调递增——reload 延续不重建，旧代际响应撞不上新 id。
		if (typeof firstId === "number" && typeof secondId === "number") {
			expect(secondId).toBeGreaterThan(firstId);
		} else if (typeof firstId === "string" && typeof secondId === "string") {
			expect(secondId).not.toBe(firstId);
		}

		// 清理两个 in-flight（注入正确响应使 settle，避免超时断链）。
		injectResponse(socket, firstId, {
			result: {
				published: true,
				event_id: "e1",
				sequence: 1,
				latest_sequence: 1,
				round: { round_max_messages: 10, used_messages: 1, remaining_messages: 9 },
			},
		});
		injectResponse(socket, secondId, {
			result: {
				published: true,
				event_id: "e2",
				sequence: 2,
				latest_sequence: 2,
				round: { round_max_messages: 10, used_messages: 2, remaining_messages: 8 },
			},
		});
		await first;
		await second;
	});

	it("B2 同 id 正确 result 形状 → 正常 resolve（正向对照）", async () => {
		const { runtime, socket } = createRuntime();
		const request = (runtime as unknown as { request(m: { method: string; params: unknown }): Promise<unknown> })
			.request;
		const promise = request.call(runtime, { method: "speak", params: { content: "hello" } });
		const id = lastRequestId(socket);

		injectResponse(socket, id, {
			result: {
				published: true,
				event_id: "evt-1",
				sequence: 1,
				latest_sequence: 1,
				round: { round_max_messages: 10, used_messages: 1, remaining_messages: 9 },
			},
		});

		const response = (await promise) as { result: { published: boolean } };
		expect(response.result.published).toBe(true);
	});

	it("B4 发送路径 id 恒为数字且递增（#139 A 组转库行为验证——id 由库语义保证）", async () => {
		const { runtime, socket } = createRuntime();
		const request = (runtime as unknown as { request(m: { method: string; params: unknown }): Promise<unknown> })
			.request;
		const first = request.call(runtime, { method: "speak", params: { content: "a" } });
		const firstId = lastRequestId(socket);
		const second = request.call(runtime, { method: "speak", params: { content: "b" } });
		const secondId = lastRequestId(socket);

		// v9 库 sendRequest 数字自增 id：类型恒 number（schema 已放宽 string|number，
		// 但库语义保证 = 数字且逐请求递增；codec 强制三态为防御纵深，双保险显式锚定）。
		expect(typeof firstId).toBe("number");
		expect(typeof secondId).toBe("number");
		if (typeof firstId === "number" && typeof secondId === "number") {
			expect(secondId).toBeGreaterThan(firstId);
		}

		// 清理两个 in-flight（注入正确响应使 settle，避免超时断链）。
		injectResponse(socket, firstId, {
			result: {
				published: true,
				event_id: "e1",
				sequence: 1,
				latest_sequence: 1,
				round: { round_max_messages: 10, used_messages: 1, remaining_messages: 9 },
			},
		});
		injectResponse(socket, secondId, {
			result: {
				published: true,
				event_id: "e2",
				sequence: 2,
				latest_sequence: 2,
				round: { round_max_messages: 10, used_messages: 2, remaining_messages: 8 },
			},
		});
		await first;
		await second;
	});
});

describe("JoinAttempt pending 响应按 method 校验（阻断②同步）", () => {
	const sockets: MockSocket[] = [];

	afterEach(() => {
		sockets.length = 0;
	});

	function createAttempt(): { attempt: JoinAttempt; socket: MockSocket } {
		const socket = createMockSocket();
		sockets.push(socket);
		const descriptor = { host: "127.0.0.1", port: 9999, groupChatId: "group-1", instanceId: "inst-1" };
		const attempt = new (
			JoinAttempt as unknown as new (
				descriptor: unknown,
				sessionId: string,
				socket: unknown,
				buffered: unknown[],
				options: unknown,
			) => JoinAttempt
		)(descriptor, "session-1", socket, [], {});
		return { attempt, socket };
	}

	it("C1 claim 同 id 错误 result 形状 → fail-close", async () => {
		const { attempt, socket } = createAttempt();
		const request = (attempt as unknown as { request(m: { method: string; params: unknown }): Promise<unknown> })
			.request;
		const promise = request.call(attempt, {
			method: "claim_character",
			params: { character_id: "dev" },
		});
		const id = lastRequestId(socket);

		// 注入 board_query 形状的 result（合法信封、错误 method 关联——冒充 claim 响应）。
		injectResponse(socket, id, { result: { boards: {} } });

		await expect(promise).rejects.toThrow(ERROR_UNEXPECTED_CLAIM_RESPONSE);
	});

	it("C2 claim 同 id 正确 result 形状 → 正常 resolve（正向对照）", async () => {
		const { attempt, socket } = createAttempt();
		const request = (attempt as unknown as { request(m: { method: string; params: unknown }): Promise<unknown> })
			.request;
		const promise = request.call(attempt, {
			method: "claim_character",
			params: { character_id: "dev" },
		});
		const id = lastRequestId(socket);

		injectResponse(socket, id, {
			result: {
				character: {
					character_id: "dev",
					name: "Developer",
					description: "Dev",
					path: "characters/developer.md",
				},
			},
		});

		const response = (await promise) as { result: { character: { character_id: string } } };
		expect(response.result.character.character_id).toBe("dev");
	});
});
