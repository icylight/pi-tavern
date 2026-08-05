import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { GroupChatInput } from "../../../src/character/group-chat-input.js";
import type { PublicMessage, ServerMessage } from "../../../src/protocol/messages.js";

// #83 会话侧投递挂起形态（PM 领办：13:44-48 Dev 会话零投递 8 分钟 → 会话侧链路）：
// settled 后拉取挂起（fetchMessagesSince 永不 resolve = WS 请求挂起的极端形态）时，
// 单飞行锁（fetchInFlight）不得并发拉取（S1）；挂起 resolve 后必须自愈——
// refetchRequested 补拉 + 投递（S2，锁不死、不丢）。
// 红绿：f2ac85f（#73 忙态立即拉取 + 单飞行锁）预期绿；d5aa913（Phase 3 忙态
// 只置标记不拉取）预期红 = #73 忙态契约变更钉死。

function createMockRuntime(
	overrides: {
		isAgentActive?: boolean;
		fetchMessagesSince?: () => Promise<{ messages: ServerMessage[]; latestSequence: number; totalMessages: number }>;
	} = {},
): CharacterRuntime {
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
		hasPublicMessages: false,
		onEnvironmentMessage: undefined,
		onAgentSettled: undefined,
		isAgentActive: overrides.isAgentActive ?? true,
		loadCursor: () => null,
		saveCursor: vi.fn(),
		fetchMessagesSince:
			overrides.fetchMessagesSince ?? (async () => ({ messages: [], latestSequence: 0, totalMessages: 0 })),
		refreshGroupChatState: async () => undefined,
	} as unknown as CharacterRuntime;
}

function createMockPi(): ExtensionAPI {
	return {
		sendMessage: vi.fn(async () => undefined),
	} as unknown as ExtensionAPI;
}

function aPublicMessage(sequence: number): ServerMessage {
	return {
		type: "public_message",
		event_id: `evt-${sequence}`,
		sequence,
		timestamp: "2026-01-01T00:00:00.000Z",
		sender: { type: "user_persona" },
		content: `Msg ${sequence}`,
		round: { round_max_messages: 10, used_messages: 0, remaining_messages: 10 },
	} as unknown as PublicMessage as ServerMessage;
}

// 忙态拉取由 group_chat_update（水位广播）触发（#68 契约），非 public_message。
function aGroupChatUpdate(latestSequence: number): ServerMessage {
	return {
		type: "group_chat_update",
		latest_sequence: latestSequence,
		preview_messages: [],
		total_messages: latestSequence,
	} as unknown as ServerMessage;
}

describe("GroupChatInput #83 会话侧投递挂起（单飞行锁形态）", () => {
	it("S1: 忙态拉取挂起期间，后续 update 不并发拉取、不投递（单飞行锁钉死）", async () => {
		let release: (() => void) | undefined;
		const stalled = new Promise<void>((resolveStalled) => {
			release = resolveStalled;
		});
		const fetch = vi.fn(async () => {
			await stalled;
			return { messages: [aPublicMessage(6)], latestSequence: 6, totalMessages: 1 };
		});
		const runtime = createMockRuntime({ fetchMessagesSince: fetch });
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage;
		expect(handler).toBeDefined();
		expect(release).toBeDefined();

		// 忙态 update 先排安全边界令牌，边界 abort 并 settled 后才开始拉取。
		handler?.(aGroupChatUpdate(6));
		expect(input.consumeAbortControlToken(vi.fn())).toBe(true);
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

		// 拉取挂起期间再次请求消费：单飞行 → 不并发拉取、不投递。
		input.markIncrementPending();
		runtime.onAgentSettled?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		release?.();
		input.stop();
	});

	it("S2: 拉取挂起 resolve 后自愈——refetch 补拉并投递（锁不死、不丢）", async () => {
		let release: (() => void) | undefined;
		const stalled = new Promise<void>((resolveStalled) => {
			release = resolveStalled;
		});
		let calls = 0;
		const fetch = vi.fn(async () => {
			calls += 1;
			if (calls === 1) {
				await stalled;
				return { messages: [aPublicMessage(6)], latestSequence: 6, totalMessages: 1 };
			}
			return { messages: [], latestSequence: 7, totalMessages: 0 };
		});
		const runtime = createMockRuntime({ fetchMessagesSince: fetch, isAgentActive: true });
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage;
		expect(handler).toBeDefined();
		expect(release).toBeDefined();

		handler?.(aGroupChatUpdate(6));
		expect(input.consumeAbortControlToken(vi.fn())).toBe(true);
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		// 挂起期间再次请求消费 → 置 refetchRequested。
		input.markIncrementPending();
		runtime.onAgentSettled?.();
		// 释放挂起 → 第一次拉取完成投递 [6]，do-while 见 refetchRequested 补拉
		release?.();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		expect(pi.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ details: expect.objectContaining({ character_id: "dev" }) }),
			expect.objectContaining({ deliverAs: "followUp" }),
		);
		expect(runtime.saveCursor).toHaveBeenCalledWith(6);

		input.stop();
	});

	it("S3: sendMessage 同步抛错（入队拒绝）→ 游标不推进（A5 双通道判定，settle 兜底重投）", async () => {
		const fetch = vi.fn(async () => ({ messages: [aPublicMessage(6)], latestSequence: 6, totalMessages: 1 }));
		const runtime = createMockRuntime({ fetchMessagesSince: fetch, isAgentActive: true });
		const pi = createMockPi();
		// 入队拒绝（pi 队列不可用/取消瞬间）的同步抛错形态
		(pi.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error("queue rejected");
		});
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage;
		expect(handler).toBeDefined();

		handler?.(aGroupChatUpdate(6));
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalled());

		// 投递失败（同步抛错）：游标不得推进——settle 从旧游标补拉重投（不丢）
		expect(runtime.saveCursor).not.toHaveBeenCalled();

		input.stop();
	});
});
