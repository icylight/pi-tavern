import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
	type ActiveGroupChatDescriptor,
	getActiveDescriptorPath,
	getGroupChatSessionDirectory,
	readActiveDescriptor,
} from "./discovery/active-descriptor.js";

export interface GroupChatSessionSummary {
	/** 群聊历史 JSONL 文件的绝对路径。 */
	path: string;
	groupChatId: string;
	/** 最近的 session_info 显示名（若有）。 */
	name: string | null;
	/** 首条公共消息文本，用于展示未命名群聊。 */
	firstMessage: string;
	created: Date;
	/** 存在该群聊的活跃实例描述符时为 true。 */
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

/**
 * 会话摘要的本地结构接口（pi SessionInfo 的结构子集）。skills 不 import pi
 * 包（ADR-0005 §2），真实现由 adapter 层（commands.ts）装配。
 */
export interface GroupChatSessionInfoLike {
	id: string;
	path: string;
	name?: string | null;
	created: Date;
}

/** 会话条目的本地结构接口（pi SessionEntry 的结构子集）。 */
export interface GroupChatSessionEntryLike {
	type: string;
	customType?: string;
	content?: unknown;
}

export interface GroupChatSessionReaderLike {
	getEntries(): GroupChatSessionEntryLike[];
}

/** SessionManager 静态面：list / open。真实现由调用方装配 pi 的 SessionManager。 */
export interface GroupChatSessionManagerLike {
	list(cwd: string, sessionDir: string): Promise<GroupChatSessionInfoLike[]>;
	open(path: string, sessionDir: string, cwd: string): GroupChatSessionReaderLike;
}

export interface GroupChatSessionDependencies {
	/** pi SessionManager 注入面（skills 不 import pi 包）。 */
	sessionManager: GroupChatSessionManagerLike;
	trash: (path: string) => TrashResult;
	exists: (path: string) => boolean;
	unlink: (path: string) => Promise<void>;
	readActiveDescriptor: (path: string) => Promise<ActiveGroupChatDescriptor | null>;
}

export type DeleteGroupChatSessionDependencies = Pick<GroupChatSessionDependencies, "trash" | "exists" | "unlink"> & {
	/** #107（G6）：读取会话文件 header（推导 groupChatId——sidecar 真实路径）。 */
	readFile?: (path: string) => string;
};

/** 非 pi 依赖的默认实现（node 原语 + data/discovery），供调用方与 sessionManager 拼装。 */
export const defaultGroupChatSessionIoDependencies: Omit<GroupChatSessionDependencies, "sessionManager"> = {
	trash: (path) => {
		const args = path.startsWith("-") ? ["--", path] : [path];
		return spawnSync("trash", args, { encoding: "utf-8" });
	},
	exists: (path) => existsSync(path),
	unlink: (path) => unlink(path),
	readActiveDescriptor,
};

const defaultDeleteDependencies: DeleteGroupChatSessionDependencies = {
	...defaultGroupChatSessionIoDependencies,
	readFile: (path) => readFileSync(path, "utf8"),
};

/**
 * 列出项目下已持久化的群聊会话，最新在前，并标记当前活跃的（不可
 * resume）。展示的首条消息从文件本身扫描：pi 的 SessionManager.list()
 * 只统计 type === "message" 条目，而群聊公共消息是 custom_message 条目，
 * 因此它的 firstMessage 永远是 "(no messages)"。
 */
export async function listGroupChatSessions(
	agentDir: string,
	cwd: string,
	deps: GroupChatSessionDependencies,
): Promise<GroupChatSessionSummary[]> {
	const sessionDir = getGroupChatSessionDirectory(agentDir, cwd);
	const sessions = await deps.sessionManager.list(cwd, sessionDir);
	const summaries: GroupChatSessionSummary[] = [];
	for (const session of sessions) {
		const activeDescriptor = await deps.readActiveDescriptor(getActiveDescriptorPath(agentDir, cwd, session.id));
		summaries.push({
			path: session.path,
			groupChatId: session.id,
			name: session.name?.trim() || null,
			firstMessage: firstPublicMessageFrom(session.path, sessionDir, cwd, deps.sessionManager),
			created: session.created,
			active: activeDescriptor !== null,
		});
	}
	return summaries;
}

/** 扫描会话文件，取第一条 pi-tavern.public-message 内容。 */
function firstPublicMessageFrom(
	sessionPath: string,
	sessionDir: string,
	cwd: string,
	sessionManager: GroupChatSessionManagerLike,
): string {
	if (!existsSync(sessionPath)) {
		return "";
	}
	const manager = sessionManager.open(sessionPath, sessionDir, cwd);
	for (const entry of manager.getEntries()) {
		if (entry.type === "custom_message" && entry.customType === "pi-tavern.public-message") {
			return typeof entry.content === "string" ? entry.content : "";
		}
	}
	return "";
}

/**
 * 按 pi 自身的会话删除语义删除群聊历史文件：先尝试 `trash` CLI，
 * 失败则回退到永久 unlink。
 * #107（F8）：同步删除决策状态 sidecar（{id}.decisions.jsonl），
 * 不留不可见的决策历史（best-effort：sidecar 缺失不报错）。
 */
export async function deleteGroupChatSession(
	path: string,
	deps: DeleteGroupChatSessionDependencies = defaultDeleteDependencies,
	groupChatId?: string,
): Promise<DeleteGroupChatSessionResult> {
	// G6：sidecar 真实路径需 groupChatId——**主文件删除前**先解析
	// （显式参数优先，回退 header 首行推导；删后读不到 header）。
	const resolvedGroupChatId = groupChatId ?? readGroupChatIdFromHeader(path, deps);
	const trashResult = deps.trash(path);
	if (trashResult.status === 0 || !deps.exists(path)) {
		// 主文件已删除/入回收站——同步处理决策 sidecar。
		await deleteDecisionSidecar(path, deps, resolvedGroupChatId);
		return { ok: true, method: "trash" };
	}
	try {
		await deps.unlink(path);
		await deleteDecisionSidecar(path, deps, resolvedGroupChatId);
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

/** #107（F8）：决策 sidecar 路径 = 会话文件同目录、同名去扩展名 + .decisions.jsonl。 */
function decisionSidecarPath(sessionPath: string, groupChatId?: string): string {
	const dir = dirname(sessionPath);
	// G6（二轮审查）：真实路径 = {groupChatId}.decisions.jsonl（与
	// creator-factory 同源命名）；groupChatId 未知时回退 basename 推导。
	if (groupChatId) {
		return join(dir, `${groupChatId}.decisions.jsonl`);
	}
	const base = basename(sessionPath).replace(/\.[^.]+$/, "");
	return join(dir, `${base}.decisions.jsonl`);
}

/** 从会话文件 header（首行 JSON）读取 groupChatId（读失败 = undefined）。 */
function readGroupChatIdFromHeader(sessionPath: string, deps: DeleteGroupChatSessionDependencies): string | undefined {
	try {
		const firstLine = deps.readFile?.(sessionPath)?.split("\n")[0];
		if (!firstLine) {
			return undefined;
		}
		const header = JSON.parse(firstLine) as { id?: unknown };
		return typeof header.id === "string" ? header.id : undefined;
	} catch {
		return undefined;
	}
}

/** 删除决策 sidecar（best-effort：trash 优先，回退 unlink；缺失 = 忽略）。 */
async function deleteDecisionSidecar(
	sessionPath: string,
	deps: DeleteGroupChatSessionDependencies,
	groupChatId?: string,
): Promise<void> {
	// G6：无显式 groupChatId 时从会话文件 header 首行推导（真实命名）。
	const resolvedId = groupChatId ?? readGroupChatIdFromHeader(sessionPath, deps);
	const sidecar = decisionSidecarPath(sessionPath, resolvedId);
	if (!deps.exists(sidecar)) {
		return;
	}
	const trashResult = deps.trash(sidecar);
	if (trashResult.status === 0 || !deps.exists(sidecar)) {
		return;
	}
	try {
		await deps.unlink(sidecar);
	} catch {
		// best-effort：主文件已删除，sidecar 残留不影响功能。
	}
}
