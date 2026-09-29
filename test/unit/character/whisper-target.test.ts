import { describe, expect, it } from "vitest";
import {
	formatMemberList,
	MEMBER_DESCRIPTION_LIMIT,
	orderRoster,
	resolveWhisperTargetFromRoster,
	truncateDescription,
	type WhisperRoster,
} from "../../../src/character/whisper-target.js";

/**
 * #183 私信目标解析（Dev 钉面，unit 层）：
 *
 * 判据（acceptance.md「whisper 目标发现（#183）」）：精确 character_id 优先 →
 * 注册名唯一命中；多命中拒绝并附候选；命中自己判 self；规范化仅两段
 *（原样 → trim 一次），不做大小写/全角归一。
 *
 * 样本含生产形态 id：相对卡路径（`..` / 分隔符 / 中文 / 空格）。
 */

const SELF_ID = "../characters/dev.md";

function member(over: Partial<WhisperRoster[number]> & { character_id: string; name: string }): WhisperRoster[number] {
	return {
		description: over.name,
		is_self: false,
		is_streaming: false,
		hand_raised: false,
		...over,
	};
}

const roster: WhisperRoster = [
	member({ character_id: SELF_ID, name: "Dev", is_self: true }),
	member({ character_id: "../角色卡/admin.md", name: "Admin" }),
	member({ character_id: "../characters/qa lead.md", name: "QA Lead" }),
	member({ character_id: "../characters/开发.md", name: "开发" }),
];

describe("resolveWhisperTargetFromRoster", () => {
	it("精确 character_id 命中（路径形态：`..` / 中文 / 空格）", () => {
		for (const id of ["../角色卡/admin.md", "../characters/qa lead.md", "../characters/开发.md"]) {
			const outcome = resolveWhisperTargetFromRoster(id, roster, SELF_ID);
			expect(outcome).toMatchObject({ kind: "resolved", character_id: id });
		}
	});

	it("注册名唯一命中 → resolved（含中文名）", () => {
		expect(resolveWhisperTargetFromRoster("Admin", roster, SELF_ID)).toMatchObject({
			kind: "resolved",
			character_id: "../角色卡/admin.md",
			name: "Admin",
		});
		expect(resolveWhisperTargetFromRoster("开发", roster, SELF_ID)).toMatchObject({
			kind: "resolved",
			character_id: "../characters/开发.md",
		});
	});

	it("id 优先于 name：目标的串同时是他人注册名时按 id 解析", () => {
		const colliding = [
			member({ character_id: "../characters/a.md", name: "Shared" }),
			member({ character_id: "Shared", name: "Other" }),
		];
		// "Shared" 既是 a 的注册名，也是后者的精确 id → id 面先判，命中后者。
		expect(resolveWhisperTargetFromRoster("Shared", colliding, SELF_ID)).toMatchObject({
			kind: "resolved",
			character_id: "Shared",
			name: "Other",
		});
	});

	it("多命中同名 → ambiguous + 候选（含 id），不猜测", () => {
		const duplicates = [
			member({ character_id: "../characters/d1.md", name: "Dup" }),
			member({ character_id: "../characters/d2.md", name: "Dup" }),
			member({ character_id: SELF_ID, name: "Dev", is_self: true }),
		];
		const outcome = resolveWhisperTargetFromRoster("Dup", duplicates, SELF_ID);
		expect(outcome).toMatchObject({
			kind: "ambiguous",
			candidates: [
				{ name: "Dup", character_id: "../characters/d1.md" },
				{ name: "Dup", character_id: "../characters/d2.md" },
			],
		});
	});

	it("命中自己（id 或注册名）→ self", () => {
		expect(resolveWhisperTargetFromRoster(SELF_ID, roster, SELF_ID)).toMatchObject({ kind: "self" });
		expect(resolveWhisperTargetFromRoster("Dev", roster, SELF_ID)).toMatchObject({ kind: "self" });
	});

	it("未命中（不存在 / 离线同态）→ not-found + 名册原样", () => {
		const outcome = resolveWhisperTargetFromRoster("nobody", roster, SELF_ID);
		expect(outcome).toMatchObject({ kind: "not-found" });
		if (outcome.kind !== "not-found") throw new Error("expected not-found");
		expect(outcome.roster).toBe(roster);
		// 空串同样按未命中处理（不抛错、不猜测）。
		expect(resolveWhisperTargetFromRoster("   ", roster, SELF_ID)).toMatchObject({ kind: "not-found" });
	});

	it("规范化仅两段：原样 → trim 一次（首尾空白容忍，内部空格不动）", () => {
		expect(resolveWhisperTargetFromRoster("  Admin  ", roster, SELF_ID)).toMatchObject({
			kind: "resolved",
			character_id: "../角色卡/admin.md",
		});
		expect(resolveWhisperTargetFromRoster(`${SELF_ID} `, roster, SELF_ID)).toMatchObject({ kind: "self" });
		expect(resolveWhisperTargetFromRoster("QA  Lead", roster, SELF_ID)).toMatchObject({ kind: "not-found" });
	});

	it("不做大小写折叠 / 全角归一（不匹配即未命中）", () => {
		expect(resolveWhisperTargetFromRoster("admin", roster, SELF_ID)).toMatchObject({ kind: "not-found" });
		expect(resolveWhisperTargetFromRoster("DEV", roster, SELF_ID)).toMatchObject({ kind: "not-found" });
		expect(resolveWhisperTargetFromRoster("Ａｄｍｉｎ", roster, SELF_ID)).toMatchObject({ kind: "not-found" });
	});
});

describe("成员清单格式化", () => {
	it("formatMemberList：注册名（character_id）顿号连接", () => {
		expect(
			formatMemberList([
				{ name: "Dev", character_id: SELF_ID },
				{ name: "Admin", character_id: "../角色卡/admin.md" },
			]),
		).toBe("Dev（../characters/dev.md）、Admin（../角色卡/admin.md）");
		expect(formatMemberList([])).toBe("");
	});

	it("truncateDescription：≤ 上限原样，超限截断加省略号", () => {
		expect(MEMBER_DESCRIPTION_LIMIT).toBe(80);
		const keep = "x".repeat(MEMBER_DESCRIPTION_LIMIT);
		expect(truncateDescription(keep)).toBe(keep);
		expect(truncateDescription(`${keep}y`)).toBe(`${keep}…`);
	});

	it("orderRoster：自己置首，其余保持快照顺序", () => {
		const ordered = orderRoster(roster);
		expect(ordered.map((entry) => entry.name)).toEqual(["Dev", "Admin", "QA Lead", "开发"]);
		// 不改动入参数组（投影新数组）。
		expect(roster[0]?.name).toBe("Dev");
		expect(ordered).not.toBe(roster);
	});
});
