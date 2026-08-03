/**
 * ISSUE-014：headless RPC 角色模式——自动加入群聊。
 *
 * 以 PITAVERN_AUTO_JOIN=1 启动的 character pi 在 session_start 时无需任何
 * 交互 UI 即加入活跃群聊：群聊与角色以编程方式选定（env 覆盖，然后唯一/首个
 * 候选）。其余一切（claim → ready → identity → speak → 群聊输入）原样复用
 * 交互路径。
 *
 * 环境变量契约（见 docs/headless-character.md）：
 * - PITAVERN_AUTO_JOIN=1        启用自动加入
 * - PITAVERN_CHARACTER=<name|id>  指定角色卡
 * - PITAVERN_GROUP_CHAT=<id|name> 指定群聊（否则取唯一/首个候选）
 */
import { join } from "node:path";

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TavernController } from "./controller/tavern-controller.js";
import { type ActiveGroupChatDescriptor, getGroupChatCursorDirectory } from "./data/discovery/active-descriptor.js";
import type { DiscoverGroupChatsOptions } from "./data/discovery/discover-group-chats.js";

export interface AutoJoinOptions {
	agentDir?: string;
	character?: string;
	groupChat?: string;
	/** 行为默认实现由组合根装配注入（ADR-0005 层方向，Phase 4）。 */
	discoverGroupChats?: (options: DiscoverGroupChatsOptions) => Promise<ActiveGroupChatDescriptor[]>;
	/** 闲态触发窗口（Arch 提速项，注入化；undefined = 默认 1000ms）。 */
	triggerDebounceMs?: number;
}

/**
 * auto-join 流程所需的最小上下文面。交互路径传真实 ExtensionContext；
 * headless 启动器提供合成适配器（process.cwd + 生成 session id + stderr
 * notify），因为 RPC 模式没有 session_start / resources_discover 启动事件。
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
		const byName = candidates.find((c) => c.name?.includes(wanted));
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
 * 以角色身份自动加入活跃群聊。纯程序化流程：无对话框、无 select() 调用——
 * headless RPC 角色模式（ISSUE-014）。返回加入的角色名；未加入任何群聊时
 * 返回 null。
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
			// Headless：notify 是 fire-and-forget，不因 UI 噪音让 join 失败。
		}
	};

	if (controller.getState().type !== "idle") {
		notify(`Auto-join skipped: PiTavern is ${controller.getState().type}`, "warning");
		return null;
	}

	if (!options.discoverGroupChats) {
		throw new Error("autoJoinCharacter: discoverGroupChats must be injected by the composition root");
	}
	const candidates = await options.discoverGroupChats({ agentDir, cwd: ctx.cwd });
	if (candidates.length === 0) {
		notify("Auto-join: no active group chat found for this project", "warning");
		return null;
	}
	const descriptor = pickGroupChat(options, candidates);
	if (!descriptor) {
		notify("Auto-join: no group chat candidate", "warning");
		return null;
	}

	const sessionId = ctx.sessionManager.getSessionId();
	const attempt = await controller.startJoining(descriptor, sessionId, {
		...(options.triggerDebounceMs !== undefined ? { triggerDebounceMs: options.triggerDebounceMs } : {}),
		// 游标跟随 Session（User 2026-08-02）：cursors/<groupId>/<sessionId>.json，同群聊多角色互不共用
		cursorStorePath: join(getGroupChatCursorDirectory(agentDir, ctx.cwd), descriptor.groupChatId, `${sessionId}.json`),
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
		// 并发 join 可能已占走该角色：刷新一次再重试选择，
		// 与交互式 /tavern-join 循环一致。
		if (controller.getState().type === "joining" && attempt.isActive) {
			try {
				await attempt.refreshAvailableCharacters();
			} catch {
				// 落到 leave。
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
