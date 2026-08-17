/**
 * 角色卡 model 字段解析契约红测（#180）。
 *
 * 锚定契约：src/config/character-card.ts 导出 parseModelField(raw: unknown) 三态解析；
 * loadCharacterCard 真正调用并把三态带入 CharacterCard.model（isolated 函数不算绿）——
 * 可选 model 字段解析失败不得导致角色卡加载失败（PM 修正 4）。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadCharacterCard, parseModelField, parseThinkingField } from "../../../src/config/character-card.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function writeCard(content: string): Promise<{ path: string; configPath: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pi-tavern-model-field-"));
	temporaryDirectories.push(dir);
	const path = join(dir, "character.md");
	await writeFile(path, content);
	return { path, configPath: join(dir, "tavern.json") };
}

describe("parseModelField（角色卡 model 字段三态解析）", () => {
	it("absent：仅字段缺席（undefined）→ { status: 'absent' }", () => {
		expect(parseModelField(undefined)).toEqual({ status: "absent" });
	});

	it("ok：provider/id → { status: 'ok', model }", () => {
		expect(parseModelField("anthropic/claude-sonnet-4-5")).toEqual({
			status: "ok",
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		});
	});

	it("ok：id 含斜杠时只按首个斜杠切分（provider 在前）", () => {
		expect(parseModelField("openrouter/moonshotai/kimi-k2.6")).toEqual({
			status: "ok",
			model: { provider: "openrouter", id: "moonshotai/kimi-k2.6" },
		});
	});

	it("invalid：无斜杠 → { status: 'invalid', raw }", () => {
		expect(parseModelField("claude-sonnet-4-5")).toEqual({
			status: "invalid",
			raw: "claude-sonnet-4-5",
		});
	});

	it("invalid：空串/纯空白/空段 → invalid（已提供即非 absent）", () => {
		expect(parseModelField("")).toEqual({ status: "invalid", raw: "" });
		expect(parseModelField("   ")).toEqual({ status: "invalid", raw: "   " });
		expect(parseModelField("/model-only").status).toBe("invalid");
		expect(parseModelField("provider/").status).toBe("invalid");
		expect(parseModelField(" / ").status).toBe("invalid");
	});

	it("invalid：非 string 值（number/null/object）→ invalid，不抛错", () => {
		expect(parseModelField(42).status).toBe("invalid");
		expect(parseModelField(null).status).toBe("invalid");
		expect(parseModelField({ provider: "anthropic" }).status).toBe("invalid");
	});
});

describe("parseThinkingField（角色卡 thinking 字段三态解析）", () => {
	const VALID_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

	it("absent：仅字段缺席（undefined）→ { status: 'absent' }", () => {
		expect(parseThinkingField(undefined)).toEqual({ status: "absent" });
	});

	it("ok：全部 7 个合法值（含 off）→ { status: 'ok', level }", () => {
		for (const level of VALID_LEVELS) {
			expect(parseThinkingField(level)).toEqual({ status: "ok", level });
		}
	});

	it("invalid：非 7 值字符串 → { status: 'invalid', raw }", () => {
		expect(parseThinkingField("ultra")).toEqual({ status: "invalid", raw: "ultra" });
		expect(parseThinkingField("")).toEqual({ status: "invalid", raw: "" });
		expect(parseThinkingField("HIGH").status).toBe("invalid"); // 大小写敏感
	});

	it("invalid：非 string 值 → invalid，不抛错", () => {
		expect(parseThinkingField(5).status).toBe("invalid");
		expect(parseThinkingField(null).status).toBe("invalid");
	});
});

describe("loadCharacterCard 真实加载（三态带入 CharacterCard.model）", () => {
	it("合法 model：加载成功且携带 ok 三态", async () => {
		const { path, configPath } = await writeCard(
			"---\nname: Arch\ndescription: Architecture\nmodel: anthropic/model-x\n---\nprompt",
		);
		const card = await loadCharacterCard(path, configPath);
		expect(card.model).toEqual({ status: "ok", model: { provider: "anthropic", id: "model-x" } });
	});

	it("非法 model：加载成功（不失败）且携带 invalid 三态", async () => {
		const { path, configPath } = await writeCard(
			"---\nname: Arch\ndescription: Architecture\nmodel: bad-format\n---\nprompt",
		);
		const card = await loadCharacterCard(path, configPath);
		expect(card.model).toEqual({ status: "invalid", raw: "bad-format" });
	});

	it("缺席 model：加载成功且携带 absent 三态", async () => {
		const { path, configPath } = await writeCard("---\nname: Arch\ndescription: Architecture\n---\nprompt");
		const card = await loadCharacterCard(path, configPath);
		expect(card.model).toEqual({ status: "absent" });
	});

	it("非 string model 值（YAML 数字）：加载成功且携带 invalid 三态", async () => {
		const { path, configPath } = await writeCard("---\nname: Arch\ndescription: Architecture\nmodel: 42\n---\nprompt");
		const card = await loadCharacterCard(path, configPath);
		expect(card.model).toEqual({ status: "invalid", raw: 42 });
	});

	it("合法 thinking：加载成功且携带 ok 三态", async () => {
		const { path, configPath } = await writeCard(
			"---\nname: Arch\ndescription: Architecture\nmodel: anthropic/model-x\nthinking: high\n---\nprompt",
		);
		const card = await loadCharacterCard(path, configPath);
		expect(card.thinking).toEqual({ status: "ok", level: "high" });
	});

	it("非法 thinking：加载成功（不失败）且携带 invalid 三态", async () => {
		const { path, configPath } = await writeCard(
			"---\nname: Arch\ndescription: Architecture\nthinking: ultra\n---\nprompt",
		);
		const card = await loadCharacterCard(path, configPath);
		expect(card.thinking).toEqual({ status: "invalid", raw: "ultra" });
	});

	it("缺席 thinking：加载成功且携带 absent 三态", async () => {
		const { path, configPath } = await writeCard("---\nname: Arch\ndescription: Architecture\n---\nprompt");
		const card = await loadCharacterCard(path, configPath);
		expect(card.thinking).toEqual({ status: "absent" });
	});
});
