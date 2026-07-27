import type { Dirent, Stats } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface CharacterSummary {
	characterId: string;
	name: string;
	description: string;
}

export interface CharacterCard extends CharacterSummary {
	path: string;
	prompt: string;
}

export interface CharacterImport {
	path: string;
	configPath: string;
}

export interface ClaimedCharacter {
	characterId: string;
	name: string;
	description: string;
	path: string;
}

export async function loadCharacterCard(path: string, configPath: string): Promise<CharacterCard> {
	const resolvedPath = resolve(path);
	let contents: string;
	try {
		contents = await readFile(resolvedPath, "utf8");
	} catch (error) {
		throw new Error(`Failed to read Character Markdown: ${resolvedPath}`, { cause: error });
	}

	let parsed: ReturnType<typeof parseFrontmatter>;
	try {
		parsed = parseFrontmatter(contents);
	} catch (error) {
		throw new Error(`Failed to parse Character Markdown: ${resolvedPath}`, { cause: error });
	}

	const name = readRequiredString(parsed.frontmatter, "name", resolvedPath);
	const description = readRequiredString(parsed.frontmatter, "description", resolvedPath);

	return {
		characterId: toCharacterId(resolvedPath, configPath),
		name,
		description,
		path: resolvedPath,
		prompt: parsed.body,
	};
}

export async function loadCharacterCards(imports: CharacterImport[]): Promise<CharacterCard[]> {
	const discovered = new Map<string, { path: string; configPath: string }>();

	for (const characterImport of imports) {
		const paths = await discoverImport(characterImport.path);
		for (const path of paths) {
			const canonicalPath = await realpath(path);
			if (!discovered.has(canonicalPath)) {
				discovered.set(canonicalPath, {
					path: resolve(path),
					configPath: characterImport.configPath,
				});
			}
		}
	}

	const characters: CharacterCard[] = [];
	const names = new Map<string, string>();
	const characterIds = new Map<string, string>();
	for (const discoveredCharacter of discovered.values()) {
		const character = await loadCharacterCard(discoveredCharacter.path, discoveredCharacter.configPath);
		const existingNamePath = names.get(character.name);
		if (existingNamePath) {
			throw new Error(`Duplicate Character name "${character.name}" in ${existingNamePath} and ${character.path}`);
		}
		const existingIdPath = characterIds.get(character.characterId);
		if (existingIdPath) {
			throw new Error(`Duplicate Character ID "${character.characterId}" in ${existingIdPath} and ${character.path}`);
		}

		names.set(character.name, character.path);
		characterIds.set(character.characterId, character.path);
		characters.push(character);
	}

	return characters;
}

export async function loadClaimedCharacter(claimed: ClaimedCharacter): Promise<CharacterCard> {
	const loaded = await loadCharacterCard(claimed.path, resolve(dirname(claimed.path), "tavern.json"));
	if (loaded.name !== claimed.name || loaded.description !== claimed.description) {
		throw new Error(`Claimed Character no longer matches its public summary: ${loaded.path}`);
	}
	return {
		...loaded,
		characterId: claimed.characterId,
	};
}

async function discoverImport(path: string): Promise<string[]> {
	const resolvedPath = resolve(path);
	let importedStat: Stats;
	try {
		importedStat = await stat(resolvedPath);
	} catch (error) {
		throw new Error(`Failed to access Character import: ${resolvedPath}`, { cause: error });
	}

	if (importedStat.isFile()) {
		if (!resolvedPath.endsWith(".md")) {
			throw new Error(`Character file must use the .md extension: ${resolvedPath}`);
		}
		return [resolvedPath];
	}
	if (!importedStat.isDirectory()) {
		throw new Error(`Character import is not a file or directory: ${resolvedPath}`);
	}

	return discoverDirectory(resolvedPath);
}

async function discoverDirectory(directory: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		throw new Error(`Failed to read Character directory: ${directory}`, { cause: error });
	}
	entries.sort((left, right) => left.name.localeCompare(right.name));

	const paths: string[] = [];
	for (const entry of entries) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			paths.push(...(await discoverDirectory(path)));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			paths.push(path);
		}
	}
	return paths;
}

function readRequiredString(frontmatter: Record<string, unknown>, field: string, path: string): string {
	const value = frontmatter[field];
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`Character Markdown ${path} requires a non-empty "${field}" field`);
	}
	return value.trim();
}

function toCharacterId(path: string, configPath: string): string {
	return relative(dirname(resolve(configPath)), path)
		.split(sep)
		.join("/");
}
