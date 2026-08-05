import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { ABORT_CONTROL_CUSTOM_TYPE, GroupChatInput } from "../../../src/character/group-chat-input.js";
import type { PublicMessage, ServerMessage } from "../../../src/protocol/messages.js";

function createMockRuntime(characterId = "dev"): CharacterRuntime {
	return {
		groupChatId: "group-1",
		character: {
			characterId,
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
		loadCursor: () => null,
		saveCursor: () => undefined,
		fetchMessagesSince: async () => ({ messages: [], latestSequence: 0, totalMessages: 0 }),
		refreshGroupChatState: async () => undefined,
	} as unknown as CharacterRuntime;
}

function createMockPi(): ExtensionAPI {
	return { sendMessage: vi.fn() } as unknown as ExtensionAPI;
}

function publicMessage(sequence: number, characterId?: string): PublicMessage {
	return {
		type: "public_message",
		event_id: `evt-${sequence}`,
		sequence,
		timestamp: "2026-08-05T00:00:00.000Z",
		sender: characterId
			? { type: "character", character_id: characterId, name: characterId }
			: { type: "user_persona" },
		content: `message-${sequence}`,
		round: { round_max_messages: 10, used_messages: sequence, remaining_messages: 10 - sequence },
	} as PublicMessage;
}

function update(latestSequence: number, previewMessages: PublicMessage[]): ServerMessage {
	return {
		type: "group_chat_update",
		latest_sequence: latestSequence,
		preview_messages: previewMessages,
		total_messages: latestSequence,
	} as ServerMessage;
}

describe("GroupChatInput steer 安全边界打断", () => {
	afterEach(() => vi.useRealTimers());

	it("忙态通知只排隐藏令牌，安全边界才 abort，settled 后 followUp 拉全", async () => {
		vi.useFakeTimers();
		let cursor = 0;
		const runtime = createMockRuntime();
		runtime.isAgentActive = true;
		runtime.loadCursor = vi.fn(() => cursor);
		runtime.saveCursor = vi.fn((value: number) => {
			cursor = value;
		});
		runtime.fetchMessagesSince = vi.fn(async () => ({
			messages: [publicMessage(1), publicMessage(2)],
			latestSequence: 2,
			totalMessages: 2,
		}));
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();

		runtime.onEnvironmentMessage?.(update(2, [publicMessage(1), publicMessage(2)]));

		expect(runtime.fetchMessagesSince).not.toHaveBeenCalled();
		expect(runtime.saveCursor).not.toHaveBeenCalled();
		expect(pi.sendMessage).toHaveBeenCalledWith(
			{ customType: ABORT_CONTROL_CUSTOM_TYPE, content: "", display: false },
			{ triggerTurn: true, deliverAs: "steer" },
		);

		const abort = vi.fn();
		expect(input.consumeAbortControlToken(abort)).toBe(true);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(runtime.fetchMessagesSince).not.toHaveBeenCalled();

		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);

		expect(runtime.fetchMessagesSince).toHaveBeenCalledTimes(1);
		expect(runtime.saveCursor).toHaveBeenCalledWith(2);
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
		expect((pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]).toMatchObject({
			deliverAs: "followUp",
			triggerTurn: true,
		});
		input.stop();
	});

	it("密集通知合并为一个令牌和一次 abort", () => {
		const runtime = createMockRuntime();
		runtime.isAgentActive = true;
		runtime.loadCursor = vi.fn(() => 0);
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();

		runtime.onEnvironmentMessage?.(update(1, [publicMessage(1)]));
		runtime.onEnvironmentMessage?.(update(2, [publicMessage(1), publicMessage(2)]));
		runtime.onEnvironmentMessage?.(update(3, [publicMessage(1), publicMessage(2), publicMessage(3)]));

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const abort = vi.fn();
		expect(input.consumeAbortControlToken(abort)).toBe(true);
		expect(input.consumeAbortControlToken(abort)).toBe(false);
		expect(abort).toHaveBeenCalledTimes(1);
		input.stop();
	});

	it("超过 preview 上限的连续自身消息不排令牌，settled 后消费水位且不生成输入", async () => {
		vi.useFakeTimers();
		let cursor = 0;
		const runtime = createMockRuntime("dev");
		runtime.isAgentActive = true;
		runtime.loadCursor = vi.fn(() => cursor);
		runtime.saveCursor = vi.fn((value: number) => {
			cursor = value;
		});
		runtime.fetchMessagesSince = vi.fn(async () => ({
			messages: [1, 2, 3, 4].map((sequence) => publicMessage(sequence, "dev")),
			latestSequence: 4,
			totalMessages: 4,
		}));
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();

		runtime.onEnvironmentMessage?.(
			update(
				4,
				[2, 3, 4].map((sequence) => publicMessage(sequence, "dev")),
			),
		);
		expect(pi.sendMessage).not.toHaveBeenCalled();

		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(runtime.saveCursor).toHaveBeenCalledWith(4);
		expect(pi.sendMessage).not.toHaveBeenCalled();
		input.stop();
	});

	it("完整混合窗口中存在他人消息时仍排打断令牌", () => {
		const runtime = createMockRuntime("dev");
		runtime.isAgentActive = true;
		runtime.loadCursor = vi.fn(() => 0);
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();

		runtime.onEnvironmentMessage?.(update(2, [publicMessage(1, "dev"), publicMessage(2)]));
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		input.stop();
	});

	it("闲态窗口内启动 run：已确认他人消息时到期补排令牌", async () => {
		vi.useFakeTimers();
		let cursor = 0;
		const runtime = createMockRuntime("dev");
		runtime.loadCursor = vi.fn(() => cursor);
		runtime.saveCursor = vi.fn((value: number) => {
			cursor = value;
		});
		runtime.fetchMessagesSince = vi.fn(async () => ({
			messages: [publicMessage(1)],
			latestSequence: 1,
			totalMessages: 1,
		}));
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi, 1000);
		input.start();

		// 通知到达时 idle，只开启固定窗口；窗口期间由私有提示等来源启动 run。
		runtime.onEnvironmentMessage?.(update(1, [publicMessage(1)]));
		expect(pi.sendMessage).not.toHaveBeenCalled();
		runtime.isAgentActive = true;
		await vi.advanceTimersByTimeAsync(1000);

		expect(runtime.fetchMessagesSince).not.toHaveBeenCalled();
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		expect(pi.sendMessage).toHaveBeenCalledWith(
			{ customType: ABORT_CONTROL_CUSTOM_TYPE, content: "", display: false },
			{ triggerTurn: true, deliverAs: "steer" },
		);
		expect(input.consumeAbortControlToken(vi.fn())).toBe(true);

		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(runtime.fetchMessagesSince).toHaveBeenCalledOnce();
		expect(cursor).toBe(1);
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
		input.stop();
	});

	it("闲态窗口内启动 run：preview 不完整且含自身消息时不误打断", async () => {
		vi.useFakeTimers();
		let cursor = 0;
		const runtime = createMockRuntime("dev");
		runtime.loadCursor = vi.fn(() => cursor);
		runtime.saveCursor = vi.fn((value: number) => {
			cursor = value;
		});
		runtime.fetchMessagesSince = vi.fn(async () => ({
			messages: [publicMessage(1), ...[2, 3, 4].map((sequence) => publicMessage(sequence, "dev"))],
			latestSequence: 4,
			totalMessages: 4,
		}));
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi, 1000);
		input.start();

		runtime.onEnvironmentMessage?.(
			update(
				4,
				[2, 3, 4].map((sequence) => publicMessage(sequence, "dev")),
			),
		);
		runtime.isAgentActive = true;
		await vi.advanceTimersByTimeAsync(1000);

		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(input.consumeAbortControlToken(vi.fn())).toBe(false);
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);

		expect(runtime.fetchMessagesSince).toHaveBeenCalledOnce();
		expect(cursor).toBe(4);
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		expect((pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({ deliverAs: "followUp" });
		input.stop();
	});

	it("reload 后立即消费旧 run 留下的忙态未读", async () => {
		vi.useFakeTimers();
		let cursor = 0;
		const runtime = createMockRuntime();
		runtime.isAgentActive = true;
		runtime.loadCursor = vi.fn(() => cursor);
		runtime.saveCursor = vi.fn((value: number) => {
			cursor = value;
		});
		runtime.fetchMessagesSince = vi.fn(async () => ({
			messages: [publicMessage(1)],
			latestSequence: 1,
			totalMessages: 1,
		}));
		const input = new GroupChatInput(runtime, createMockPi());
		input.start();
		runtime.onEnvironmentMessage?.(update(1, [publicMessage(1)]));

		const snapshot = input.snapshotForReload();
		expect(snapshot.incrementPending).toBe(true);
		input.stop();

		// reload 终止旧 run；新 runtime 接管时处于 idle，应直接拉全，不再等待通知。
		runtime.isAgentActive = false;
		const resumedPi = createMockPi();
		const resumed = new GroupChatInput(runtime, resumedPi);
		resumed.start();
		resumed.restoreFromReload(snapshot);
		await vi.advanceTimersByTimeAsync(0);

		expect(runtime.fetchMessagesSince).toHaveBeenCalledOnce();
		expect(cursor).toBe(1);
		expect(resumedPi.sendMessage).toHaveBeenCalledOnce();
		expect((resumedPi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
			deliverAs: "followUp",
		});
		resumed.stop();
	});

	it("跨版本 reload 对缺少新字段的 legacy handoff 保守补拉一次", async () => {
		vi.useFakeTimers();
		const runtime = createMockRuntime();
		runtime.fetchMessagesSince = vi.fn(async () => ({
			messages: [],
			latestSequence: 0,
			totalMessages: 0,
		}));
		const input = new GroupChatInput(runtime, createMockPi());
		input.start();

		input.restoreFromReload({ pendingEvents: [], debounceDueAt: null });
		await vi.advanceTimersByTimeAsync(0);

		expect(runtime.fetchMessagesSince).toHaveBeenCalledOnce();
		input.stop();
	});

	it("成员变化不进入 Agent 输入，白板更新仍正常投递", async () => {
		vi.useFakeTimers();
		const runtime = createMockRuntime();
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();

		runtime.onEnvironmentMessage?.({
			type: "character_joined",
			character: { character_id: "qa", name: "QA" },
		} as ServerMessage);
		runtime.onEnvironmentMessage?.({
			type: "character_left",
			character: { character_id: "qa", name: "QA", description: "Tests" },
			reason: "left",
		} as ServerMessage);
		await vi.advanceTimersByTimeAsync(1000);
		expect(pi.sendMessage).not.toHaveBeenCalled();

		runtime.onEnvironmentMessage?.({ type: "board_update", actor: "qa", action: "clear" } as ServerMessage);
		await vi.advanceTimersByTimeAsync(1000);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		input.stop();
	});
});
