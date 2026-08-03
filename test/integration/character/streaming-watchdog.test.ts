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

function createRuntime(): {
	runtime: CharacterRuntime;
	socket: ReturnType<typeof createFakeSocket>["socket"];
	closeSocket: () => void;
} {
	const { socket, handlers } = createFakeSocket();
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
	const closeSocket = handlers.close;
	if (!closeSocket) {
		throw new Error("CharacterRuntime did not register a close handler");
	}
	return { runtime, socket, closeSocket };
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
		const mockRequest = vi.spyOn(runtime as unknown as { request: (message: unknown) => Promise<unknown> }, "request");

		// 场景 A（#83 收敛修正）：快照中本角色 is_streaming == false（点亮确实
		// 丢失）且 run 活跃 → 补发点亮（自愈保留）。
		mockRequest.mockResolvedValueOnce({
			type: "response",
			command: "get_group_chat_state",
			success: true,
			data: {
				online_characters: [
					{ character_id: "c", name: "self", is_self: true, is_streaming: false, hand_raised: false },
				],
			},
		});
		await runtime.getGroupChatState();
		expect(updateStreaming).toHaveBeenCalledWith(true);

		// 场景 B（#83 收敛修正）：快照已是 true（状态一致）→ 不补发——
		// 自激循环在此终止（原无条件补发 + creator 无条件广播 = 风暴掉线根因）。
		updateStreaming.mockClear();
		mockRequest.mockResolvedValueOnce({
			type: "response",
			command: "get_group_chat_state",
			success: true,
			data: {
				online_characters: [{ character_id: "c", name: "self", is_self: true, is_streaming: true, hand_raised: false }],
			},
		});
		await runtime.getGroupChatState();
		expect(updateStreaming).not.toHaveBeenCalled();

		// 场景 C：run 已结束 → 无论快照状态都不补发。
		updateStreaming.mockClear();
		runtime.isAgentActive = false;
		mockRequest.mockResolvedValueOnce({
			type: "response",
			command: "get_group_chat_state",
			success: true,
			data: {
				online_characters: [
					{ character_id: "c", name: "self", is_self: true, is_streaming: false, hand_raised: false },
				],
			},
		});
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

describe("connection-closed resilience（死连接点火= uncaughtException 根因回归）", () => {
	// 线上两例崩溃同源（用户 2026-08 报告）：连接先断（pi 退出竞态/心跳超时），
	// ① agent_settled→settleRun 把异常炸进 ExtensionRunner.emit（报错但不致命）；
	// ② agent_end 布防的流式复位定时器在 socket 置空后点火——定时器内 throw =
	// uncaughtException = 杀死整个 pi 进程。双修复：finishDisconnected 拆定时器
	// + updateStreaming 对关连接静默跳过（尽力而为，同 refreshGroupChatState）。

	it("disconnect clears the armed streaming watchdog — timer never fires on a dead connection", () => {
		vi.useFakeTimers();
		try {
			const { runtime, socket, closeSocket } = createRuntime();
			const updateStreaming = vi.spyOn(runtime, "updateStreaming");

			runtime.armStreamingResetWatchdog(5_000);
			// 连接先断（onClose → finishDisconnected）：定时器必须被拆除。
			closeSocket();
			socket.send.mockClear();

			vi.advanceTimersByTime(10_000);
			expect(updateStreaming).not.toHaveBeenCalled();
			expect(socket.send).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("settleRun after disconnect is a silent no-op — never throws into the extension emit", () => {
		const { runtime, socket, closeSocket } = createRuntime();

		// 模拟 agent_settled 在连接断开后才到达（agent-lifecycle 接线路径）。
		closeSocket();
		socket.send.mockClear();

		expect(() => runtime.settleRun()).not.toThrow();
		expect(socket.send).not.toHaveBeenCalled();
	});

	it("disconnect clears the run wedged watchdog — no forced settle on a dead runtime", () => {
		vi.useFakeTimers();
		try {
			const { runtime, closeSocket } = createRuntime();
			const onSettled = vi.fn();
			runtime.onAgentSettled = onSettled;

			runtime.armRunWedgedWatchdog(50);
			runtime.isAgentActive = true;
			closeSocket();

			vi.advanceTimersByTime(10_000);
			expect(onSettled).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
	it("#90 W1-b: agent_end→continue 后 watchdog 不误灭活跃 run 的灯（isAgentActive 守卫）", () => {
		// User 观察（2026-08-03）：群聊面板「正在工作」run 中不亮——根因 =
		// agent_end 布防 5s 显示 watchdog 后 continue → agent_start 再亮但
		// 不清定时器（W1-a 接线修复），且回调无 isAgentActive 守卫（本钉）：
		// 定时器到点时 run 仍活跃 → 必须跳过灭灯（双保险之二）。
		// 红基线（当前实现）：回调无条件 updateStreaming(false) → 误灭。
		vi.useFakeTimers();
		try {
			const { runtime } = createRuntime();
			const updateStreaming = vi.spyOn(runtime, "updateStreaming");

			// run 活跃（agent_start 后）：亮灯；agent_end 布防 5s watchdog。
			runtime.isAgentActive = true;
			runtime.updateStreaming(true);
			runtime.armStreamingResetWatchdog(5_000);

			// 5s 到：watchdog 回调——run 仍活跃，不得灭灯。
			vi.advanceTimersByTime(5_000);
			expect(updateStreaming).not.toHaveBeenCalledWith(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("#90 W2 回归: 真悬挂（无 agent_start 续命）仍 5s 复位", () => {
		// W1 修复不得破坏 #14 防悬挂语义：agent_end 后无新 agent_start、
		// 无 settle → 5s 后仍灭灯。
		vi.useFakeTimers();
		try {
			const { runtime } = createRuntime();
			const updateStreaming = vi.spyOn(runtime, "updateStreaming");

			runtime.isAgentActive = false; // 悬挂：run 已死
			runtime.armStreamingResetWatchdog(5_000);
			vi.advanceTimersByTime(5_000);
			expect(updateStreaming).toHaveBeenCalledExactlyOnceWith(false);
		} finally {
			vi.useRealTimers();
		}
	});
