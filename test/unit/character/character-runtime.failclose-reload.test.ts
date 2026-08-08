import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { ERROR_UNEXPECTED_SPEAK_RESPONSE } from "../../../src/shared/messages.js";

/**
 * #139 方案 B 回归钉（Arch 属主，对抗模式⑪实证）：response-gate feed 前拦截
 * 移位到 request() 解析时校验后，**reload 延续连接上 fail-close 仍须生效**——
 * adoptJsonRpc 路径不得绕过形状校验（reload 重放帧 id 已随 detach 显式取消，
 * 重放不命中 pending；本钉锚 = 新 runtime 接管后发出的请求收到错形状响应 →
 * 仍 reject ERROR_UNEXPECTED_* + 断链，与 join 路径同机制）。
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

/** speak 请求的合法 result 形状（published/event_id/sequence/latest_sequence/round）。 */
function speakResult(sequence: number): Record<string, unknown> {
	return {
		published: true,
		event_id: `e${sequence}`,
		sequence,
		latest_sequence: sequence,
		round: { round_max_messages: 10, used_messages: sequence, remaining_messages: 10 - sequence },
	};
}

describe("CharacterRuntime reload 延续后 fail-close（#139 方案 B 回归）", () => {
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

	/** 跨 reload 构造新 runtime（detach → takeHandoff，连接延续）。 */
	async function reloadRuntime(runtime: CharacterRuntime, socket: MockSocket): Promise<CharacterRuntime> {
		const handoff = await runtime.detachForReload("session-2");
		const taken = await CharacterRuntime.takeHandoff(handoff, undefined, () => undefined);
		runtimes.push(taken);
		return taken;
	}

	it("R1 reload 延续连接上错形状响应 → 仍 fail-close（reject ERROR_UNEXPECTED_SPEAK_RESPONSE + 断链）", async () => {
		const { runtime, socket } = createRuntime();
		const taken = await reloadRuntime(runtime, socket);

		const request = (taken as unknown as { request(m: { method: string; params: unknown }): Promise<unknown> }).request;
		const promise = request.call(taken, { method: "speak", params: { content: "hello" } });
		const id = lastRequestId(socket);

		// 同 id 错 result 形状（speak 请求注入 board_query 合法形状冒充——过 codec
		// schema，在 request() 解析时校验层 fail-close，B1 同款注入）。
		injectResponse(socket, id, {
			result: { boards: {} },
		});

		await expect(promise).rejects.toThrow(ERROR_UNEXPECTED_SPEAK_RESPONSE);
	});

	it("R2 reload 延续连接上正确响应 → 正常 resolve（正向对照，校验不移位不误伤）", async () => {
		const { runtime, socket } = createRuntime();
		const taken = await reloadRuntime(runtime, socket);

		const request = (taken as unknown as { request(m: { method: string; params: unknown }): Promise<unknown> }).request;
		const promise = request.call(taken, { method: "speak", params: { content: "hello" } });
		const id = lastRequestId(socket);

		injectResponse(socket, id, { result: speakResult(1) });

		await expect(promise).resolves.toMatchObject({
			result: { published: true, event_id: "e1" },
		});
	});
});
