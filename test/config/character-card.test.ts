import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadCharacterCard, loadCharacterCards, loadClaimedCharacter } from "../../src/config/character-card.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-character-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Character Markdown", () => {
	it("uses pi frontmatter parsing and a normalized config-relative identity", async () => {
		const root = await createTemporaryDirectory();
		const configPath = join(root, "config", "tavern.json");
		const characterPath = join(root, "characters", "architect.md");
		await mkdir(join(root, "characters"), { recursive: true });
		await writeFile(
			characterPath,
			["---", "name: Architect", "description: 负责系统设计", "---", "", "你是一名软件架构师。", ""].join("\r\n"),
		);

		await expect(loadCharacterCard(characterPath, configPath)).resolves.toEqual({
			characterId: "../characters/architect.md",
			name: "Architect",
			description: "负责系统设计",
			path: characterPath,
			prompt: "你是一名软件架构师。",
		});
	});

	it("rejects invalid frontmatter and reports the Character path", async () => {
		const root = await createTemporaryDirectory();
		const configPath = join(root, "tavern.json");
		const missingDescription = join(root, "missing-description.md");
		const invalidYaml = join(root, "invalid-yaml.md");
		await writeFile(missingDescription, "---\nname: Developer\n---\nPrompt");
		await writeFile(invalidYaml, "---\nname: [broken\n---\nPrompt");

		await expect(loadCharacterCard(missingDescription, configPath)).rejects.toThrow(missingDescription);
		await expect(loadCharacterCard(invalidYaml, configPath)).rejects.toThrow(invalidYaml);
	});

	it("recursively discovers Markdown in stable order and deduplicates the same file", async () => {
		const root = await createTemporaryDirectory();
		const configPath = join(root, "tavern.json");
		const charactersDirectory = join(root, "characters");
		const architectPath = join(charactersDirectory, "architect.md");
		const developerPath = join(charactersDirectory, "nested", "developer.md");
		await mkdir(join(charactersDirectory, "nested"), { recursive: true });
		await writeFile(architectPath, "---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt");
		await writeFile(developerPath, "---\nname: Developer\ndescription: Development\n---\nDeveloper prompt");
		await writeFile(join(charactersDirectory, "notes.txt"), "ignored");

		const characters = await loadCharacterCards([
			{ path: charactersDirectory, configPath },
			{ path: architectPath, configPath },
		]);

		expect(characters.map((character) => character.name)).toEqual(["Architect", "Developer"]);
	});

	it("rejects duplicate names from different Character files", async () => {
		const root = await createTemporaryDirectory();
		const configPath = join(root, "tavern.json");
		const firstPath = join(root, "first.md");
		const secondPath = join(root, "second.md");
		await writeFile(firstPath, "---\nname: Reviewer\ndescription: First\n---\nFirst");
		await writeFile(secondPath, "---\nname: Reviewer\ndescription: Second\n---\nSecond");

		await expect(
			loadCharacterCards([
				{ path: firstPath, configPath },
				{ path: secondPath, configPath },
			]),
		).rejects.toThrow(/duplicate Character name.*Reviewer/i);
	});

	it("loads a claimed Character using server identity and verifies its public summary", async () => {
		const root = await createTemporaryDirectory();
		const characterPath = join(root, "reviewer.md");
		await writeFile(characterPath, "---\nname: Reviewer\ndescription: Reviews code\n---\nReview prompt");

		await expect(
			loadClaimedCharacter({
				characterId: "global:reviewer",
				name: "Reviewer",
				description: "Reviews code",
				path: characterPath,
			}),
		).resolves.toEqual({
			characterId: "global:reviewer",
			name: "Reviewer",
			description: "Reviews code",
			path: characterPath,
			prompt: "Review prompt",
		});

		await expect(
			loadClaimedCharacter({
				characterId: "global:reviewer",
				name: "Changed",
				description: "Reviews code",
				path: characterPath,
			}),
		).rejects.toThrow(/no longer matches/i);
	});
});
