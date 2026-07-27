import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CharacterRuntime } from "./character/character-runtime.js";
import { loadTavernConfig, type TavernConfig } from "./config/load-config.js";
import type { TavernController } from "./controller/tavern-controller.js";
import type { CreatorRuntime } from "./creator/creator-runtime.js";
import type { ActiveGroupChatDescriptor } from "./discovery/active-descriptor.js";
import {
	type DiscoverGroupChatsOptions,
	discoverGroupChats as discoverActiveGroupChats,
} from "./discovery/discover-group-chats.js";

export interface RegisterCommandsOptions {
	agentDir?: string;
	configMaxMessages?: number;
	loadConfig?: (options: { agentDir: string; cwd: string }) => Promise<TavernConfig>;
	discoverGroupChats?: (options: DiscoverGroupChatsOptions) => Promise<ActiveGroupChatDescriptor[]>;
}

const DEFAULT_CONFIG_MAX_MESSAGES = 10;

export function registerCommands(
	pi: ExtensionAPI,
	controller: TavernController,
	options: RegisterCommandsOptions = {},
): void {
	const agentDir = options.agentDir ?? getAgentDir();
	const loadConfig = options.loadConfig ?? loadTavernConfig;
	const discoverGroupChats = options.discoverGroupChats ?? discoverActiveGroupChats;

	pi.registerCommand("tavern-new", {
		description: "Create a new PiTavern group chat",
		handler: async (_args, ctx) => {
			try {
				const config = await loadConfig({ agentDir, cwd: ctx.cwd });
				const runtime = await controller.startNew({
					cwd: ctx.cwd,
					agentDir,
					configMaxMessages: options.configMaxMessages ?? config.configMaxMessages ?? DEFAULT_CONFIG_MAX_MESSAGES,
					characters: config.characters,
				});
				ctx.ui.notify(
					`Created group chat ${runtime.state.groupChat.groupChatId} at ${runtime.activeDescriptor.host}:${runtime.activeDescriptor.port}`,
					"info",
				);
			} catch (error) {
				notifyError(ctx.ui.notify, error);
			}
		},
	});

	pi.registerCommand("tavern-join", {
		description: "Join an active PiTavern group chat as a Character",
		handler: async (_args, ctx) => {
			try {
				if (!ctx.hasUI) {
					throw new Error("/tavern-join requires an interactive UI");
				}
				const candidates = await discoverGroupChats({
					agentDir,
					cwd: ctx.cwd,
				});
				if (candidates.length === 0) {
					ctx.ui.notify("No active group chat found for this project", "info");
					return;
				}
				const descriptor = await selectGroupChat(candidates, ctx.ui.select);
				if (!descriptor) {
					return;
				}
				const attempt = await controller.startJoining(descriptor, ctx.sessionManager.getSessionId());

				while (attempt.isActive) {
					if (attempt.availableCharacters.length === 0) {
						ctx.ui.notify("No Character is currently available in this group chat", "info");
						await controller.leave();
						return;
					}
					const selected = await selectCharacter(attempt.availableCharacters, ctx.ui.select);
					if (!selected) {
						await controller.leave();
						return;
					}
					try {
						const runtime = await controller.claimCharacter(selected.character_id, pi);
						ctx.ui.notify(`Joined ${descriptor.name ?? descriptor.groupChatId} as ${runtime.character.name}`, "info");
						return;
					} catch (error) {
						if (controller.getState().type !== "joining" || !attempt.isActive) {
							throw error;
						}
						notifyError(ctx.ui.notify, error, "warning");
						await attempt.refreshAvailableCharacters();
					}
				}
			} catch (error) {
				notifyError(ctx.ui.notify, error);
			}
		},
	});

	pi.registerCommand("tavern-status", {
		description: "Show the current PiTavern group chat status",
		handler: async (_args, ctx) => {
			const state = controller.getState();
			if (state.type === "idle") {
				ctx.ui.notify("No active group chat", "info");
				return;
			}
			if (state.type === "joining") {
				ctx.ui.notify(`Joining group chat; ${state.attempt.availableCharacters.length} Characters available`, "info");
				return;
			}
			if (state.type === "creator") {
				ctx.ui.notify(formatCreatorStatus(state.runtime), "info");
				return;
			}
			try {
				const snapshot = await state.runtime.getGroupChatState();
				ctx.ui.notify(formatCharacterStatus(state.runtime, snapshot), "info");
			} catch (error) {
				notifyError(ctx.ui.notify, error);
			}
		},
	});

	pi.registerCommand("tavern-name", {
		description: "Set the current group chat name",
		handler: async (args, ctx) => {
			if (!isCreator(controller, ctx.ui.notify)) {
				return;
			}

			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /tavern-name <name>", "error");
				return;
			}

			try {
				const normalizedName = await controller.setName(name);
				ctx.ui.notify(`Group chat name set to ${normalizedName}`, "info");
			} catch (error) {
				notifyError(ctx.ui.notify, error);
			}
		},
	});

	pi.registerCommand("tavern-set-max", {
		description: "Set the maximum Character messages for future rounds",
		handler: async (args, ctx) => {
			if (!isCreator(controller, ctx.ui.notify)) {
				return;
			}

			const value = args.trim();
			if (!/^\d+$/.test(value)) {
				ctx.ui.notify("Usage: /tavern-set-max <non-negative integer>", "error");
				return;
			}
			const maxMessages = Number(value);
			if (!Number.isSafeInteger(maxMessages)) {
				ctx.ui.notify("Maximum messages must be a non-negative safe integer", "error");
				return;
			}

			try {
				await controller.setMaxMessages(maxMessages);
				ctx.ui.notify(`Group max messages set to ${maxMessages}`, "info");
			} catch (error) {
				notifyError(ctx.ui.notify, error);
			}
		},
	});

	pi.registerCommand("tavern-leave", {
		description: "Close or leave the current PiTavern group chat",
		handler: async (_args, ctx) => {
			const state = controller.getState();
			if (state.type === "idle") {
				ctx.ui.notify("No active group chat", "info");
				return;
			}

			try {
				await controller.leave();
				ctx.ui.notify(
					state.type === "creator"
						? "Group chat closed"
						: state.type === "joining"
							? "Join cancelled"
							: "Left group chat",
					"info",
				);
			} catch (error) {
				notifyError(ctx.ui.notify, error);
			}
		},
	});
}

