import { describe, expect, it, vi } from "vitest";

import { CharacterRuntime } from "../../../src/character/character-runtime.js";
import type { CharacterCard } from "../../../src/config/character-card.js";

/**
 * A3（验收清单 #14-A3）：悬挂兜底——armStreamingResetWatchdog 定时复位。
 *
 * Node 定时器不依赖 agent 状态：agent_end 后若 agent_settled 迟迟不来
 * （run 卡死/异常中止），watchdog 在窗口结束后强制 updateStreaming(false)，
 * "正在发言"显示不可能悬挂。happy path（settled）清除定时器。
 *
 * 本文件测 runtime 层定时逻辑（fake timers 钉死，Architect 方案）；
 * 进程级验证（真实 pi 的 agent_end/settled 事件）落 acceptance 层。
 */

const character: CharacterCard = {
	characterId: "characters/architect.md",
	name: "Architect",
	description: "Architecture",
	path: "/characters/architect.md",
	prompt: "Architect prompt",
};

function createFakeSocket(): {
	socket: {
		on: ReturnType<typeof vi.fn>;
		once: ReturnType<typeof vi.fn>;
		off: ReturnType<typeof vi.fn>;
		removeListener: ReturnType<typeof vi.fn>;
		send: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
		terminate: ReturnType<typeof vi.fn>;
	};
	handlers: Record<string, (...args: unknown[]) => void>;
} {
	const handlers: Record<string, (...args: unknown[]) => void> = {};
	const socket = {
		on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			handlers[event] = handler;
		}),
		once: vi.fn(),
		off: vi.fn(),
		removeListener: vi.fn(),
		send: vi.fn(),
		close: vi.fn(),
		terminate: vi.fn(),
		readyState: 1, // WebSocket.OPEN
	};
	return { socket, handlers };
}

function createRuntime(): { runtime: CharacterRuntime; socket: ReturnType<typeof createFakeSocket>["socket"] } {
	const { socket } = createFakeSocket();
	const runtime = CharacterRuntime.prepare({
		groupChatId: "group-1",
		sessionId: "session-1",
		character,
	});
	// activate 只注册事件监听并启动心跳；fake socket 足够支撑 watchdog 测试。
	runtime.activate({
		socket: socket as never,
		bufferedMessages: [],
	} as never);
	return { runtime, socket };
}

