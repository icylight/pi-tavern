import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

//  SK6 机械锚：两 SKILL.md 存在、frontmatter 合法、关键安全条款文本存在性、
// pi.skills 声明与 files 白名单一致。静态断言，不依赖真实 pi 进程。
// 校验语义对齐 pi 源码（references/pi packages/coding-agent/src/core/skills.ts）：
// name ^[a-z0-9-]+$、≤64、不以连字符开头/结尾、不含连续连字符；description 必填、≤1024。

const PACKAGE_JSON_URL = new URL("../../package.json", import.meta.url);
const SKILLS = [
	{
		dir: "tavern-character-edit",
		expectName: "tavern-character-edit",
	},
	{
		dir: "tavern-template-edit",
		expectName: "tavern-template-edit",
	},
] as const;

function skillUrl(dir: string): URL {
	return new URL(`../../skills/${dir}/SKILL.md`, import.meta.url);
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
	if (!match) {
		return { frontmatter: {}, body: raw };
	}
	const frontmatter: Record<string, unknown> = {};
	for (const line of (match[1] ?? "").split(/\r?\n/)) {
		const kv = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
		if (kv?.[1] !== undefined && kv?.[2] !== undefined) {
			frontmatter[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
		}
	}
	return { frontmatter, body: match[2] ?? "" };
}

describe("SK6 机械锚：包内 skill 结构与分发声明", () => {
	it.each(SKILLS.map((s) => [s.dir, s.expectName] as const))(
		"SKILL.md 存在且 frontmatter 合法（%s）",
		async (dir, expectName) => {
			const raw = await readFile(skillUrl(dir), "utf-8");
			const { frontmatter, body } = parseFrontmatter(raw);

			// name：显式或回退目录名（pi 语义），须为合法 skill 名
			const name = String(frontmatter.name ?? dir);
			expect(name).toBe(expectName);
			expect(name).toMatch(/^[a-z0-9-]+$/);
			expect(name.length).toBeLessThanOrEqual(64);
			expect(name.startsWith("-")).toBe(false);
			expect(name.endsWith("-")).toBe(false);
			expect(name).not.toContain("--");

			// description：必填、非空、≤1024（pi 校验语义）
			const description = String(frontmatter.description ?? "");
			expect(description.trim()).not.toBe("");
			expect(description.length).toBeLessThanOrEqual(1024);

			// 正文非空（skill 指令本体存在，对应 PROMPT 迁入去向）
			expect(body.trim()).not.toBe("");
		},
	);

	it.each(SKILLS.map((s) => [s.dir, s.expectName] as const))(
		"关键安全条款文本存在性（%s）：diff 预览/明确确认/取消=零写入",
		async (dir) => {
			const raw = await readFile(skillUrl(dir), "utf-8");
			expect(raw).toMatch(/diff/i);
			expect(raw).toMatch(/零写入/);
			expect(raw).toMatch(/确认/);
		},
	);

	it("联动检查：character skill 含「联动检查清单」段（方案 A）", async () => {
		const raw = await readFile(skillUrl("tavern-character-edit"), "utf-8");
		expect(raw).toMatch(/联动检查/);
	});

	it("package.json：pi.skills 声明与 files 白名单一致包含 skills/", async () => {
		const pkg = JSON.parse(await readFile(PACKAGE_JSON_URL, "utf-8")) as {
			pi?: { skills?: string[] };
			files?: string[];
		};
		expect(pkg.pi?.skills).toBeDefined();
		expect(pkg.pi?.skills).toContain("./skills");
		expect(pkg.files).toBeDefined();
		expect(pkg.files).toContain("skills");
	});
});
