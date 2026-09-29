import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { GroupChatInput } from "../../../src/character/group-chat-input.js";
import type { PublicMessage, ServerMessage } from "../../../src/protocol/messages.js";
import { DIAG_PREFIX, diag, diagEnabled, setDiagnosticSink } from "../../../src/shared/diagnostic.js";
import { createConsumableMockPi } from "../../helpers/consumable-pi.js";

/**
 * #202 诊断面机械锚（owner 冻结验收面 1/2）：
 *  1. 测试专用 hold 名不出现在生产入口（无 env 入口 ⇒ 生产不可达）；
 *  2. `PITAVERN_DIAG` 未设 → `diag()` 零输出；批 `details` 不写 `diag_batch_id`；
 *  3. 开关打开 → 单行 `[tavern-diag]` 输出；批 `details` 携带 `diag_batch_id`。
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
		throw new Error(`expected a request id, got ${JSON.stringify(sent)}`);
	}
	return sent.id;
}

function injectFrame(socket: MockSocket, frame: Record<string, unknown>): void {
	socket.emit("message", Buffer.from(JSON.stringify(frame)), false);
}

function injectResponse(socket: MockSocket, id: string | number, payload: Record<string, unknown>): void {
	injectFrame(socket, { jsonrpc: "2.0", id, ...payload });
}

const CHARACTER = {
	characterId: "dev",
	name: "Dev",
	description: "Dev",
	path: "/chars/dev.md",
	prompt: "Dev prompt",
};

const PRODUCTION_ENTRIES = ["index.ts", "headless.ts", "commands.ts"] as const;
const TEST_HOOK_NAMES = ["testFlushHold", "testRequestHold", "testDropBroadcast"] as const;

function createMockRuntime(cursor: number): CharacterRuntime {
	return {
		groupChatId: "group-1",
		character: {
			characterId: "dev",
			name: "Developer",
			description: "Writes code",
			path: "/chars/dev.md",
			prompt: "You are a developer.",
		},
		getGroupChatState: async () => ({}),
		hasPublicMessages: true,
		onEnvironmentMessage: undefined,
		onAgentSettled: undefined,
		isAgentActive: false,
		loadCursor: () => cursor,
		saveCursor: () => undefined,
		fetchMessagesSince: async () => ({
			messages: [aPublicMessage(1)],
			latestSequence: 1,
			totalMessages: 1,
			contextCount: 0,
		}),
		refreshGroupChatState: async () => undefined,
	} as unknown as CharacterRuntime;
}

function aPublicMessage(sequence: number): ServerMessage {
	return {
		jsonrpc: "2.0",
		method: "public_message",
		params: {
			event_id: `evt-${sequence}`,
			sequence,
			timestamp: "2026-09-29T00:00:00.000Z",
			sender: { type: "user_persona" },
			content: `message-${sequence}`,
			round: { round_max_messages: 200, used_messages: sequence, remaining_messages: 200 - sequence },
		},
	} as PublicMessage;
}

function aGroupChatUpdate(latestSequence: number): ServerMessage {
	return {
		jsonrpc: "2.0",
		method: "group_chat_update",
		params: {
			latest_sequence: latestSequence,
			preview_messages: [aPublicMessage(latestSequence)],
			total_messages: latestSequence,
		},
	} as unknown as ServerMessage;
}

/** 驱动一次投递（idle 窗口到期 → pull → flush → sendMessage）。 */
async function driveDelivery(): Promise<{ details: Record<string, unknown> }> {
	vi.useFakeTimers();
	const runtime = createMockRuntime(0);
	const api = createConsumableMockPi();
	const input = new GroupChatInput(runtime, api.pi);
	input.start();
	runtime.onEnvironmentMessage?.(aGroupChatUpdate(1));
	await vi.advanceTimersByTimeAsync(1000);
	const message = (api.pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
		details?: Record<string, unknown>;
	};
	input.stop();
	vi.useRealTimers();
	return { details: message?.details ?? {} };
}

afterEach(() => {
	vi.unstubAllEnvs();
	setDiagnosticSink(undefined);
});

