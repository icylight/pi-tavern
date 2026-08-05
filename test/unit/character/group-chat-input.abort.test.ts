import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { GroupChatInput } from "../../../src/character/group-chat-input.js";
import type { PublicMessage, ServerMessage } from "../../../src/protocol/messages.js";

// v0.5（abort-interrupt-delivery，User 2026-08-04 拍板）：
// 忙态消息到达即 abort 在途生成（steer 退出忙态链路），agent 空闲后按游标
// 拉全部未读重开。abort 触发点唯一 = 忙态 group_chat_update 分支。
// 本文件覆盖 abort 决策逻辑（内容 Dev 产出、落盘归 Arch/PM 协调）。

function createMockRuntime(
	overrides: {
		characterId?: string;
		groupChatId?: string;
		hasPublicMessages?: boolean;
		getGroupChatState?: () => Promise<unknown>;
	} = {},
): CharacterRuntime {
	return {
		groupChatId: overrides.groupChatId ?? "group-1",
		character: {
			characterId: overrides.characterId ?? "dev",
			name: "Developer",
			description: "Writes code",
			path: "/chars/dev.md",
			prompt: "You are a developer.",
		},
		getGroupChatState: overrides.getGroupChatState ?? (async () => ({})),
		hasPublicMessages: overrides.hasPublicMessages ?? false,
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
	return {
		sendMessage: vi.fn(async () => undefined),
	} as unknown as ExtensionAPI;
}

function aPublicMessage(senderType: "user_persona", overrides?: Partial<PublicMessage>): PublicMessage {
	return {
		type: "public_message",
		event_id: "evt-1",
		sequence: 1,
		timestamp: "2026-01-01T00:00:00.000Z",
		sender: { type: senderType },
		content: "Hello",
		round: { round_max_messages: 10, used_messages: 0, remaining_messages: 10 },
		...overrides,
	} as PublicMessage;
}

function aGroupChatUpdate(latestSequence: number, previewMessages: PublicMessage[] = []): ServerMessage {
	return {
		type: "group_chat_update",
		latest_sequence: latestSequence,
		preview_messages: previewMessages,
		total_messages: latestSequence,
	} as unknown as ServerMessage;
}

describe("GroupChatInput abort-interrupt-delivery (v0.5)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("busy arrival aborts the in-flight run once, then delivers via steer", async () => {
		vi.useFakeTimers();

		let cursor = 0;
		const runtime = createMockRuntime({ getGroupChatState: async () => ({}) });
		runtime.loadCursor = vi.fn(() => cursor);
		runtime.saveCursor = vi.fn((value: number) => {
			cursor = value;
		});
		runtime.fetchMessagesSince = vi.fn(async (since: number) => ({
			messages: [1, 2].filter((seq) => seq > since).map((seq) => aPublicMessage("user_persona", { sequence: seq })),
			latestSequence: 2,
			totalMessages: 2,
		}));
		runtime.isAgentActive = true;
		const abortAgent = vi.fn(() => true);
		runtime.abortAgent = abortAgent;
		const fetchMessagesSince = vi.spyOn(runtime, "fetchMessagesSince");

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		// 忙态：update 到达 → 立即 abort；abort 与 settle 之间不得拉取/推进游标。
		handler(aGroupChatUpdate(2));
		await vi.advanceTimersByTimeAsync(0);

		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(fetchMessagesSince).not.toHaveBeenCalled();
		expect(runtime.saveCursor).not.toHaveBeenCalled();
		expect(abortAgent).toHaveBeenCalledTimes(1);

		// 真实生命周期在 abort 完成后发 agent_settled；此时才拉全并 followUp 重开。
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, { deliverAs?: string }];
		expect(call[1]?.deliverAs).toBe("followUp");
		expect(runtime.saveCursor).toHaveBeenCalledWith(2);

		input.stop();
	});

	it("does not abort when the run settled before the busy arrival path", async () => {
		vi.useFakeTimers();

		let cursor = 0;
		const runtime = createMockRuntime({ getGroupChatState: async () => ({}) });
		runtime.loadCursor = vi.fn(() => cursor);
		runtime.saveCursor = vi.fn((value: number) => {
			cursor = value;
		});
		runtime.fetchMessagesSince = vi.fn(async (since: number) => ({
			messages: [1].filter((seq) => seq > since).map((seq) => aPublicMessage("user_persona", { sequence: seq })),
			latestSequence: 1,
			totalMessages: 1,
		}));
		// 闲态（agent 空闲）：走 idle 路径（debounce → followUp），不 abort。
		runtime.isAgentActive = false;
		const abortAgent = vi.fn(() => true);
		runtime.abortAgent = abortAgent;

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		handler(aGroupChatUpdate(1));
		// 闲态：1s 聚合窗口到期才拉取。
		await vi.advanceTimersByTimeAsync(1000);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, { deliverAs?: string }];
		expect(call[1]?.deliverAs).toBe("followUp");
		// 空闲不打断（口径边界：idle 不 abort）。
		expect(abortAgent).not.toHaveBeenCalled();

		input.stop();
	});

	it("ignores a state-only update whose waterline is already at the cursor", async () => {
		const runtime = createMockRuntime();
		runtime.loadCursor = vi.fn(() => 4);
		runtime.isAgentActive = true;
		const abortAgent = vi.fn(() => true);
		runtime.abortAgent = abortAgent;
		const fetchMessagesSince = vi.spyOn(runtime, "fetchMessagesSince");
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();

		runtime.onEnvironmentMessage?.(aGroupChatUpdate(4));

		expect(abortAgent).not.toHaveBeenCalled();
		expect(fetchMessagesSince).not.toHaveBeenCalled();
		expect(pi.sendMessage).not.toHaveBeenCalled();
		input.stop();
	});

	it("ignores a fully covered self-only update without aborting the active run", async () => {
		const runtime = createMockRuntime({ characterId: "dev" });
		runtime.loadCursor = vi.fn(() => 1);
		runtime.isAgentActive = true;
		const abortAgent = vi.fn(() => true);
		runtime.abortAgent = abortAgent;
		const fetchMessagesSince = vi.spyOn(runtime, "fetchMessagesSince");
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const ownMessage = aPublicMessage("user_persona", {
			sequence: 2,
			sender: { type: "character", character_id: "dev", name: "Developer" },
		});

		runtime.onEnvironmentMessage?.(aGroupChatUpdate(2, [ownMessage]));

		expect(abortAgent).not.toHaveBeenCalled();
		expect(fetchMessagesSince).not.toHaveBeenCalled();
		expect(pi.sendMessage).not.toHaveBeenCalled();
		input.stop();
	});

	it("aborts on every busy arrival with no cooldown (dense-interrupt semantics)", async () => {
		vi.useFakeTimers();

		let cursor = 0;
		const runtime = createMockRuntime({ getGroupChatState: async () => ({}) });
		runtime.loadCursor = vi.fn(() => cursor);
		runtime.saveCursor = vi.fn((value: number) => {
			cursor = value;
		});
		runtime.fetchMessagesSince = vi.fn(async (since: number) => ({
			messages: [1, 2].filter((seq) => seq > since).map((seq) => aPublicMessage("user_persona", { sequence: seq })),
			latestSequence: 2,
			totalMessages: 2,
		}));
		runtime.isAgentActive = true;
		const abortAgent = vi.fn(() => true);
		runtime.abortAgent = abortAgent;

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		// 两次密集忙态到达：每次都 abort（无冷却）。
		handler(aGroupChatUpdate(1));
		await vi.advanceTimersByTimeAsync(0);
		handler(aGroupChatUpdate(2));
		await vi.advanceTimersByTimeAsync(0);

		// 每次忙态到达恰好一次 abort（无冷却、无双触发）。
		expect(abortAgent).toHaveBeenCalledTimes(2);
		// 两次 update 在同一被打断 run 内合并，settle 前不拉取、不推进游标。
		expect(runtime.fetchMessagesSince).not.toHaveBeenCalled();
		expect(runtime.saveCursor).not.toHaveBeenCalled();

		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, { deliverAs?: string }];
		expect(call[1]?.deliverAs).toBe("followUp");
		expect(runtime.saveCursor).toHaveBeenCalledWith(2);

		input.stop();
	});

	it("falls back to immediate delivery when abort was not requested", async () => {
		vi.useFakeTimers();

		let cursor = 0;
		const runtime = createMockRuntime({ getGroupChatState: async () => ({}) });
		runtime.loadCursor = vi.fn(() => cursor);
		runtime.saveCursor = vi.fn((value: number) => {
			cursor = value;
		});
		runtime.fetchMessagesSince = vi.fn(async (since: number) => ({
			messages: [1].filter((seq) => seq > since).map((seq) => aPublicMessage("user_persona", { sequence: seq })),
			latestSequence: 1,
			totalMessages: 1,
		}));
		runtime.isAgentActive = true;
		// pi 已经 idle、runtime 标志尚未 settle 的竞态：abort 回调明确返回 false。
		runtime.abortAgent = vi.fn(() => false);

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		handler(aGroupChatUpdate(1));
		await vi.advanceTimersByTimeAsync(0);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(runtime.saveCursor).toHaveBeenCalledWith(1);

		input.stop();
	});
});
