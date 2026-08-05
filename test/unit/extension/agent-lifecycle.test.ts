import { describe, expect, it, vi } from "vitest";

import { wireAgentLifecycle } from "../../../src/extension/agent-lifecycle.js";

/**
 * #90 W1-a 接线钉（QA，2026-08-03）：agent_start 续命——
 * 清除 streaming reset watchdog，防 5s 误灭活跃 run 的灯。
 *
 * 红基线（当前实现）：agent-lifecycle.ts agent_start 处理器只做
 * isAgentActive=true + updateStreaming(true) + armRunWedgedWatchdog，
 * 不清 streamingResetWatchdog——agent_end→continue 后 5s 定时器到点
 * 强制 updateStreaming(false) 误灭灯（User 观察：群聊面板 run 中不亮）。
 * 绿：agent_start 处理器调用 clearStreamingResetWatchdog（续命）。
 */
describe("wireAgentLifecycle #90 W1-a agent_start 续命", () => {
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

describe("wireAgentLifecycle v0.5 abort-interrupt-delivery", () => {
	it("agent_start 时注入 ctx.abort 且每次重新赋值（新 run 新 ctx）", () => {
		// v0.5（苍蓝星拍板）：abort 能力经 agent_start 事件 ctx 注入 runtime——
		// 群聊投递链 deliverSteer 入队后调用；abort 后重开 run 再次 agent_start，
		// abortAgent 必须指向新 run 的 ctx（旧 ctx.abort 不再生效）。
		const handlers = new Map<string, (event?: unknown, ctx?: { abort?: () => void; isIdle?: () => boolean }) => void>();
		const pi = {
			on: vi.fn(
				(event: string, handler: (event?: unknown, ctx?: { abort?: () => void; isIdle?: () => boolean }) => void) => {
					handlers.set(event, handler);
				},
			),
		};
		const runtime = {
			isAgentActive: false,
			updateStreaming: vi.fn(),
			armRunWedgedWatchdog: vi.fn(),
			clearStreamingResetWatchdog: vi.fn(),
			armStreamingResetWatchdog: vi.fn(),
			settleRun: vi.fn(),
			abortAgent: undefined as (() => boolean) | undefined,
		};
		const ctrl = {
			getState: vi.fn(() => ({ type: "character", runtime })),
		};

		wireAgentLifecycle(pi as never, ctrl as never);

		const ctx1 = { abort: vi.fn(), isIdle: vi.fn(() => false) };
		handlers.get("agent_start")?.(undefined, ctx1);
		expect(runtime.abortAgent).toBeDefined();
		expect(runtime.abortAgent?.()).toBe(true);
		expect(ctx1.abort).toHaveBeenCalledTimes(1);

		// 新 run（abort → 重开）→ 新 ctx → abortAgent 重新赋值。
		const ctx2 = { abort: vi.fn(), isIdle: vi.fn(() => false) };
		handlers.get("agent_start")?.(undefined, ctx2);
		expect(runtime.abortAgent?.()).toBe(true);
		expect(ctx2.abort).toHaveBeenCalledTimes(1);
		expect(ctx1.abort).toHaveBeenCalledTimes(1);

		// runtime 标志尚未收敛但 pi 已 idle 时不发送无效 abort，让输入管线走兜底投递。
		ctx2.isIdle.mockReturnValue(true);
		expect(runtime.abortAgent?.()).toBe(false);
		expect(ctx2.abort).toHaveBeenCalledTimes(1);
	});
});