async function selectGroupChat(
	candidates: ActiveGroupChatDescriptor[],
	select: (title: string, options: string[]) => Promise<string | undefined>,
): Promise<ActiveGroupChatDescriptor | null> {
	if (candidates.length === 1) {
		return candidates[0] ?? null;
	}
	const labels = candidates.map((candidate) => `${candidate.name ?? "Unnamed group chat"} (${candidate.groupChatId})`);
	const selected = await select("Choose a group chat", labels);
	const index = selected === undefined ? -1 : labels.indexOf(selected);
	return index >= 0 ? (candidates[index] ?? null) : null;
}

async function selectCharacter(
	characters: Array<{
		character_id: string;
		name: string;
		description: string;
	}>,
	select: (title: string, options: string[]) => Promise<string | undefined>,
) {
	const labels = characters.map((character) => `${character.name} — ${character.description}`);
	const selected = await select("Choose a Character", labels);
	const index = selected === undefined ? -1 : labels.indexOf(selected);
	return index >= 0 ? characters[index] : undefined;
}

function isCreator(
	controller: TavernController,
	notify: (message: string, type?: "info" | "warning" | "error") => void,
): boolean {
	const state = controller.getState();
	if (state.type !== "creator") {
		notify("This command is only available to the group chat creator", "error");
		return false;
	}
	return true;
}

function formatCreatorStatus(runtime: CreatorRuntime): string {
	const { groupChat, round, onlineCharacters } = runtime.state;
	const roundStatus = round ? `${round.usedMessages}/${round.roundMaxMessages} messages used` : "not started";

	return [
		`Group chat: ${groupChat.name ?? groupChat.groupChatId}`,
		`ID: ${groupChat.groupChatId}`,
		`Listening: ${runtime.activeDescriptor.host}:${runtime.activeDescriptor.port}`,
		`Online Characters: ${onlineCharacters.size}`,
		`Config max messages: ${runtime.configMaxMessages}`,
		`Group max messages: ${groupChat.groupMaxMessages}`,
		`Round: ${roundStatus}`,
	].join("\n");
}

function formatCharacterStatus(
	runtime: CharacterRuntime,
	snapshot: Awaited<ReturnType<CharacterRuntime["getGroupChatState"]>>,
): string {
	const self = snapshot.online_characters.find((character) => character.is_self);
	return [
		`Group chat: ${snapshot.group_chat.name ?? snapshot.group_chat.group_chat_id}`,
		`Character: ${runtime.character.name}`,
		`Online Characters: ${snapshot.online_characters.length}`,
		`Streaming: ${self?.is_streaming ?? false}`,
		`Hand raised: ${self?.hand_raised ?? false}`,
	].join("\n");
}

function notifyError(
	notify: (message: string, type?: "info" | "warning" | "error") => void,
	error: unknown,
	type: "warning" | "error" = "error",
): void {
	notify(error instanceof Error ? error.message : String(error), type);
}
