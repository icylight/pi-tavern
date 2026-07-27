import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

import { type CharacterCard, type CharacterImport, loadCharacterCards } from "./character-card.js";

export interface TavernConfig {
	configMaxMessages: number;
	characters: CharacterCard[];
}

export interface LoadTavernConfigOptions {
	agentDir: string;
	cwd: string;
}

const TavernConfigFileSchema = Type.Object(
	{
		config_max_messages: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
		characters: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);

type TavernConfigFile = Static<typeof TavernConfigFileSchema>;

const checkTavernConfigFile = Compile(TavernConfigFileSchema);
const DEFAULT_CONFIG_MAX_MESSAGES = 10;

export async function loadTavernConfig(options: LoadTavernConfigOptions): Promise<TavernConfig> {
	const globalConfigPath = join(resolve(options.agentDir), "tavern.json");
	const projectConfigPath = join(resolve(options.cwd), ".pi", "tavern.json");
	const globalConfig = await readConfigFile(globalConfigPath);
	const projectConfig = await readConfigFile(projectConfigPath);
	const imports = [
		...toCharacterImports(globalConfig, globalConfigPath),
		...toCharacterImports(projectConfig, projectConfigPath),
	];

	return {
		configMaxMessages:
			projectConfig?.config_max_messages ?? globalConfig?.config_max_messages ?? DEFAULT_CONFIG_MAX_MESSAGES,
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
		throw new Error(`Failed to read PiTavern config: ${path}`, { cause: error });
	}

	let value: unknown;
	try {
		value = JSON.parse(contents);
	} catch (error) {
		throw new Error(`Failed to parse PiTavern config: ${path}`, { cause: error });
	}
	if (!checkTavernConfigFile.Check(value)) {
		throw new Error(`Invalid PiTavern config: ${path}`);
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
