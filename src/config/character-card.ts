import type { Dirent, Stats } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	ERROR_ACCESS_CHARACTER_IMPORT_PREFIX,
	ERROR_CLAIMED_SUMMARY_MISMATCH_PREFIX,
	ERROR_DUPLICATE_AND,
	ERROR_DUPLICATE_CHARACTER_ID_PREFIX,
	ERROR_DUPLICATE_CHARACTER_NAME_PREFIX,
	ERROR_DUPLICATE_SUFFIX,
	ERROR_IMPORT_NOT_FILE_OR_DIR_PREFIX,
	ERROR_MD_EXTENSION_PREFIX,
	ERROR_MD_MISSING_FIELD_FIELD_SUFFIX,
	ERROR_MD_MISSING_FIELD_PREFIX,
	ERROR_MD_MISSING_FIELD_SUFFIX,
	ERROR_PARSE_CHARACTER_MD_PREFIX,
	ERROR_READ_CHARACTER_DIR_PREFIX,
	ERROR_READ_CHARACTER_MD_PREFIX,
} from "../shared/messages.js";

export interface CharacterSummary {
	characterId: string;
	name: string;
	description: string;
}

/** 模型标识二元组：Model 类型无全局唯一单字段，同名 model 可跨 provider。 */
export interface ModelId {
	provider: string;
	id: string;
}

/**
 * 角色卡可选 model 字段的三态解析结果（#180）。
 * 仅基础存在性/类型检查（User 定案：不做格式/目录/枚举校验，解析/切换
 * 职责归 pi 执行器）：absent = 字段缺席（仅 undefined）；非 string/空串
 * = invalid；其余任意字符串（含无斜杠、自定义名）= ok 原样携带。
 * 解析失败不得导致角色卡加载/加入失败。
 */
export type ModelFieldStatus =
	| { status: "absent" }
	| { status: "ok"; model: string }
	| { status: "invalid"; raw: unknown };

/**
 * 角色卡可选 thinking 字段的三态解析结果（#180）。
 * 与 model 同规最小化：不做 7 值/大小写校验（pi 对非法值静默钳制，
 * 视为 pi 的正常处理）；仅基础存在性/类型检查。
 */
export type ThinkingFieldStatus =
	| { status: "absent" }
	| { status: "ok"; level: string }
	| { status: "invalid"; raw: unknown };

export interface CharacterCard extends CharacterSummary {
	path: string;
	prompt: string;
	/** 可选 model 字段（推荐 provider/id，任意非空字符串）三态；未配置 = absent。 */
	model?: ModelFieldStatus;
	/** 可选 thinking 字段（任意非空字符串，由 pi 应用时钳制）三态；未配置 = absent。 */
	thinking?: ThinkingFieldStatus;
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
		throw new Error(`${ERROR_READ_CHARACTER_MD_PREFIX}${resolvedPath}`, { cause: error });
	}

	let parsed: ReturnType<typeof parseFrontmatter>;
	try {
		parsed = parseFrontmatter(contents);
	} catch (error) {
		throw new Error(`${ERROR_PARSE_CHARACTER_MD_PREFIX}${resolvedPath}`, { cause: error });
	}

	const name = readRequiredString(parsed.frontmatter, "name", resolvedPath);
	const description = readRequiredString(parsed.frontmatter, "description", resolvedPath);

	return {
		characterId: toCharacterId(resolvedPath, configPath),
		name,
		description,
		path: resolvedPath,
		prompt: parsed.body,
		model: parseModelField(parsed.frontmatter.model),
		thinking: parseThinkingField(parsed.frontmatter.thinking),
	};
}

/**
 * 解析角色卡可选 model 字段（#180，最小三态）。
 *
 * - undefined（字段缺席）→ absent；
 * - 非 string / 空串（含纯空白）→ invalid，raw 原样携带；
 * - 其余任意字符串 → ok，原样携带（不做 provider/id 拆解校验，
 *   格式解析/模型解析归执行期）。
 */
export function parseModelField(raw: unknown): ModelFieldStatus {
	if (raw === undefined) {
		return { status: "absent" };
	}
	if (typeof raw !== "string" || raw.trim() === "") {
		return { status: "invalid", raw };
	}
	return { status: "ok", model: raw };
}

/**
 * 解析角色卡可选 thinking 字段（#180，最小三态）。
 * 与 model 同规：仅基础存在性/类型检查；非法值由 pi 在应用时钳制处理。
 */
export function parseThinkingField(raw: unknown): ThinkingFieldStatus {
	if (raw === undefined) {
		return { status: "absent" };
	}
	if (typeof raw !== "string" || raw.trim() === "") {
		return { status: "invalid", raw };
	}
	return { status: "ok", level: raw };
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
			throw new Error(
				`${ERROR_DUPLICATE_CHARACTER_NAME_PREFIX}${character.name}${ERROR_DUPLICATE_SUFFIX}${existingNamePath}${ERROR_DUPLICATE_AND}${character.path}`,
			);
		}
		const existingIdPath = characterIds.get(character.characterId);
		if (existingIdPath) {
			throw new Error(
				`${ERROR_DUPLICATE_CHARACTER_ID_PREFIX}${character.characterId}${ERROR_DUPLICATE_SUFFIX}${existingIdPath}${ERROR_DUPLICATE_AND}${character.path}`,
			);
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
		throw new Error(`${ERROR_CLAIMED_SUMMARY_MISMATCH_PREFIX}${loaded.path}`);
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
		throw new Error(`${ERROR_ACCESS_CHARACTER_IMPORT_PREFIX}${resolvedPath}`, { cause: error });
	}

	if (importedStat.isFile()) {
		if (!resolvedPath.endsWith(".md")) {
			throw new Error(`${ERROR_MD_EXTENSION_PREFIX}${resolvedPath}`);
		}
		return [resolvedPath];
	}
	if (!importedStat.isDirectory()) {
		throw new Error(`${ERROR_IMPORT_NOT_FILE_OR_DIR_PREFIX}${resolvedPath}`);
	}

	return discoverDirectory(resolvedPath);
}

async function discoverDirectory(directory: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		throw new Error(`${ERROR_READ_CHARACTER_DIR_PREFIX}${directory}`, { cause: error });
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
		throw new Error(
			`${ERROR_MD_MISSING_FIELD_PREFIX}${path}${ERROR_MD_MISSING_FIELD_SUFFIX}${field}${ERROR_MD_MISSING_FIELD_FIELD_SUFFIX}`,
		);
	}
	return value.trim();
}

function toCharacterId(path: string, configPath: string): string {
	return relative(dirname(resolve(configPath)), path)
		.split(sep)
		.join("/");
}
