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
});
