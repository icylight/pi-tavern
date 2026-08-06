import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { GroupChatInput } from "../../../src/character/group-chat-input.js";
import type { PublicMessage, ServerMessage } from "../../../src/protocol/messages.js";

/**
 * #128 契约测试（Arch 属主，与 Dev 实现侧测试互补）。
 * 覆盖评审确认的边界：截断窗口全自身 → 数量未知但保守阻止；混合窗口只数
 * 明确可见的他人消息；旧帧水位知识不残留（新帧覆盖旧帧）。
 */

function createMockRuntime(
	overrides: { characterId?: string; loadCursor?: () => number | null } = {},
): CharacterRuntime {
	return {
		groupChatId: "group-1",
		character: {
			characterId: overrides.characterId ?? "arch",
			name: "Arch",
			description: "Architecture",
			path: "/chars/arch.md",
			prompt: "You are the architect.",
		},
		hasPublicMessages: false,
		onEnvironmentMessage: undefined,
		onAgentSettled: undefined,
		isAgentActive: false,
		loadCursor: overrides.loadCursor ?? (() => null),
		saveCursor: () => undefined,
		fetchMessagesSince: async () => ({ messages: [], latestSequence: 0, totalMessages: 0 }),
		refreshGroupChatState: async () => undefined,
	} as unknown as CharacterRuntime;
}

function createMockPi(): ExtensionAPI {
	return { sendMessage: vi.fn(async () => undefined) } as unknown as ExtensionAPI;
}

function aPublicMessage(
	sequence: number,
	senderType: "user_persona" | "character",
	characterId?: string,
): PublicMessage {
	return {
		jsonrpc: "2.0",
		method: "public_message",
		params: {
			event_id: `evt-${sequence}`,
			sequence,
			timestamp: "2026-01-01T00:00:00.000Z",
			sender:
				senderType === "user_persona"
					? { type: "user_persona" }
					: { type: "character", character_id: characterId ?? "other", name: "Other" },
			content: "Hello",
			round: { round_max_messages: 10, used_messages: 0, remaining_messages: 10 },
		},
	} as PublicMessage;
}

function aGroupChatUpdate(overrides: {
	latestSequence: number;
	previews: PublicMessage[];
	totalMessages?: number;
}): ServerMessage {
	return {
		jsonrpc: "2.0",
		method: "group_chat_update",
		params: {
			latest_sequence: overrides.latestSequence,
			preview_messages: overrides.previews,
			total_messages: overrides.totalMessages ?? overrides.latestSequence,
		},
	} as ServerMessage;
}

describe("契约：#128 unreadOthersProven 边界（Arch 属主）", () => {
	it("截断窗口全自身 → count=0 + exact:false，但按定稿保守阻止", () => {
		const runtime = createMockRuntime({ loadCursor: () => 1, characterId: "arch" });
		const input = new GroupChatInput(runtime, createMockPi());
		input.start();
		// 水位 5，游标 1，但 preview（最近 3 条）全为自身回显——截断导致
		// 更早窗口是否有他人消息不可知 → 按 #128 定稿保守阻止，拉全后再决策。
		runtime.onEnvironmentMessage?.(
			aGroupChatUpdate({
				latestSequence: 5,
				previews: [
					aPublicMessage(3, "character", "arch"),
					aPublicMessage(4, "character", "arch"),
					aPublicMessage(5, "character", "arch"),
				],
			}),
		);
		expect(input.unreadOthersProven()).toEqual({ shouldBlock: true, count: 0, exact: false });
		input.stop();
	});

	it("混合窗口（自身+他人）→ 只数他人，精确计数", () => {
		const runtime = createMockRuntime({ loadCursor: () => 3, characterId: "arch" });
		const input = new GroupChatInput(runtime, createMockPi());
		input.start();
		runtime.onEnvironmentMessage?.(
			aGroupChatUpdate({
				latestSequence: 5,
				previews: [aPublicMessage(4, "character", "arch"), aPublicMessage(5, "character", "qa")],
			}),
		);
		expect(input.unreadOthersProven()).toEqual({ shouldBlock: true, count: 1, exact: true });
		input.stop();
	});

	it("新帧覆盖旧帧：旧帧水位知识不残留（update 是累积水位）", () => {
		const runtime = createMockRuntime({ loadCursor: () => 5, characterId: "arch" });
		const input = new GroupChatInput(runtime, createMockPi());
		input.start();
		// 旧帧：水位 6，有他人未读（seq 6）
		runtime.onEnvironmentMessage?.(
			aGroupChatUpdate({ latestSequence: 6, previews: [aPublicMessage(6, "user_persona")] }),
		);
		expect(input.unreadOthersProven()).toEqual({ shouldBlock: true, count: 1, exact: true });
		// 新帧：水位 6 不变但 preview 全自身（他人消息已读/投递后水位知识刷新）
		runtime.onEnvironmentMessage?.(
			aGroupChatUpdate({ latestSequence: 6, previews: [aPublicMessage(6, "character", "arch")] }),
		);
		// 游标仍 5 → preview 内自身消息不算未读 → count=0
		expect(input.unreadOthersProven()).toEqual({ shouldBlock: false, count: 0, exact: true });
		input.stop();
	});

	it("preview 为空数组 + 水位高于游标 → count=0 + exact:false → 放行（无信息不误堵）", () => {
		const runtime = createMockRuntime({ loadCursor: () => 3 });
		const input = new GroupChatInput(runtime, createMockPi());
		input.start();
		runtime.onEnvironmentMessage?.(aGroupChatUpdate({ latestSequence: 5, previews: [] }));
		expect(input.unreadOthersProven()).toEqual({ shouldBlock: false, count: 0, exact: false });
		input.stop();
	});
});
