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
import { loadTavernConfig, type TavernConfig } from "./config/load-config.js";
import type { TavernController } from "./controller/tavern-controller.js";
import { type ActiveGroupChatDescriptor, getGroupChatCursorDirectory } from "./data/discovery/active-descriptor.js";
import type { DiscoverGroupChatsOptions } from "./data/discovery/discover-group-chats.js";
import {
	ERROR_INJECTION_AUTO_JOIN_DISCOVER,
	HEADLESS_FAILED_PREFIX,
	HEADLESS_JOIN_ATTEMPT_FAILED,
	HEADLESS_JOINED_MID,
	HEADLESS_JOINED_PREFIX,
	HEADLESS_NO_ACTIVE_GROUP_CHAT,
	HEADLESS_NO_CHARACTER_AVAILABLE,
	HEADLESS_NO_CHARACTER_CANDIDATE,
	HEADLESS_NO_GROUP_CHAT_CANDIDATE,
	HEADLESS_SKIPPED_PREFIX,
} from "./shared/messages.js";

interface AutoJoinOptions {
	agentDir?: string;
	character?: string;
	groupChat?: string;
	/** 行为默认实现由组合根装配注入（ADR-0005 层方向，Phase 4）。 */
	discoverGroupChats?: (options: DiscoverGroupChatsOptions) => Promise<ActiveGroupChatDescriptor[]>;
	/** #154 T5：配置加载注入（默认 loadTavernConfig）——headless auto-join 与 /tavern-join 同生命周期。 */
	loadConfig?: (options: { agentDir: string; cwd: string }) => Promise<TavernConfig>;
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
		notify(`${HEADLESS_SKIPPED_PREFIX}${controller.getState().type}`, "warning");
		return null;
	}

	if (!options.discoverGroupChats) {
		throw new Error(ERROR_INJECTION_AUTO_JOIN_DISCOVER);
	}
	const candidates = await options.discoverGroupChats({ agentDir, cwd: ctx.cwd });
	if (candidates.length === 0) {
		notify(HEADLESS_NO_ACTIVE_GROUP_CHAT, "warning");
		return null;
	}
	const descriptor = pickGroupChat(options, candidates);
	if (!descriptor) {
		notify(HEADLESS_NO_GROUP_CHAT_CANDIDATE, "warning");
		return null;
	}

	const sessionId = ctx.sessionManager.getSessionId();
	// #154 T5：headless auto-join 与 /tavern-join 同生命周期——本地加载配置，
	// 自定义模板集随 claim 达 CharacterRuntime（苍蓝星阻断 3 修复）。
	const loadConfig = options.loadConfig ?? loadTavernConfig;
	const joinConfig = await loadConfig({ agentDir, cwd: ctx.cwd });
	const attempt = await controller.startJoining(descriptor, sessionId, {
		...(options.triggerDebounceMs !== undefined ? { triggerDebounceMs: options.triggerDebounceMs } : {}),
		// 游标跟随 Session（User 2026-08-02）：cursors/<groupId>/<sessionId>.json，同群聊多角色互不共用
		cursorStorePath: join(getGroupChatCursorDirectory(agentDir, ctx.cwd), descriptor.groupChatId, `${sessionId}.json`),
		...(joinConfig.messageTemplates !== undefined ? { messageTemplates: joinConfig.messageTemplates } : {}),
		// #154 复评：路径透传，reload 时重新加载磁盘配置（模板修改落盘后生效）。
		agentDir,
		cwd: ctx.cwd,
	});
	if (!attempt.isActive) {
		notify(HEADLESS_JOIN_ATTEMPT_FAILED, "warning");
		return null;
	}
	if (attempt.availableCharacters.length === 0) {
		notify(HEADLESS_NO_CHARACTER_AVAILABLE, "warning");
		await controller.leave();
		return null;
	}
	const selected = pickCharacter(options, attempt.availableCharacters);
	if (!selected) {
		notify(HEADLESS_NO_CHARACTER_CANDIDATE, "warning");
		await controller.leave();
		return null;
	}
	try {
		const runtime = await controller.claimCharacter(selected.character_id, pi);
		notify(
			`${HEADLESS_JOINED_PREFIX}${descriptor.name ?? descriptor.groupChatId}${HEADLESS_JOINED_MID}${runtime.character.name}`,
			"info",
		);
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
				notify(
					`${HEADLESS_JOINED_PREFIX}${descriptor.name ?? descriptor.groupChatId}${HEADLESS_JOINED_MID}${runtime.character.name}`,
					"info",
				);
				return runtime.character.name;
			}
		}
		notify(`${HEADLESS_FAILED_PREFIX}${error instanceof Error ? error.message : String(error)}`, "error");
		await controller.leave();
		return null;
	}
}
