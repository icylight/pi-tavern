import { describe, expect, it } from "vitest";

import type { TavernController } from "../../../src/controller/tavern-controller.js";
import { buildTavernViewModel, type TavernViewModel } from "../../../src/ui/tavern-ui-presenter.js";

/**
 * UI presentation layer tests (A 组 U1-U4, test boundary: unit layer, Dev
 * owned). buildTavernViewModel is a pure read-only projection of Controller
 * state — it never participates in protocol/quota/membership decisions.
 */

function stubController(state: unknown): TavernController {
	return { getState: () => state } as unknown as TavernController;
}

function creatorState(overrides: {
	name?: string;
	onlineCharacters?: Map<string, { character: { name: string }; isStreaming: boolean; handRaised: boolean }>;
	round?: { roundMaxMessages: number; usedMessages: number; remainingMessages: number } | null;
}) {
	return {
		type: "creator" as const,
		runtime: {
			state: {
				groupChat: { name: overrides.name ?? "测试群聊" },
				onlineCharacters:
					overrides.onlineCharacters ??
					new Map([["s1", { character: { name: "A" }, isStreaming: false, handRaised: false }]]),
				round: overrides.round ?? null,
			},
		},
	};
}

function characterState(overrides: {
	name?: string;
	snapshot?: {
		group_chat: { group_chat_id: string; name: string; created_at: string; group_max_messages: number };
		round: { round_max_messages: number; used_messages: number; remaining_messages: number } | null;
		online_characters: Array<{
			character_id: string;
			name: string;
			description: string;
			is_self: boolean;
			is_streaming: boolean;
			hand_raised: boolean;
		}>;
	} | null;
}) {
	return {
		type: "character" as const,
		runtime: {
			character: { name: overrides.name ?? "Dev" },
			lastGroupChatState: overrides.snapshot ?? null,
		},
	};
}

const memberA = {
	character_id: "c1",
	name: "A",
	description: "",
	is_self: false,
	is_streaming: false,
	hand_raised: false,
};
const memberB = {
	character_id: "c2",
	name: "B",
	description: "",
	is_self: false,
	is_streaming: false,
	hand_raised: false,
};

const baseSnapshot = {
	group_chat: { group_chat_id: "g1", name: "测试群聊", created_at: "", group_max_messages: 100 },
	round: { round_max_messages: 10, used_messages: 2, remaining_messages: 8 },
	online_characters: [memberA],
};

describe("U1 正在发言状态呈现", () => {
	it("creator 视图：is_streaming=true 的角色出现在「正在发言」行", () => {
		const state = creatorState({
			onlineCharacters: new Map([
				["s1", { character: { name: "A" }, isStreaming: true, handRaised: false }],
				["s2", { character: { name: "B" }, isStreaming: false, handRaised: false }],
			]),
		});
		const view = buildTavernViewModel(stubController(state));
		expect(view.widgetLines).toContain("正在发言：A");
	});

	it("creator 视图：is_streaming=false 的角色不出现于「正在发言」行", () => {
		const state = creatorState({
			onlineCharacters: new Map([["s1", { character: { name: "A" }, isStreaming: false, handRaised: false }]]),
		});
		const view = buildTavernViewModel(stubController(state));
		expect(view.widgetLines).not.toContainEqual(expect.stringContaining("正在发言"));
	});

	it("character 视图：is_streaming=true 的角色出现在「正在发言」行", () => {
		const state = characterState({
			snapshot: {
				...baseSnapshot,
				online_characters: [{ ...memberA, is_streaming: true }, memberB],
			},
		});
		const view = buildTavernViewModel(stubController(state));
		expect(view.widgetLines).toContain("正在发言：A");
	});

	it("character 视图：is_streaming=false 的角色不出现于「正在发言」行", () => {
		const state = characterState({
			snapshot: {
				...baseSnapshot,
				online_characters: [{ ...memberA, is_streaming: false }],
			},
		});
		const view = buildTavernViewModel(stubController(state));
		expect(view.widgetLines).not.toContainEqual(expect.stringContaining("正在发言"));
	});
});

