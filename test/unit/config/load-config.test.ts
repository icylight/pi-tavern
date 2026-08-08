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

	describe("welcome_message 三档合并与 wire 安全校验（#123 + PR #144 P1，Arch 属主）", () => {
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

		it("W3 超 WebSocket 帧上限的完整信封 → 配置错误 fail-fast", async () => {
			const root = await createTemporaryDirectory();
			// 1 MiB+ 字符：信封（jsonrpc/method/params 包裹 + 转义膨胀）必然超限。
			const oversized = "x".repeat(1024 * 1024 + 64);
			await expect(configWithWelcome(root, oversized, undefined)).rejects.toThrow(
				/Invalid PiTavern config/,
			);
		});
	});
});
