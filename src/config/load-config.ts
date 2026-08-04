import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import {
	ERROR_INVALID_CONFIG_PREFIX,
	ERROR_PARSE_CONFIG_PREFIX,
	ERROR_READ_CONFIG_PREFIX,
} from "../shared/messages.js";
import { type CharacterCard, type CharacterImport, loadCharacterCards } from "./character-card.js";

export interface TavernConfig {
	configMaxMessages: number;
	characters: CharacterCard[];
	/**
	 * 白板模型（#114）：白板额度（可选——缺省 = store 默认 5/140，PR #116 F4
	 * 兑现「可配置」承诺）。装配透传：commands → startNew/resume → creator-factory
	 * → createBoardStore；未配置时 undefined 走 store 默认。
	 */
	boardMaxNotes?: number;
	boardMaxNoteLength?: number;
}

export interface LoadTavernConfigOptions {
	agentDir: string;
	cwd: string;
}

const TavernConfigFileSchema = Type.Object(
	{
		config_max_messages: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
		characters: Type.Optional(Type.Array(Type.String())),
		// 白板模型（#114）：白板额度（可选；最小 1——额度 0 无业务意义）。
		board_max_notes: Type.Optional(Type.Integer({ minimum: 1 })),
		board_max_note_length: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

type TavernConfigFile = Static<typeof TavernConfigFileSchema>;

const checkTavernConfigFile = Compile(TavernConfigFileSchema);
/**
 * #37 (2026-08-02)：新建群聊的默认消息配额。唯一事实源——
 * creator-runtime.ts 与 commands.ts import 本常量而非重复声明
 * （三个相同的常量曾是 10→100 配额漏改的根因）。
 */
export const DEFAULT_CONFIG_MAX_MESSAGES = 20;

export async function loadTavernConfig(options: LoadTavernConfigOptions): Promise<TavernConfig> {
	const globalConfigPath = join(resolve(options.agentDir), "tavern.json");
	const projectConfigPath = join(resolve(options.cwd), ".pi", "tavern.json");
	const globalConfig = await readConfigFile(globalConfigPath);
	const projectConfig = await readConfigFile(projectConfigPath);
	const imports = [
		...toCharacterImports(globalConfig, globalConfigPath),
		...toCharacterImports(projectConfig, projectConfigPath),
	];

	const boardMaxNotes = projectConfig?.board_max_notes ?? globalConfig?.board_max_notes;
	const boardMaxNoteLength = projectConfig?.board_max_note_length ?? globalConfig?.board_max_note_length;

	return {
		configMaxMessages:
			projectConfig?.config_max_messages ?? globalConfig?.config_max_messages ?? DEFAULT_CONFIG_MAX_MESSAGES,
		...(boardMaxNotes !== undefined ? { boardMaxNotes } : {}),
		...(boardMaxNoteLength !== undefined ? { boardMaxNoteLength } : {}),
		characters: await loadCharacterCards(imports),
	};
}

async function readConfigFile(path: string): Promise<TavernConfigFile | null> {
	let contents: string;
	try {
		contents = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return null;
		}
		throw new Error(`${ERROR_READ_CONFIG_PREFIX}${path}`, { cause: error });
	}

	let value: unknown;
	try {
		value = JSON.parse(contents);
	} catch (error) {
		throw new Error(`${ERROR_PARSE_CONFIG_PREFIX}${path}`, { cause: error });
	}
	if (!checkTavernConfigFile.Check(value)) {
		throw new Error(`${ERROR_INVALID_CONFIG_PREFIX}${path}`);
	}
	return value;
}

function toCharacterImports(config: TavernConfigFile | null, configPath: string): CharacterImport[] {
	return (config?.characters ?? []).map((path) => ({
		path: resolve(dirname(configPath), path),
		configPath,
	}));
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === code;
}