describe("U2 发言次数呈现（新增元素 #12）", () => {
	it("creator 视图：显示发言次数与剩余（used/max/remaining 来自 round）", () => {
		const state = creatorState({
			onlineCharacters: new Map([["s1", { character: { name: "A" }, isStreaming: false, handRaised: false }]]),
			round: { roundMaxMessages: 10, usedMessages: 2, remainingMessages: 8 },
		});
		const view: TavernViewModel = buildTavernViewModel(stubController(state));
		expect(view.widgetLines).toContain("发言 2/10 · 剩余 8");
	});

	it("creator 视图：round 为 null 时不显示发言次数行", () => {
		const state = creatorState({ round: null });
		const view: TavernViewModel = buildTavernViewModel(stubController(state));
		expect(view.widgetLines).not.toContainEqual(expect.stringContaining("发言"));
	});

	it("character 视图：显示发言次数与剩余（来自快照 round）", () => {
		const state = characterState({ snapshot: baseSnapshot });
		const view: TavernViewModel = buildTavernViewModel(stubController(state));
		expect(view.widgetLines).toContain("发言 2/10 · 剩余 8");
	});

	it("character 视图：快照 round 为 null 时不显示发言次数行", () => {
		const state = characterState({
			snapshot: { ...baseSnapshot, round: null },
		});
		const view: TavernViewModel = buildTavernViewModel(stubController(state));
		expect(view.widgetLines).not.toContainEqual(expect.stringContaining("发言"));
	});
});

describe("U3 举手状态呈现（新增元素 #20）", () => {
	it("creator 视图：hand_raised=true 的角色出现在「举手」行", () => {
		const state = creatorState({
			onlineCharacters: new Map([
				["s1", { character: { name: "A" }, isStreaming: false, handRaised: true }],
				["s2", { character: { name: "B" }, isStreaming: false, handRaised: false }],
			]),
		});
		const view: TavernViewModel = buildTavernViewModel(stubController(state));
		expect(view.widgetLines).toContain("举手：A");
	});

	it("creator 视图：无举手者时不显示「举手」行", () => {
		const state = creatorState({
			onlineCharacters: new Map([["s1", { character: { name: "A" }, isStreaming: false, handRaised: false }]]),
		});
		const view: TavernViewModel = buildTavernViewModel(stubController(state));
		expect(view.widgetLines).not.toContainEqual(expect.stringContaining("举手"));
	});

	it("character 视图：hand_raised=true 的角色出现在「举手」行", () => {
		const state = characterState({
			snapshot: {
				...baseSnapshot,
				online_characters: [{ ...memberA, hand_raised: true }],
			},
		});
		const view: TavernViewModel = buildTavernViewModel(stubController(state));
		expect(view.widgetLines).toContain("举手：A");
	});

	it("character 视图：无举手者时不显示「举手」行", () => {
		const state = characterState({ snapshot: baseSnapshot });
		const view: TavernViewModel = buildTavernViewModel(stubController(state));
		expect(view.widgetLines).not.toContainEqual(expect.stringContaining("举手"));
	});
});

describe("U4 成员数呈现（#21）", () => {
	it("creator 视图：成员数 = onlineCharacters + User Persona", () => {
		const state = creatorState({
			onlineCharacters: new Map([
				["s1", { character: { name: "A" }, isStreaming: false, handRaised: false }],
				["s2", { character: { name: "B" }, isStreaming: false, handRaised: false }],
			]),
		});
		const view = buildTavernViewModel(stubController(state));
		expect(view.widgetLines).toContain("3 人在线");
	});

	it("character 视图：成员数 = online_characters + User Persona", () => {
		const state = characterState({
			snapshot: {
				...baseSnapshot,
				online_characters: [{ ...memberA }, memberB],
			},
		});
		const view = buildTavernViewModel(stubController(state));
		expect(view.widgetLines).toContain("3 人在线");
	});

	it("character 视图：snapshot 为 null 时显示「成员数未知」", () => {
		const state = characterState({ snapshot: null });
		const view = buildTavernViewModel(stubController(state));
		expect(view.widgetLines).toEqual(["成员数未知"]);
	});
});
