import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

import type { TavernController } from "./controller/tavern-controller.js";
import type { CreatorRuntime } from "./creator/creator-runtime.js";

export interface RegisterCommandsOptions {
	agentDir?: string;
	configMaxMessages?: number;
}

const DEFAULT_CONFIG_MAX_MESSAGES = 10;

export function registerCommands(
	pi: ExtensionAPI,
	controller: TavernController,
	options: RegisterCommandsOptions = {},
): void {
	const agentDir = options.agentDir ?? getAgentDir();
	const configMaxMessages = options.configMaxMessages ?? DEFAULT_CONFIG_MAX_MESSAGES;

	pi.registerCommand("tavern-new", {
		description: "Create a new PiTavern group chat",
		handler: async (_args, ctx) => {
			try {
				const runtime = await controller.startNew({
					cwd: ctx.cwd,
					agentDir,
					configMaxMessages,
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

	pi.registerCommand("tavern-status", {
		description: "Show the current PiTavern group chat status",
		handler: async (_args, ctx) => {
			const state = controller.getState();
			if (state.type === "idle") {
				ctx.ui.notify("No active group chat", "info");
				return;
			}

			ctx.ui.notify(formatCreatorStatus(state.runtime), "info");
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
			if (controller.getState().type === "idle") {
				ctx.ui.notify("No active group chat", "info");
				return;
			}

			try {
				await controller.leave();
				ctx.ui.notify("Group chat closed", "info");
			} catch (error) {
				notifyError(ctx.ui.notify, error);
			}
		},
	});
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
		`Group max messages: ${groupChat.groupMaxMessages}`,
		`Round: ${roundStatus}`,
	].join("\n");
}

function notifyError(notify: (message: string, type?: "info" | "warning" | "error") => void, error: unknown): void {
	notify(error instanceof Error ? error.message : String(error), "error");
}