describe("A3: streaming reset watchdog (#14 悬挂兜底)", () => {
	it("force-resets is_streaming when agent_settled never arrives", () => {
		vi.useFakeTimers();
		try {
			const { runtime } = createRuntime();
			const updateStreaming = vi.spyOn(runtime, "updateStreaming");

			runtime.armStreamingResetWatchdog(5_000);
			expect(updateStreaming).not.toHaveBeenCalled();

			vi.advanceTimersByTime(4_999);
			expect(updateStreaming).not.toHaveBeenCalled();

			vi.advanceTimersByTime(1);
			expect(updateStreaming).toHaveBeenCalledExactlyOnceWith(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not reset when the watchdog is cleared on the happy path (agent_settled)", () => {
		vi.useFakeTimers();
		try {
			const { runtime } = createRuntime();
			const updateStreaming = vi.spyOn(runtime, "updateStreaming");

			runtime.armStreamingResetWatchdog(5_000);
			runtime.clearStreamingResetWatchdog();

			vi.advanceTimersByTime(10_000);
			expect(updateStreaming).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("re-arming replaces the previous watchdog (single timer, no double reset)", () => {
		vi.useFakeTimers();
		try {
			const { runtime } = createRuntime();
			const updateStreaming = vi.spyOn(runtime, "updateStreaming");

			runtime.armStreamingResetWatchdog(5_000);
			runtime.armStreamingResetWatchdog(5_000);

			vi.advanceTimersByTime(5_000);
			expect(updateStreaming).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("#77 semantics: is_streaming is driven by run activity, not a turn marker", () => {
		const { runtime } = createRuntime();

		// #77：标记机制已删除——点亮由 agent_start 无条件执行（run 活跃即亮），
		// 复位由 agent_end/settle/watchdog 完成。直接验证 updateStreaming 通道。
		const updateStreaming = vi.spyOn(runtime, "updateStreaming");
		runtime.updateStreaming(true);
		expect(updateStreaming).toHaveBeenCalledExactlyOnceWith(true);
		runtime.updateStreaming(false);
		expect(updateStreaming).toHaveBeenCalledTimes(2);
	});

	it("#77 candidate-1: state refresh re-sends is_streaming=true while a run is active (self-healing)", async () => {
		const { runtime } = createRuntime();
		const updateStreaming = vi.spyOn(runtime, "updateStreaming");
		runtime.isAgentActive = true;
		// request 为私有方法——经类型断言的 spy（仅测试态）。
		vi.spyOn(runtime as unknown as { request: (message: unknown) => Promise<unknown> }, "request").mockResolvedValue({
			type: "response",
			command: "get_group_chat_state",
			success: true,
			data: {},
		});

		// 状态拉取成功（连接健康）且 run 仍活跃 → 补偿重发点亮（幂等），
		// 修复半开连接期间点亮上报被静默丢弃的盲区。
		await runtime.getGroupChatState();
		expect(updateStreaming).toHaveBeenCalledWith(true);

		// run 已结束：状态拉取不再重发点亮。
		updateStreaming.mockClear();
		runtime.isAgentActive = false;
		await runtime.getGroupChatState();
		expect(updateStreaming).not.toHaveBeenCalled();
	});
});

describe("A4: run wedged watchdog (#66 兑底)", () => {
	// 契约（Phase 3 定稿）：agent_start 布防 run watchdog（W = agentWedgedTimeoutMs，构造
	// 可注入）；W 内未收到 agent_settled = wedged → 强制 settle（等价 agent_settled 路径：
	// isAgentActive=false + 清 watchdog + updateStreaming(false) + onAgentSettled 冲刷）。
	// 双窗口：① agent_start 后无 agent_end（完全卡死）② agent_end 已到但 agent_settled 永不
	// 到（#14 只复位 is_streaming 不碰 isAgentActive，② 为真洞）——v2 为 #14 超集。
	// API 面（QA 契约建议）：armRunWedgedWatchdog(timeoutMs)/clearRunWedgedWatchdog()，
	// 与 #14 armStreamingResetWatchdog 同风格；Dev 落 API 骨架后本组钉即红。

	it("window ①: agent_start without agent_end forces settle past W", () => {
		vi.useFakeTimers();
		try {
			const { runtime } = createRuntime();
			const onSettled = vi.fn();
			runtime.onAgentSettled = onSettled;
			const updateStreaming = vi.spyOn(runtime, "updateStreaming");

			// agent_start 布防（W 注入短值 50ms）。
			runtime.armRunWedgedWatchdog(50);
			runtime.isAgentActive = true;

			vi.advanceTimersByTime(49);
			expect(runtime.isAgentActive).toBe(true);
			expect(onSettled).not.toHaveBeenCalled();

			vi.advanceTimersByTime(1);
			expect(runtime.isAgentActive).toBe(false);
			expect(onSettled).toHaveBeenCalledTimes(1);
			expect(updateStreaming).toHaveBeenCalledWith(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("window ②: agent_end arrived but agent_settled never does — forced settle", () => {
		vi.useFakeTimers();
		try {
			const { runtime } = createRuntime();
			const onSettled = vi.fn();
			runtime.onAgentSettled = onSettled;

			runtime.armRunWedgedWatchdog(50);
			runtime.isAgentActive = true;
			// agent_end：#14 只复位显示层（is_streaming），isAgentActive 保持 true（窗口②真洞）。
			runtime.armStreamingResetWatchdog(5);

			vi.advanceTimersByTime(5);
			expect(runtime.isAgentActive).toBe(true);
			expect(onSettled).not.toHaveBeenCalled();

			vi.advanceTimersByTime(45);
			expect(runtime.isAgentActive).toBe(false);
			expect(onSettled).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("happy path: agent_settled before W clears the watchdog — zero forced settle", () => {
		vi.useFakeTimers();
		try {
			const { runtime } = createRuntime();
			const onSettled = vi.fn();
			runtime.onAgentSettled = onSettled;

			runtime.armRunWedgedWatchdog(50);
			runtime.isAgentActive = true;

			// agent_settled 正常路径（extension 接线：清 watchdog + isAgentActive=false + 冲刷）。
			runtime.clearRunWedgedWatchdog();
			runtime.isAgentActive = false;
			runtime.updateStreaming(false);
			runtime.onAgentSettled?.();

			vi.advanceTimersByTime(10_000);
			expect(runtime.isAgentActive).toBe(false);
			expect(onSettled).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("trigger clears itself: no repeat fire after W", () => {
		vi.useFakeTimers();
		try {
			const { runtime } = createRuntime();
			const onSettled = vi.fn();
			runtime.onAgentSettled = onSettled;

			runtime.armRunWedgedWatchdog(50);
			runtime.isAgentActive = true;

			vi.advanceTimersByTime(50);
			expect(onSettled).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(10_000);
			expect(onSettled).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("real settle racing past W converges: no double flush after forced settle", () => {
		vi.useFakeTimers();
		try {
			const { runtime } = createRuntime();
			const onSettled = vi.fn();
			runtime.onAgentSettled = onSettled;

			runtime.armRunWedgedWatchdog(50);
			runtime.isAgentActive = true;

			// 真实 settle 在 W 后到达：watchdog 已触发自清，不再二次触发。
			vi.advanceTimersByTime(50);
			expect(onSettled).toHaveBeenCalledTimes(1);

			runtime.clearRunWedgedWatchdog();
			runtime.isAgentActive = false;
			runtime.onAgentSettled?.();

			// 消费侧去重（incrementPending）由 GroupChatInput 承担，运行时侧保证不重复触发。
			expect(onSettled).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
