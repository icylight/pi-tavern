import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { GroupChatInput } from "../../../src/character/group-chat-input.js";
import type { PublicMessage, ServerMessage } from "../../../src/protocol/messages.js";

// #85 J1 钉测（QA，2026-08-03）：长工具循环忙态投递回归。
// 场景：run 活跃（长工具循环）中，每轮工具调用间隙收到一条群聊通知——
// 忙态契约要求立即拉取 + steer 投递 + 游标推进，全程无重复无遗漏。
// 与 T2（两轮）的区别：N=25 轮压力形态，验证长循环下逐轮投递不退化。
// 绿 = 现有实现钉住；红基线 = 循环投递路径任一环断裂（重复/遗漏/游标回退）。

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

function aPublicMessage(sequence: number): PublicMessage {
	return {
		type: "public_message",
		event_id: `evt-${sequence}`,
		sequence,
		timestamp: "2026-01-01T00:00:00.000Z",
		sender: { type: "user_persona" },
		content: `msg-${sequence}`,
		round: { round_max_messages: 10, used_messages: 0, remaining_messages: 10 },
	} as PublicMessage;
}

describe("GroupChatInput #85 J1 长工具循环忙态投递回归", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("J1: 25 轮忙态通知逐轮拉取+steer 投递，无重复无遗漏、游标单调、settle 幂等", async () => {
		vi.useFakeTimers();

		const N = 25;
		let cursor = 6;
		let latestSeq = 6;
		const fetchSinceCalls: number[] = [];
		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		runtime.loadCursor = vi.fn(() => cursor);
		runtime.saveCursor = vi.fn((value: number) => {
			cursor = value;
		});
		runtime.fetchMessagesSince = vi.fn(async (since: number) => {
			fetchSinceCalls.push(since);
			const messages: PublicMessage[] = [];
			for (let seq = since + 1; seq <= latestSeq; seq += 1) {
				messages.push(aPublicMessage(seq));
			}
			return { messages, latestSequence: latestSeq, totalMessages: latestSeq };
		});
		runtime.isAgentActive = true;

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		// 长工具循环：每轮通知到达（工具调用间隙）→ flush 微任务（本轮拉取+投递完成）。
		for (let k = 1; k <= N; k += 1) {
			latestSeq = 6 + k;
			handler({
				type: "group_chat_update",
				latest_sequence: latestSeq,
				preview_messages: [],
				total_messages: latestSeq,
			} as unknown as ServerMessage);
			await vi.advanceTimersByTimeAsync(0);
		}

		// ① 每轮一次独立拉取，since 严格递增无重叠（游标单调的前提）。
		expect(fetchSinceCalls).toEqual(Array.from({ length: N }, (_, i) => 6 + i));

		// ② 每轮一次 steer 投递，序列恰好为 [6+k]——全程无重复无遗漏。
		expect(pi.sendMessage).toHaveBeenCalledTimes(N);
		const calls = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls as [unknown, unknown][];
		const delivered: number[] = [];
		calls.forEach(([payload, options], index) => {
			const message = payload as { details: { events: Array<{ sequence?: number }> } };
			const sequences = message.details.events.map((e) => e.sequence).sort((a, b) => (a ?? 0) - (b ?? 0));
			expect(sequences).toEqual([7 + index]);
			expect((options as { deliverAs: string }).deliverAs).toBe("steer");
			delivered.push(...(sequences as number[]));
		});
		// 全局投递序列 = [7..31]：无重复、无遗漏。
		expect(delivered).toEqual(Array.from({ length: N }, (_, i) => 7 + i));
		expect(new Set(delivered).size).toBe(N);

		// ③ 游标单调推进 N 次：6→7→…→31。
		const saved = (runtime.saveCursor as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as number);
		expect(saved).toEqual(Array.from({ length: N }, (_, i) => 7 + i));

		// ④ settle 幂等：游标已在最新，补拉为空 → 无额外投递。
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(pi.sendMessage).toHaveBeenCalledTimes(N);
		expect(cursor).toBe(6 + N);

		input.stop();
	});
});
