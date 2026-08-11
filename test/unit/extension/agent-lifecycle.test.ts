import { describe, expect, it, vi } from "vitest";

import { ABORT_CONTROL_CUSTOM_TYPE } from "../../../src/character/group-chat-input.js";
import { wireAgentLifecycle } from "../../../src/extension/agent-lifecycle.js";

/**
 * W1-a 接线钉：agent_start 续命——
 * 清除 streaming reset watchdog，防 5s 误灭活跃 run 的灯。
 *
 * 红基线（当前实现）：agent-lifecycle.ts agent_start 处理器只做
 * isAgentActive=true + updateStreaming(true) + armRunWedgedWatchdog，
 * 不清 streamingResetWatchdog——agent_end→continue 后 5s 定时器到点
 * 强制 updateStreaming(false) 误灭灯（群聊面板 run 中不亮）。
 * 绿：agent_start 处理器调用 clearStreamingResetWatchdog（续命）。
 */
describe("wireAgentLifecycle  W1-a agent_start 续命", () => {
	it("agent_start 时清除 streaming reset watchdog（长 run 灯不灭）", () => {
		const handlers = new Map<string, (event?: unknown) => void>();
		const pi = {
			on: vi.fn((event: string, handler: (event?: unknown) => void) => {
				handlers.set(event, handler);
			}),
		};
		const runtime = {
			isAgentActive: false,
			updateStreaming: vi.fn(),
			armRunWedgedWatchdog: vi.fn(),
			clearStreamingResetWatchdog: vi.fn(),
			armStreamingResetWatchdog: vi.fn(),
			settleRun: vi.fn(),
		};
		const ctrl = {
			getState: vi.fn(() => ({ type: "character", runtime })),
		};

		wireAgentLifecycle(pi as never, ctrl as never);

		// agent_end 布防 5s watchdog → continue → agent_start
		handlers.get("agent_end")?.();
		expect(runtime.armStreamingResetWatchdog).toHaveBeenCalledTimes(1);
		handlers.get("agent_start")?.();

		// 续命：agent_start 必须清 watchdog（红基线：当前不调 → 5s 误灭）
		expect(runtime.updateStreaming).toHaveBeenCalledWith(true);
		expect(runtime.clearStreamingResetWatchdog).toHaveBeenCalledTimes(1);
		expect(runtime.armRunWedgedWatchdog).toHaveBeenCalledTimes(1);
	});
});

describe("wireAgentLifecycle steer 安全边界打断", () => {
	it("context 始终过滤历史令牌，且仅有待打断状态时 abort", () => {
		const handlers = new Map<string, (event?: never, ctx?: { abort: () => void }) => unknown>();
		const pi = {
			on: vi.fn((event: string, handler: (event?: never, ctx?: { abort: () => void }) => unknown) => {
				handlers.set(event, handler);
			}),
		};
		let boundaryAbort: (() => void) | undefined;
		const consumeAbortControlToken = vi.fn((abort: () => void) => {
			boundaryAbort = abort;
			return true;
		});
		const runtime = {
			isAgentActive: false,
			groupChatInput: { consumeAbortControlToken },
			updateStreaming: vi.fn(),
			armRunWedgedWatchdog: vi.fn(),
			clearStreamingResetWatchdog: vi.fn(),
			armStreamingResetWatchdog: vi.fn(),
			settleRun: vi.fn(),
		};
		const getState = vi.fn<() => unknown>(() => ({ type: "character", runtime }));
		const ctrl = { getState };

		wireAgentLifecycle(pi as never, ctrl as never);

		const abort = vi.fn();
		const token = { role: "custom", customType: ABORT_CONTROL_CUSTOM_TYPE, content: "", display: false };
		const publicInput = { role: "custom", customType: "pi-tavern.group-chat-input", content: "群消息", display: true };
		const result = handlers.get("context")?.({ messages: [token, publicInput] } as never, { abort }) as {
			messages: Array<{ customType: string }>;
		};

		expect(consumeAbortControlToken).toHaveBeenCalledTimes(1);
		expect(boundaryAbort).toBeDefined();
		boundaryAbort?.();
		expect(abort).toHaveBeenCalledTimes(1);
		expect(result.messages).toEqual([publicInput]);

		consumeAbortControlToken.mockClear();
		getState.mockReturnValue({ type: "idle" });
		const historical = handlers.get("context")?.({ messages: [token] } as never, { abort }) as { messages: unknown[] };
		expect(consumeAbortControlToken).not.toHaveBeenCalled();
		expect(historical.messages).toEqual([]);
	});
});
