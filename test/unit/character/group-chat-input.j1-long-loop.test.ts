import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { GroupChatInput } from "../../../src/character/group-chat-input.js";
import type { PublicMessage, ServerMessage } from "../../../src/protocol/messages.js";

// #85 J1 长工具循环回归：密集通知只排一个隐藏令牌；安全边界 abort 后，
// settled 一次拉全并通过 followUp 重开，最终无重复无遗漏。

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
		jsonrpc: "2.0",
		method: "public_message",
		params: {
			event_id: `evt-${sequence}`,
			sequence,
			timestamp: "2026-01-01T00:00:00.000Z",
			sender: { type: "user_persona" },
			content: `msg-${sequence}`,
			round: { round_max_messages: 10, used_messages: 0, remaining_messages: 10 },
		},
	} as PublicMessage;
}

describe("GroupChatInput #85 J1 长工具循环忙态投递回归", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("J1: 25 轮忙态通知合并为一个令牌，settled 一次拉全且无重复遗漏", async () => {
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

		// 长工具循环期间密集到达 25 条通知：不提前拉正文。
		for (let k = 1; k <= N; k += 1) {
			latestSeq = 6 + k;
			handler({
				jsonrpc: "2.0",
				method: "group_chat_update",
				params: {
					latest_sequence: latestSeq,
					preview_messages: [],
					total_messages: latestSeq,
				},
			} as unknown as ServerMessage);
		}

		expect(fetchSinceCalls).toEqual([]);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(input.consumeAbortControlToken(vi.fn())).toBe(true);
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);

		expect(fetchSinceCalls).toEqual([6]);
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
		const delivery = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1] as [unknown, unknown];
		const message = delivery[0] as { details: { events: Array<{ params?: { sequence?: number } }> } };
		const delivered = message.details.events.map((event) => event.params?.sequence);
		expect(delivered).toEqual(Array.from({ length: N }, (_, index) => 7 + index));
		expect(new Set(delivered).size).toBe(N);
		expect((delivery[1] as { deliverAs: string }).deliverAs).toBe("followUp");
		expect(runtime.saveCursor).toHaveBeenCalledOnce();
		expect(runtime.saveCursor).toHaveBeenCalledWith(6 + N);
		expect(cursor).toBe(6 + N);

		input.stop();
	});
});
