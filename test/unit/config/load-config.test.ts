import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadTavernConfig } from "../../../src/config/load-config.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-config-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("loadTavernConfig", () => {
	it("#215: 显式有效模板键每次加载恰一条可见迁移提示；无配置/仅非法零条", async () => {
		// 无配置 → 零条
		const bare = await createTemporaryDirectory();
		const bareNotices: string[] = [];
		await loadTavernConfig({
			agentDir: join(bare, "agent"),
			cwd: join(bare, "project"),
			notice: (message) => bareNotices.push(message),
		});
		expect(bareNotices).toEqual([]);

		// 全局显式有效 → 恰一条
		const configured = await createTemporaryDirectory();
		const agentDir = join(configured, "agent");
		const cwd = join(configured, "project");
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(
			join(agentDir, "tavern.json"),
			JSON.stringify({ message_templates: "global-templates.json" }),
			"utf8",
		);
		await writeFile(
			join(agentDir, "global-templates.json"),
			JSON.stringify({ public_message: "G: {sender} {content}" }),
			"utf8",
		);
		const notices: string[] = [];
		await loadTavernConfig({ agentDir, cwd, notice: (message) => notices.push(message) });
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("模板");
		expect(notices[0]).toContain("结构化");

		// 项目非法且全局无同 key → 回退内置，零条
		await writeFile(
			join(cwd, ".pi", "tavern.json"),
			JSON.stringify({ message_templates: "project-templates.json" }),
			"utf8",
		);
		await writeFile(
			join(cwd, ".pi", "project-templates.json"),
			JSON.stringify({ seconds_ago: "MISSING-PLACEHOLDERS" }),
			"utf8",
		);
		const invalidNotices: string[] = [];
		await loadTavernConfig({ agentDir, cwd, notice: (message) => invalidNotices.push(message) });
		// 全局 public_message 仍有效 → 仍恰一条（但不再是 seconds_ago）
		expect(invalidNotices).toHaveLength(1);
		expect(invalidNotices[0]).toContain("public_message");
		expect(invalidNotices[0]).not.toContain("seconds_ago");

		// 仅非法（全局也未配置）→ 零条
		const invalidOnly = await createTemporaryDirectory();
		const invalidOnlyCwd = join(invalidOnly, "project");
		await mkdir(join(invalidOnlyCwd, ".pi"), { recursive: true });
		await writeFile(
			join(invalidOnlyCwd, ".pi", "tavern.json"),
			JSON.stringify({ message_templates: "project-templates.json" }),
			"utf8",
		);
		await writeFile(
			join(invalidOnlyCwd, ".pi", "project-templates.json"),
			JSON.stringify({ public_message: "MISSING-PLACEHOLDERS" }),
			"utf8",
		);
		const invalidOnlyNotices: string[] = [];
		await loadTavernConfig({
			agentDir: join(invalidOnly, "agent"),
			cwd: invalidOnlyCwd,
			notice: (message) => invalidOnlyNotices.push(message),
		});
		expect(invalidOnlyNotices).toEqual([]);
	});

	it("uses defaults when global and project config are absent", async () => {
		const root = await createTemporaryDirectory();

		await expect(
			loadTavernConfig({
				agentDir: join(root, "agent"),
				cwd: join(root, "project"),
			}),
		).resolves.toEqual({
			configMaxMessages: 20,
			characters: [],
		});
	});

	it("merges Character imports and gives the project scalar precedence", async () => {
		const root = await createTemporaryDirectory();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await mkdir(join(cwd, "characters"), { recursive: true });
		await writeFile(
			join(agentDir, "tavern.json"),
			JSON.stringify({
				config_max_messages: 12,
				characters: ["./characters/global.md"],
			}),
		);
		await writeFile(
			join(cwd, ".pi", "tavern.json"),
			JSON.stringify({
				config_max_messages: 18,
				characters: ["../characters/project.md"],
			}),
		);
		await writeFile(
			join(agentDir, "characters", "global.md"),
			"---\nname: Global\ndescription: Global Character\n---\nGlobal prompt",
		);
		await writeFile(
			join(cwd, "characters", "project.md"),
			"---\nname: Project\ndescription: Project Character\n---\nProject prompt",
		);

		const config = await loadTavernConfig({ agentDir, cwd });

		expect(config.configMaxMessages).toBe(18);
		expect(config.characters.map((character) => character.name)).toEqual(["Global", "Project"]);
		expect(config.characters.map((character) => character.characterId)).toEqual([
			"characters/global.md",
			"../characters/project.md",
		]);
	});

	it("uses the global scalar when the project only adds Characters", async () => {
		const root = await createTemporaryDirectory();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "tavern.json"), JSON.stringify({ config_max_messages: 16 }));
		await writeFile(join(cwd, ".pi", "tavern.json"), JSON.stringify({ characters: [] }));

		expect((await loadTavernConfig({ agentDir, cwd })).configMaxMessages).toBe(16);
	});

	it("rejects malformed or schema-invalid config with its path", async () => {
		const root = await createTemporaryDirectory();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const globalConfigPath = join(agentDir, "tavern.json");
		await mkdir(agentDir, { recursive: true });
		await writeFile(globalConfigPath, "{broken");

		await expect(loadTavernConfig({ agentDir, cwd })).rejects.toThrow(globalConfigPath);

		await writeFile(globalConfigPath, JSON.stringify({ configMaxMessages: 12 }));
		await expect(loadTavernConfig({ agentDir, cwd })).rejects.toThrow(globalConfigPath);
	});

	it("fails the whole snapshot when an imported Character is invalid", async () => {
		const root = await createTemporaryDirectory();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const characterPath = join(agentDir, "broken.md");
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "tavern.json"), JSON.stringify({ characters: ["broken.md"] }));
		await writeFile(characterPath, "---\nname: Broken\n---\nPrompt");

		await expect(loadTavernConfig({ agentDir, cwd })).rejects.toThrow(characterPath);
	});

	describe("welcome_message 三档合并与 wire 安全校验（P1，Arch 属主）", () => {
		async function configWithWelcome(
			root: string,
			projectWelcome: string | undefined,
			globalWelcome: string | undefined,
		) {
			const agentDir = join(root, "agent");
			const cwd = join(root, "project");
			await mkdir(join(cwd, ".pi"), { recursive: true });
			await mkdir(agentDir, { recursive: true });
			await writeFile(
				join(agentDir, "tavern.json"),
				JSON.stringify(globalWelcome !== undefined ? { welcome_message: globalWelcome } : {}),
			);
			await writeFile(
				join(cwd, ".pi", "tavern.json"),
				JSON.stringify(projectWelcome !== undefined ? { welcome_message: projectWelcome } : {}),
			);
			return loadTavernConfig({ agentDir, cwd });
		}

		it("W1 项目档覆盖全局档，生效值进入配置", async () => {
			const root = await createTemporaryDirectory();
			const config = await configWithWelcome(root, "项目欢迎", "全局欢迎");
			expect(config.welcomeMessage).toBe("项目欢迎");
		});

		it("W2 空串/空白串视为未配置（回退默认，不绕过 ?? DEFAULT 语义）", async () => {
			const root = await createTemporaryDirectory();
			const config = await configWithWelcome(root, "", undefined);
			expect(config.welcomeMessage).toBeUndefined();

			const blank = await configWithWelcome(await createTemporaryDirectory(), "   ", undefined);
			expect(blank.welcomeMessage).toBeUndefined();
		});

		it("W2b P1-3 反例：项目空白 + 全局有效 → 全局生效（归一化在合并前，回退链不截断）", async () => {
			const root = await createTemporaryDirectory();
			const config = await configWithWelcome(root, "", "全局欢迎");
			expect(config.welcomeMessage).toBe("全局欢迎");
		});

		it("W3 超 WebSocket 帧上限的完整信封 → 配置错误 fail-fast", async () => {
			const root = await createTemporaryDirectory();
			// 1 MiB+ 字符：信封（jsonrpc/method/params 包裹 + 转义膨胀）必然超限。
			const oversized = "x".repeat(1024 * 1024 + 64);
			await expect(configWithWelcome(root, oversized, undefined)).rejects.toThrow(/Invalid PiTavern config/);
		});
	});

	describe("speak_soft_limit_chars（#187：公开回复软上限）", () => {
		it("S1 缺省 = 不带字段（注入面回落代码默认）", async () => {
			const root = await createTemporaryDirectory();
			const config = await loadTavernConfig({ agentDir: join(root, "agent"), cwd: join(root, "project") });
			expect(config.speakSoftLimitChars).toBeUndefined();
		});

		it("S2 项目覆盖全局（?? 链不变）", async () => {
			const root = await createTemporaryDirectory();
			const agentDir = join(root, "agent");
			const cwd = join(root, "project");
			await mkdir(join(cwd, ".pi"), { recursive: true });
			await mkdir(agentDir, { recursive: true });
			await writeFile(join(agentDir, "tavern.json"), JSON.stringify({ speak_soft_limit_chars: 3000 }));
			await writeFile(join(cwd, ".pi", "tavern.json"), JSON.stringify({ speak_soft_limit_chars: 3500 }));
			expect((await loadTavernConfig({ agentDir, cwd })).speakSoftLimitChars).toBe(3500);
		});

		it("S3 仅全局配置 → 全局生效", async () => {
			const root = await createTemporaryDirectory();
			const agentDir = join(root, "agent");
			const cwd = join(root, "project");
			await mkdir(agentDir, { recursive: true });
			await writeFile(join(agentDir, "tavern.json"), JSON.stringify({ speak_soft_limit_chars: 3000 }));
			expect((await loadTavernConfig({ agentDir, cwd })).speakSoftLimitChars).toBe(3000);
		});

		it("S4 非法（0/负数/非整数）→ fail-fast（同 board 先例）", async () => {
			const root = await createTemporaryDirectory();
			const agentDir = join(root, "agent");
			const cwd = join(root, "project");
			await mkdir(agentDir, { recursive: true });
			const configPath = join(agentDir, "tavern.json");
			for (const invalid of [0, -1, 1.5]) {
				await writeFile(configPath, JSON.stringify({ speak_soft_limit_chars: invalid }));
				await expect(loadTavernConfig({ agentDir, cwd })).rejects.toThrow(configPath);
			}
		});
	});
});
