import { describe, expect, it } from "vitest";

import {
	createGroupChatState,
	normalizeGroupChatName,
	setGroupChatName,
	setGroupMaxMessages,
} from "../../src/creator/group-chat-state.js";

describe("GroupChatState", () => {
	it("creates an empty authoritative state", () => {
		const state = createGroupChatState({
			groupChatId: "group-1",
			createdAt: "2026-07-27T00:00:00.000Z",
			groupMaxMessages: 10,
		});

		expect(state.groupChat).toEqual({
			groupChatId: "group-1",
			name: null,
			createdAt: "2026-07-27T00:00:00.000Z",
			groupMaxMessages: 10,
		});
		expect(state.round).toBeNull();
		expect(state.characterReservations.size).toBe(0);
		expect(state.onlineCharacters.size).toBe(0);
	});

	it("normalizes names with pi session naming semantics", () => {
		expect(normalizeGroupChatName("  Design\nReview\r\nRoom  ")).toBe("Design Review Room");
		expect(normalizeGroupChatName(" \n ")).toBeNull();
	});

	it("updates the name and future-round message limit", () => {
		const state = createGroupChatState({
			groupChatId: "group-1",
			createdAt: "2026-07-27T00:00:00.000Z",
			groupMaxMessages: 10,
		});

		expect(setGroupChatName(state, "  Architecture\nRoom ")).toBe("Architecture Room");
		setGroupMaxMessages(state, 14);

		expect(state.groupChat.name).toBe("Architecture Room");
		expect(state.groupChat.groupMaxMessages).toBe(14);
		expect(state.round).toBeNull();
	});

	it("rejects invalid message limits", () => {
		const state = createGroupChatState({
			groupChatId: "group-1",
			createdAt: "2026-07-27T00:00:00.000Z",
			groupMaxMessages: 10,
		});

		expect(() => setGroupMaxMessages(state, -1)).toThrow("non-negative safe integer");
		expect(() => setGroupMaxMessages(state, 1.5)).toThrow("non-negative safe integer");
	});
});
