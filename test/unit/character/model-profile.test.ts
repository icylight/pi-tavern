import { describe, expect, it } from "vitest";
import { planModelProfile } from "../../../src/character/model-profile.js";
import type { CharacterCard, ModelFieldStatus, ThinkingFieldStatus } from "../../../src/config/character-card.js";

function makeCard(model?: ModelFieldStatus, thinking?: ThinkingFieldStatus): CharacterCard {
	return {
		characterId: "char-1",
		name: "Char",
		description: "test",
		path: "/agent/characters/char.md",
		prompt: "prompt",
		...(model !== undefined ? { model } : {}),
		...(thinking !== undefined ? { thinking } : {}),
	};
}

describe("planModelProfile（#180 卡字段 → 队列输入）", () => {
	it("absent 双维：mask 全关、target 空、零提示（行为不变）", () => {
		expect(planModelProfile(makeCard())).toEqual({
			mask: { model: false, thinking: false },
			target: {},
			warnings: [],
		});
	});

	it("ok 双维：mask 全开、target 保留原始串（拆分归队列）", () => {
		const plan = planModelProfile(makeCard({ status: "ok", model: "fixture/alpha" }, { status: "ok", level: "high" }));
		expect(plan.mask).toEqual({ model: true, thinking: true });
		expect(plan.target).toEqual({ model: "fixture/alpha", thinking: "high" });
		expect(plan.warnings).toEqual([]);
	});

	it("invalid 双维：mask 全关、零提交、每维一条提示", () => {
		const plan = planModelProfile(
			makeCard({ status: "invalid", raw: 42 }, { status: "invalid", raw: { level: "high" } }),
		);
		expect(plan.mask).toEqual({ model: false, thinking: false });
		expect(plan.target).toEqual({});
		expect(plan.warnings).toHaveLength(2);
		expect(plan.warnings[0]).toContain("model");
		expect(plan.warnings[1]).toContain("thinking");
	});

	it("混合三态：ok 维度进 mask/target，absent 维度沉默，invalid 维度单独提示", () => {
		const plan = planModelProfile(makeCard({ status: "ok", model: "fixture/alpha" }, { status: "invalid", raw: "" }));
		expect(plan.mask).toEqual({ model: true, thinking: false });
		expect(plan.target).toEqual({ model: "fixture/alpha" });
		expect(plan.warnings).toHaveLength(1);
		expect(plan.warnings[0]).toContain("thinking");
	});
});
