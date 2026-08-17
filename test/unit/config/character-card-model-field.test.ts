/**
 * 角色卡 model/thinking 字段解析契约红测（#180，PM 最终口径）。
 *
 * 锚定契约：src/config/character-card.ts 导出 parseModelField / parseThinkingField——
 * 「不校验」= 不做 model 目录/provider-id 格式校验、不做 thinking 枚举/大小写校验；
 * 仅基础存在性：undefined = absent；非 string/纯空白 = invalid；其余任意字符串 = ok 原样传递。
 * 解析失败不得导致角色卡加载失败。
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

describe("parseModelField（最小校验：仅存在性/类型）", () => {
	it("absent：仅字段缺席（undefined）", () => {
		expect(parseModelField(undefined)).toEqual({ status: "absent" });
	});

	it("ok：任意非空字符串原样传递——provider/id 形态", () => {
		expect(parseModelField("anthropic/claude-sonnet-4-5")).toEqual({
			status: "ok",
			model: "anthropic/claude-sonnet-4-5",
		});
	});

	it("ok：无斜杠裸字符串（自定义名）——解析不拦，执行期失败归执行器", () => {
		expect(parseModelField("my-model")).toEqual({ status: "ok", model: "my-model" });
	});

	it("ok：id 含多斜杠、空段字符串——不做格式校验", () => {
		expect(parseModelField("openrouter/moonshotai/kimi-k2.6").status).toBe("ok");
		expect(parseModelField("/model-only").status).toBe("ok");
		expect(parseModelField("provider/").status).toBe("ok");
	});

	it("invalid：非 string（number/null/object）→ invalid 携带 raw，不抛错", () => {
		expect(parseModelField(42).status).toBe("invalid");
		expect(parseModelField(null).status).toBe("invalid");
		expect(parseModelField({ provider: "anthropic" }).status).toBe("invalid");
	});

	it("invalid：空串/纯空白 → invalid", () => {
		expect(parseModelField("")).toEqual({ status: "invalid", raw: "" });
		expect(parseModelField("   ").status).toBe("invalid");
	});
});

describe("parseThinkingField（最小校验：不校验枚举/大小写）", () => {
	it("absent：仅字段缺席（undefined）", () => {
		expect(parseThinkingField(undefined)).toEqual({ status: "absent" });
	});

	it("ok：7 值内字符串原样传递", () => {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
			expect(parseThinkingField(level)).toEqual({ status: "ok", level });
		}
	});

	it("ok：非 7 值字符串（ultra/HIGH）——不校验枚举与大小写，pi 钳制兜底", () => {
		expect(parseThinkingField("ultra")).toEqual({ status: "ok", level: "ultra" });
		expect(parseThinkingField("HIGH").status).toBe("ok");
	});

	it("invalid：非 string → invalid 携带 raw", () => {
		expect(parseThinkingField(5).status).toBe("invalid");
		expect(parseThinkingField(null).status).toBe("invalid");
	});

	it("invalid：空串/纯空白 → invalid", () => {
		expect(parseThinkingField("")).toEqual({ status: "invalid", raw: "" });
		expect(parseThinkingField("   ").status).toBe("invalid");
	});
});

describe("loadCharacterCard 真实加载（最小三态带入 CharacterCard）", () => {
	it("合法 model/thinking：加载成功且携带 ok 原值", async () => {
		const { path, configPath } = await writeCard(
			"---\nname: Arch\ndescription: Architecture\nmodel: anthropic/model-x\nthinking: high\n---\nprompt",
		);
		const card = await loadCharacterCard(path, configPath);
		expect(card.model).toEqual({ status: "ok", model: "anthropic/model-x" });
		expect(card.thinking).toEqual({ status: "ok", level: "high" });
	});

	it("裸字符串 model / 非 7 值 thinking：加载成功且携带 ok（不拦截自定义）", async () => {
		const { path, configPath } = await writeCard(
			"---\nname: Arch\ndescription: Architecture\nmodel: my-model\nthinking: ultra\n---\nprompt",
		);
		const card = await loadCharacterCard(path, configPath);
		expect(card.model).toEqual({ status: "ok", model: "my-model" });
		expect(card.thinking).toEqual({ status: "ok", level: "ultra" });
	});

	it("非 string model 值（YAML 数字）：加载成功且携带 invalid", async () => {
		const { path, configPath } = await writeCard("---\nname: Arch\ndescription: Architecture\nmodel: 42\n---\nprompt");
		const card = await loadCharacterCard(path, configPath);
		expect(card.model).toEqual({ status: "invalid", raw: 42 });
	});

	it("缺席 model/thinking：加载成功且携带 absent", async () => {
		const { path, configPath } = await writeCard("---\nname: Arch\ndescription: Architecture\n---\nprompt");
		const card = await loadCharacterCard(path, configPath);
		expect(card.model).toEqual({ status: "absent" });
		expect(card.thinking).toEqual({ status: "absent" });
	});
});