describe("#202 诊断面机械锚", () => {
	it("生产入口不出现测试专用 hold 名（无 env 入口 ⇒ 生产不可达）", () => {
		const root = join(import.meta.dirname, "../../../src");
		for (const entry of PRODUCTION_ENTRIES) {
			const text = readFileSync(join(root, entry), "utf8");
			for (const hook of TEST_HOOK_NAMES) {
				expect(text.includes(hook)).toBe(false);
			}
		}
	});

	it("PITAVERN_DIAG 未设时零输出", () => {
		vi.stubEnv("PITAVERN_DIAG", "");
		const sink = vi.fn();
		setDiagnosticSink(sink);
		expect(diagEnabled()).toBe(false);
		diag("recv", { method: "public_message", seq: 1 });
		diag("flush", { phase: "enter" });
		expect(sink).not.toHaveBeenCalled();
	});

	it("开关打开时单行输出（前缀 + 字段单行化）", () => {
		vi.stubEnv("PITAVERN_DIAG", "1");
		const sink = vi.fn();
		setDiagnosticSink(sink);
		expect(diagEnabled()).toBe(true);
		diag("flush", { phase: "enter", events: 2, ok: false, note: "a\nb" });
		expect(sink).toHaveBeenCalledTimes(1);
		const line = sink.mock.calls[0]?.[0] as string;
		expect(line.startsWith(`${DIAG_PREFIX} flush `)).toBe(true);
		expect(line).toContain("phase=enter");
		expect(line).toContain("events=2");
		expect(line).toContain("ok=false");
		expect(line).not.toContain("\n");
	});

	it("批 details 的 diag_batch_id 仅开关期写入", async () => {
		vi.stubEnv("PITAVERN_DIAG", "");
		const off = await driveDelivery();
		expect("diag_batch_id" in off.details).toBe(false);

		vi.stubEnv("PITAVERN_DIAG", "1");
		const lines: string[] = [];
		setDiagnosticSink((line) => lines.push(line));
		const on = await driveDelivery();
		expect(typeof on.details.diag_batch_id).toBe("number");
		expect(lines.some((line) => line.includes("inject phase=call"))).toBe(true);
		expect(lines.some((line) => line.includes("route"))).toBe(true);
	});

	it("hold 注入点冒烟：三点各自停在预期阶段（判别性 e2e 由 QA 构造验证）", async () => {
		vi.stubEnv("PITAVERN_DIAG", "1");
		const cases: Array<{
			point: "enter" | "before-state" | "after-state";
			present: string;
			absent: string;
			stateCalls: number;
		}> = [
			{ point: "enter", present: "flush phase=enqueue", absent: "flush phase=enter", stateCalls: 0 },
			{ point: "before-state", present: "flush phase=enter", absent: "inject phase=call", stateCalls: 0 },
			{ point: "after-state", present: "flush phase=enter", absent: "inject phase=call", stateCalls: 1 },
		];
		for (const testCase of cases) {
			const { lines, heldPoints, stateCalls, finish } = await driveDeliveryWithHold(testCase.point);
			expect(heldPoints).toContain(testCase.point);
			expect(
				lines.some((line) => line.includes(testCase.present)),
				`${testCase.point}: 应有 ${testCase.present}`,
			).toBe(true);
			expect(
				lines.some((line) => line.includes(testCase.absent)),
				`${testCase.point}: 不应有 ${testCase.absent}`,
			).toBe(false);
			expect(stateCalls(), `${testCase.point}: getGroupChatState 调用数`).toBe(testCase.stateCalls);
			await finish();
		}
	});
});

/** 在指定 flush 阶段挂起一次投递；返回钉行、hook 命中记录与释放函数。 */
async function driveDeliveryWithHold(point: "enter" | "before-state" | "after-state"): Promise<{
	lines: string[];
	heldPoints: string[];
	stateCalls: () => number;
	finish: () => Promise<void>;
}> {
	vi.useFakeTimers();
	const lines: string[] = [];
	const heldPoints: string[] = [];
	setDiagnosticSink((line) => lines.push(line));
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const runtime = createMockRuntime(0);
	const originalGetState = runtime.getGroupChatState.bind(runtime);
	const stateSpy = vi.fn(() => originalGetState());
	runtime.getGroupChatState = stateSpy as unknown as typeof runtime.getGroupChatState;
	const api = createConsumableMockPi();
	const input = new GroupChatInput(runtime, api.pi, 1000, 5000, (held) => {
		heldPoints.push(held);
		return held === point ? gate : undefined;
	});
	input.start();
	runtime.onEnvironmentMessage?.(aGroupChatUpdate(1));
	await vi.advanceTimersByTimeAsync(1000);
	return {
		lines,
		heldPoints,
		stateCalls: () => stateSpy.mock.calls.length,
		finish: async () => {
			release();
			await vi.advanceTimersByTimeAsync(0);
			input.stop();
			vi.useRealTimers();
		},
	};
}

describe("#202 runtime 钉（真实 runtime + mock socket）", () => {
	const runtimes: CharacterRuntime[] = [];

	afterEach(() => {
		for (const runtime of runtimes) {
			(runtime as unknown as { stopHeartbeat(): void }).stopHeartbeat();
		}
		runtimes.length = 0;
	});

	it("recv / state / fetch 钉在真实请求路径上产出", async () => {
		vi.stubEnv("PITAVERN_DIAG", "1");
		const lines: string[] = [];
		setDiagnosticSink((line) => lines.push(line));
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

		// 广播帧 → recv 钉（handler 未挂 = 该字段暴露接线态）。
		injectFrame(socket, {
			jsonrpc: "2.0",
			method: "group_chat_update",
			params: { latest_sequence: 1, preview_messages: [], total_messages: 1 },
		});
		expect(lines.some((line) => line.includes("recv") && line.includes("group_chat_update"))).toBe(true);
		expect(lines.some((line) => line.includes("handler=false"))).toBe(true);

		// getGroupChatState 起止钉。
		const statePromise = runtime.getGroupChatState();
		injectResponse(socket, lastRequestId(socket), {
			result: {
				group_chat: {
					group_chat_id: "group-1",
					name: null,
					created_at: "2026-09-29T00:00:00.000Z",
					group_max_messages: 200,
				},
				round: null,
				online_characters: [],
			},
		});
		await statePromise;
		expect(lines.some((line) => line.includes("state phase=start"))).toBe(true);
		expect(lines.some((line) => line.includes("state phase=end"))).toBe(true);

		// fetchMessagesSince 起止钉。
		const fetchPromise = runtime.fetchMessagesSince(0);
		injectResponse(socket, lastRequestId(socket), { result: { messages: [], latest_sequence: 0, total_messages: 0 } });
		await fetchPromise;
		expect(lines.some((line) => line.includes("fetch phase=start"))).toBe(true);
		expect(lines.some((line) => line.includes("fetch phase=end"))).toBe(true);
	});
});
