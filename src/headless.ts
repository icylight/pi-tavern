/**
 * ISSUE-014: headless RPC character mode — automatic group-chat join.
 *
 * A character pi started with PITAVERN_AUTO_JOIN=1 joins an active group
 * chat on session_start without any interactive UI: the group chat and
 * character are picked programmatically (env overrides, then the unique /
 * first candidate). Everything else (claim → ready → identity → speak →
 * group-chat input) reuses the interactive path unchanged.
 *
 * Env contract (documented in docs/headless-character.md):
 * - PITAVERN_AUTO_JOIN=1        enable auto-join
 * - PITAVERN_CHARACTER=<name|id>  pick a specific character card
 * - PITAVERN_GROUP_CHAT=<id|name> pick a specific group chat (else unique/first)
 */
import { join } from "node:path";

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TavernController } from "./controller/tavern-controller.js";
import { type ActiveGroupChatDescriptor, getGroupChatCursorDirectory } from "./data/discovery/active-descriptor.js";
import { discoverGroupChats } from "./data/discovery/discover-group-chats.js";

export interface AutoJoinOptions {
	agentDir?: string;
	character?: string;
	groupChat?: string;
}

/**
 * Minimal context surface needed by the auto-join flow. The interactive
 * path passes the real ExtensionContext; the headless launcher supplies a
 * synthetic adapter (process.cwd + generated session id + stderr notify),
 * because RPC mode has no session_start / resources_discover startup events.
 */
export interface AutoJoinContext {
	cwd: string;
	sessionManager: { getSessionId(): string };
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

function pickGroupChat(
	options: AutoJoinOptions,
	candidates: ActiveGroupChatDescriptor[],
): ActiveGroupChatDescriptor | undefined {
	const wanted = options.groupChat;
	if (wanted !== undefined && wanted !== "") {
		const byId = candidates.find((c) => c.groupChatId === wanted);
		if (byId) return byId;
		const byName = candidates.find((c) => c.name !== undefined && c.name !== null && c.name.includes(wanted));
		if (byName) return byName;
	}
	if (candidates.length === 1) {
		return candidates[0];
	}
	return candidates[0];
}

function pickCharacter(
	options: AutoJoinOptions,
	available: Array<{ character_id: string; name: string }>,
): { character_id: string; name: string } | undefined {
	const wanted = options.character;
	if (wanted !== undefined && wanted !== "") {
		const byId = available.find((c) => c.character_id === wanted);
		if (byId) return byId;
		const byName = available.find((c) => c.name === wanted || c.name.includes(wanted));
		if (byName) return byName;
	}
	return available[0];
}

/**
 * Auto-join an active group chat as a character. Pure programmatic flow:
 * no dialogs, no select() calls — headless RPC character mode (ISSUE-014).
 * Returns the joined character name, or null when nothing was joined.
 */
export async function autoJoinCharacter(
	pi: ExtensionAPI,
	controller: TavernController,
	ctx: AutoJoinContext,
	options: AutoJoinOptions = {},
): Promise<string | null> {
	const agentDir = options.agentDir ?? getAgentDir();
	const notify = (message: string, type: "info" | "warning" | "error" = "info") => {
		try {
			ctx.ui.notify(message, type);
		} catch {
			// Headless: notify is fire-and-forget; never fail the join on UI noise.
		}
	};

	if (controller.getState().type !== "idle") {
		notify(`Auto-join skipped: PiTavern is ${controller.getState().type}`, "warning");
		return null;
	}

	const candidates = await discoverGroupChats({ agentDir, cwd: ctx.cwd });
	if (candidates.length === 0) {
		notify("Auto-join: no active group chat found for this project", "warning");
		return null;
	}
	const descriptor = pickGroupChat(options, candidates);
	if (!descriptor) {
		notify("Auto-join: no group chat candidate", "warning");
		return null;
	}

	const attempt = await controller.startJoining(descriptor, ctx.sessionManager.getSessionId(), {
		cursorStorePath: join(getGroupChatCursorDirectory(agentDir, ctx.cwd), `${descriptor.groupChatId}.json`),
	});
	if (!attempt.isActive) {
		notify("Auto-join: join attempt failed", "warning");
		return null;
	}
	if (attempt.availableCharacters.length === 0) {
		notify("Auto-join: no Character is available in this group chat", "warning");
		await controller.leave();
		return null;
	}
	const selected = pickCharacter(options, attempt.availableCharacters);
	if (!selected) {
		notify("Auto-join: no character candidate", "warning");
		await controller.leave();
		return null;
	}
	try {
		const runtime = await controller.claimCharacter(selected.character_id, pi);
		notify(`Auto-joined ${descriptor.name ?? descriptor.groupChatId} as ${runtime.character.name}`, "info");
		return runtime.character.name;
	} catch (error) {
		// A concurrent join may have taken the character: refresh once and
		// retry the pick, mirroring the interactive /tavern-join loop.
		if (controller.getState().type === "joining" && attempt.isActive) {
			try {
				await attempt.refreshAvailableCharacters();
			} catch {
				// Fall through to leave.
			}
			const retry = pickCharacter(options, attempt.availableCharacters);
			if (retry) {
				const runtime = await controller.claimCharacter(retry.character_id, pi);
				notify(`Auto-joined ${descriptor.name ?? descriptor.groupChatId} as ${runtime.character.name}`, "info");
				return runtime.character.name;
			}
		}
		notify(`Auto-join failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		await controller.leave();
		return null;
	}
}
