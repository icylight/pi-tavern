import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
	type ActiveGroupChatDescriptor,
	getActiveDescriptorPath,
	getGroupChatSessionDirectory,
	readActiveDescriptor,
} from "../data/discovery/active-descriptor.js";

export interface GroupChatSessionSummary {
	/** Absolute path to the group chat history JSONL file. */
	path: string;
	groupChatId: string;
	/** Latest session_info display name, if any. */
	name: string | null;
	/** First public message text, used to display unnamed group chats. */
	firstMessage: string;
	created: Date;
	/** True when an active instance descriptor exists for this group chat. */
	active: boolean;
}

export interface DeleteGroupChatSessionResult {
	ok: boolean;
	method: "trash" | "unlink";
	error?: string;
}

export interface TrashResult {
	status: number | null;
	error?: Error;
	stderr?: string;
}

export interface GroupChatSessionDependencies {
	trash: (path: string) => TrashResult;
	exists: (path: string) => boolean;
	unlink: (path: string) => Promise<void>;
	readActiveDescriptor: (path: string) => Promise<ActiveGroupChatDescriptor | null>;
}

export type DeleteGroupChatSessionDependencies = Pick<GroupChatSessionDependencies, "trash" | "exists" | "unlink">;

const defaultDependencies: GroupChatSessionDependencies = {
	trash: (path) => {
		const args = path.startsWith("-") ? ["--", path] : [path];
		return spawnSync("trash", args, { encoding: "utf-8" });
	},
	exists: (path) => existsSync(path),
	unlink: (path) => unlink(path),
	readActiveDescriptor,
};

/**
 * List persisted group chat sessions for a project, newest first, marking
 * those that are currently active (they cannot be resumed). The displayed
 * first message is scanned from the file itself: pi's SessionManager.list()
 * only counts type === "message" entries, while group chat public messages
 * are custom_message entries, so its firstMessage is always "(no messages)".
 */
export async function listGroupChatSessions(
	agentDir: string,
	cwd: string,
	deps: GroupChatSessionDependencies = defaultDependencies,
): Promise<GroupChatSessionSummary[]> {
	const sessionDir = getGroupChatSessionDirectory(agentDir, cwd);
	const sessions = await SessionManager.list(cwd, sessionDir);
	const summaries: GroupChatSessionSummary[] = [];
	for (const session of sessions) {
		const activeDescriptor = await deps.readActiveDescriptor(getActiveDescriptorPath(agentDir, cwd, session.id));
		summaries.push({
			path: session.path,
			groupChatId: session.id,
			name: session.name?.trim() || null,
			firstMessage: firstPublicMessageFrom(session.path, sessionDir, cwd),
			created: session.created,
			active: activeDescriptor !== null,
		});
	}
	return summaries;
}

/** Scan a session file for the first pi-tavern.public-message content. */
function firstPublicMessageFrom(sessionPath: string, sessionDir: string, cwd: string): string {
	if (!existsSync(sessionPath)) {
		return "";
	}
	const manager = SessionManager.open(sessionPath, sessionDir, cwd);
	for (const entry of manager.getEntries()) {
		if (entry.type === "custom_message" && entry.customType === "pi-tavern.public-message") {
			return typeof entry.content === "string" ? entry.content : "";
		}
	}
	return "";
}

/**
 * Delete a group chat history file following pi's own session deletion
 * semantics: try the `trash` CLI first, fall back to permanent unlink.
 */
export async function deleteGroupChatSession(
	path: string,
	deps: DeleteGroupChatSessionDependencies = defaultDependencies,
): Promise<DeleteGroupChatSessionResult> {
	const trashResult = deps.trash(path);
	if (trashResult.status === 0 || !deps.exists(path)) {
		return { ok: true, method: "trash" };
	}
	try {
		await deps.unlink(path);
		return { ok: true, method: "unlink" };
	} catch (error) {
		const unlinkError = error instanceof Error ? error.message : String(error);
		const trashErrorHint = trashResult.error?.message ?? trashResult.stderr?.trim();
		return {
			ok: false,
			method: "unlink",
			error: trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError,
		};
	}
}
