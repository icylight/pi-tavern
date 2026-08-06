import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { CharacterRuntime as RealCharacterRuntime } from "../../../src/character/character-runtime.js";
import { GroupChatInput } from "../../../src/character/group-chat-input.js";
import type { PublicMessage, ServerMessage } from "../../../src/protocol/messages.js";
import { ERROR_CONNECTION_NOT_OPEN } from "../../../src/shared/messages.js";

/**
 * #128：speak 前置「未读先读」单测（Dev 属主实现侧）。
 * 契约：已证明他人未读或截断窗口需保守阻止 → 不发布/不耗配额/不举手，
 * 首拒 markIncrementPending，重复调用短告知；游标追平或水位未知 → 放行
 *（服务端 stale 兜底）。
 */

function createMockRuntime(
	overrides: { characterId?: string; loadCursor?: () => number | null } = {},
): CharacterRuntime {
	return {
		groupChatId: "group-1",
		character: {
			characterId: overrides.characterId ?? "dev",
			name: "Developer",
			description: "Writes code",
			path: "/chars/dev.md",
			prompt: "You are a developer.",
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

describe("GroupChatInput.unreadOthersProven（推导式判定，Arch ①）", () => {
	it("水位未知（无 update）→ undefined，不阻塞", () => {
		const runtime = createMockRuntime();
		const input = new GroupChatInput(runtime, createMockPi());
		input.start();
		expect(input.unreadOthersProven()).toBeUndefined();
		input.stop();
	});

	it("水位 ≤ 游标 → { count: 0, exact: true }，无未读", () => {
		const runtime = createMockRuntime({ loadCursor: () => 5 });
		const input = new GroupChatInput(runtime, createMockPi());
		input.start();
		runtime.onEnvironmentMessage?.(
			aGroupChatUpdate({ latestSequence: 5, previews: [aPublicMessage(5, "user_persona")] }),
		);
		expect(input.unreadOthersProven()).toEqual({ shouldBlock: false, count: 0, exact: true });
		input.stop();
	});

	it("preview 完整 + 他人消息 → 精确计数", () => {
		const runtime = createMockRuntime({ loadCursor: () => 3 });
		const input = new GroupChatInput(runtime, createMockPi());
		input.start();
		runtime.onEnvironmentMessage?.(
			aGroupChatUpdate({
				latestSequence: 5,
				previews: [aPublicMessage(4, "user_persona"), aPublicMessage(5, "character", "qa")],
			}),
		);
		expect(input.unreadOthersProven()).toEqual({ shouldBlock: true, count: 2, exact: true });
		input.stop();
	});

	it("preview 完整 + 全自身回显 → { count: 0, exact: true }，不阻塞", () => {
		const runtime = createMockRuntime({ loadCursor: () => 3, characterId: "dev" });
		const input = new GroupChatInput(runtime, createMockPi());
		input.start();
		runtime.onEnvironmentMessage?.(
			aGroupChatUpdate({
				latestSequence: 5,
				previews: [aPublicMessage(4, "character", "dev"), aPublicMessage(5, "character", "dev")],
			}),
		);
		expect(input.unreadOthersProven()).toEqual({ shouldBlock: false, count: 0, exact: true });
		input.stop();
	});

	it("preview 截断（不完整）→ 下界计数 + exact: false", () => {
		const runtime = createMockRuntime({ loadCursor: () => 3 });
		const input = new GroupChatInput(runtime, createMockPi());
		input.start();
		// expected = 5 - 3 = 2，但 preview 只含 1 条他人消息（截断）→ 下界 1
		runtime.onEnvironmentMessage?.(
			aGroupChatUpdate({
				latestSequence: 5,
				previews: [aPublicMessage(5, "character", "qa")],
			}),
		);
		expect(input.unreadOthersProven()).toEqual({ shouldBlock: true, count: 1, exact: false });
		input.stop();
	});

	it("游标追平后（已投递）→ 重新推导归零", () => {
		const runtime = createMockRuntime({ loadCursor: () => 3 });
		const input = new GroupChatInput(runtime, createMockPi());
		input.start();
		runtime.onEnvironmentMessage?.(
			aGroupChatUpdate({
				latestSequence: 5,
				previews: [aPublicMessage(4, "user_persona"), aPublicMessage(5, "character", "qa")],
			}),
		);
		expect(input.unreadOthersProven()).toEqual({ shouldBlock: true, count: 2, exact: true });
		// 投递成功 → 游标推进 → 同一水位知识重新推导
		(runtime as unknown as { loadCursor: () => number | null }).loadCursor = () => 5;
		expect(input.unreadOthersProven()).toEqual({ shouldBlock: false, count: 0, exact: true });
		input.stop();
	});
});

describe("CharacterRuntime.speak 前置判定（#128）", () => {
	it("已证明他人未读 → 首拒：unread_first + first + markIncrementPending 一次", async () => {
		const runtime = RealCharacterRuntime.prepare({
			groupChatId: "group-1",
			sessionId: "session-1",
			character: {
				characterId: "dev",
				name: "Developer",
				description: "Writes code",
				path: "/chars/dev.md",
				prompt: "You are a developer.",
			},
		});
		const markIncrementPending = vi.fn();
		runtime.groupChatInput = {
			unreadOthersProven: () => ({ shouldBlock: true, count: 2, exact: true }),
			markIncrementPending,
		} as unknown as GroupChatInput;

		const result = await runtime.speak("hello");
		expect(result).toEqual({
			published: false,
			reason: "unread_first",
			first: true,
			unreadCount: 2,
			unreadExact: true,
		});
		expect(markIncrementPending).toHaveBeenCalledTimes(1);
	});

	it("截断窗口发送者未知 → 保守首拒但不伪造未读数量", async () => {
		const runtime = RealCharacterRuntime.prepare({
			groupChatId: "group-1",
			sessionId: "session-1",
			character: {
				characterId: "dev",
				name: "Developer",
				description: "Writes code",
				path: "/chars/dev.md",
				prompt: "You are a developer.",
			},
		});
		const markIncrementPending = vi.fn();
		runtime.groupChatInput = {
			unreadOthersProven: () => ({ shouldBlock: true, count: 0, exact: false }),
			markIncrementPending,
		} as unknown as GroupChatInput;

		const result = await runtime.speak("hello");
		expect(result).toEqual({
			published: false,
			reason: "unread_first",
			first: true,
			unreadExact: false,
		});
		expect(markIncrementPending).toHaveBeenCalledTimes(1);
	});

	it("未追平前重复 speak → 短拒 first: false，不重复标记", async () => {
		const runtime = RealCharacterRuntime.prepare({
			groupChatId: "group-1",
			sessionId: "session-1",
			character: {
				characterId: "dev",
				name: "Developer",
				description: "Writes code",
				path: "/chars/dev.md",
				prompt: "You are a developer.",
			},
		});
		const markIncrementPending = vi.fn();
		runtime.groupChatInput = {
			unreadOthersProven: () => ({ shouldBlock: true, count: 2, exact: true }),
			markIncrementPending,
		} as unknown as GroupChatInput;

		await runtime.speak("hello");
		const second = await runtime.speak("hello again");
		expect(second.reason).toBe("unread_first");
		expect(second.first).toBe(false);
		expect(markIncrementPending).toHaveBeenCalledTimes(1);
	});

	it("游标追平（无未读）→ 放行至请求路径（无 socket 抛连接错 = 通过前置门）", async () => {
		const runtime = RealCharacterRuntime.prepare({
			groupChatId: "group-1",
			sessionId: "session-1",
			character: {
				characterId: "dev",
				name: "Developer",
				description: "Writes code",
				path: "/chars/dev.md",
				prompt: "You are a developer.",
			},
		});
		const markIncrementPending = vi.fn();
		const unread = vi.fn().mockReturnValue({ shouldBlock: true, count: 2, exact: true });
		runtime.groupChatInput = {
			unreadOthersProven: unread,
			markIncrementPending,
		} as unknown as GroupChatInput;

		// 首次被阻
		await runtime.speak("hello");
		expect(markIncrementPending).toHaveBeenCalledTimes(1);
		// 追平：水位知识不变但游标已推进 → 判定归零 → 放行
		unread.mockReturnValue({ shouldBlock: false, count: 0, exact: true });
		await expect(runtime.speak("hello")).rejects.toThrow(ERROR_CONNECTION_NOT_OPEN);
	});

	it("水位未知（reload 后）→ 放行不阻塞（服务端 stale 兜底）", async () => {
		const runtime = RealCharacterRuntime.prepare({
			groupChatId: "group-1",
			sessionId: "session-1",
			character: {
				characterId: "dev",
				name: "Developer",
				description: "Writes code",
				path: "/chars/dev.md",
				prompt: "You are a developer.",
			},
		});
		runtime.groupChatInput = {
			unreadOthersProven: () => undefined,
		} as unknown as GroupChatInput;
		await expect(runtime.speak("hello")).rejects.toThrow(ERROR_CONNECTION_NOT_OPEN);
	});
});
