import { join } from "node:path";

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CharacterRuntime } from "./character/character-runtime.js";
import { DEFAULT_CONFIG_MAX_MESSAGES, loadTavernConfig, type TavernConfig } from "./config/load-config.js";
import type { TavernController } from "./controller/tavern-controller.js";
import type { CreatorRuntime } from "./creator/creator-runtime.js";
import type { DeleteBoardResult } from "./data/board-store.js";
import {
	type ActiveGroupChatDescriptor,
	getGroupChatBoardDirectory,
	getGroupChatCursorDirectory,
} from "./data/discovery/active-descriptor.js";
import type { DiscoverGroupChatsOptions } from "./data/discovery/discover-group-chats.js";
import type { DeleteGroupChatSessionResult, GroupChatSessionSummary } from "./data/group-chat-sessions.js";
import {
	CMD_DESC_JOIN,
	CMD_DESC_LEAVE,
	CMD_DESC_NAME,
	CMD_DESC_NEW,
	CMD_DESC_RESUME,
	CMD_DESC_SET_MAX,
	CMD_DESC_STATUS,
	CMD_DESC_TEST_BUSY,
	CMD_DESC_TEST_HISTORY,
	CMD_DESC_TEST_MESSAGE,
	CMD_DESC_TEST_RELOAD,
	CMD_DESC_TEST_WHOAMI,
	CONFIRM_DELETE_HISTORY_BODY_PREFIX,
	CONFIRM_DELETE_HISTORY_TITLE,
	ERROR_CREATOR_ONLY,
	ERROR_DELETE_HISTORY_FAILED_PREFIX,
	ERROR_GROUP_CHAT_CLOSED,
	ERROR_INJECTION_DELETE_SESSION,
	ERROR_INJECTION_DISCOVER,
	ERROR_INJECTION_LIST_SESSIONS,
	ERROR_JOIN_REQUIRES_UI,
	ERROR_LEFT_GROUP_CHAT,
	ERROR_NO_ACTIVE_GROUP_CHAT,
	ERROR_NO_ACTIVE_GROUP_CHAT_FOR_PROJECT,
	ERROR_RESUME_REQUIRES_UI,
	NOTIFY_CREATED_MID,
	NOTIFY_CREATED_PREFIX,
	NOTIFY_CREATOR_ONLY_MESSAGE,
	NOTIFY_DELETED_BOARD_FAIL_PREFIX,
	NOTIFY_DELETED_PREFIX,
	NOTIFY_DELETED_SUFFIX,
	NOTIFY_JOINED_AS,
	NOTIFY_JOINED_PREFIX,
	NOTIFY_JOINING_PREFIX,
	NOTIFY_JOINING_SUFFIX,
	NOTIFY_MAX_MESSAGES_INVALID,
	NOTIFY_MAX_SET_PREFIX,
	NOTIFY_MESSAGE_PUBLISHED,
	NOTIFY_NAME_SET_PREFIX,
	NOTIFY_NO_CHARACTER_AVAILABLE,
	NOTIFY_NO_RESUMABLE_GROUP_CHAT,
	NOTIFY_NOT_IN_CHARACTER_STATE,
	NOTIFY_RESUMED_PREFIX,
	NOTIFY_USAGE_NAME,
	NOTIFY_USAGE_SET_MAX,
	NOTIFY_USAGE_TEST_BUSY,
	SELECT_CHOOSE_CHARACTER,
	SELECT_CHOOSE_GROUP_CHAT,
	SELECT_DELETE_HISTORY_CHOICE,
	SELECT_DELETE_HISTORY_LABEL,
	SELECT_RESUME_LABEL,
	UI_GROUP_CHAT_LABEL_PREFIX,
	UI_ID_LABEL,
	UI_MESSAGES_USED,
	UI_ROUND_NOT_STARTED,
	UI_UNNAMED_GROUP_CHAT,
} from "./shared/messages.js";

interface RegisterCommandsOptions {
	agentDir?: string;
	configMaxMessages?: number;
	loadConfig?: (options: { agentDir: string; cwd: string }) => Promise<TavernConfig>;
	discoverGroupChats?: (options: DiscoverGroupChatsOptions) => Promise<ActiveGroupChatDescriptor[]>;
	listGroupChatSessions?: (agentDir: string, cwd: string) => Promise<GroupChatSessionSummary[]>;
	deleteGroupChatSession?: (path: string) => Promise<DeleteGroupChatSessionResult>;
	/**
	 * 白板模型（#114，ADR-0007 契约④）：删除群聊时同步清理白板文件
	 * （boards/<groupId>.json）。best-effort：失败仅 warning，不阻塞会话删除主流程。
	 * boardDir 由调用方按项目传入（index.ts 注册时无 cwd，闭包无法静态绑定）。
	 * 每调用新建 store 实例 = 无共享缓存；删除仅发生在非活跃群聊（resumable
	 * 语义），无并发写者，缓存一致性成立（B3 活动实例复用同一 store 时另行显式摘除）。
	 */
	deleteBoard?: (groupId: string, boardDir: string) => Promise<DeleteBoardResult>;
	/** 闲态触发窗口（Arch 提速项，注入化；undefined = 默认 1000ms）。 */
	triggerDebounceMs?: number;
}

export function registerCommands(
	pi: ExtensionAPI,
	controller: TavernController,
	options: RegisterCommandsOptions = {},
): void {
	const agentDir = options.agentDir ?? getAgentDir();
	const loadConfig = options.loadConfig ?? loadTavernConfig;
	// 行为默认实现由组合根（index.ts）装配注入（ADR-0005 层方向，Phase 4）；
	// 未注入时调用点为装配错误，显式报错。
	const discoverGroupChats = options.discoverGroupChats;
	// 行为默认实现由组合根（index.ts）装配注入（ADR-0005 层方向，Phase 4）。
	const listGroupChatSessions = options.listGroupChatSessions;
	const deleteGroupChatSession = options.deleteGroupChatSession;
	const deleteBoard = options.deleteBoard;

	pi.registerCommand("tavern-new", {
		description: CMD_DESC_NEW,
		handler: async (_args, ctx) => {
			try {
				const config = await loadConfig({ agentDir, cwd: ctx.cwd });
				const runtime = await controller.startNew({
					cwd: ctx.cwd,
					agentDir,
					configMaxMessages: options.configMaxMessages ?? config.configMaxMessages ?? DEFAULT_CONFIG_MAX_MESSAGES,
					// 白板模型（#114）：白板额度透传（缺省 undefined → store 默认 5/140）。
					...(config.boardMaxNotes !== undefined ? { boardMaxNotes: config.boardMaxNotes } : {}),
					...(config.boardMaxNoteLength !== undefined ? { boardMaxNoteLength: config.boardMaxNoteLength } : {}),
					// #123：欢迎文案透传（缺省 undefined → creator-factory 回落代码默认值）。
					...(config.welcomeMessage !== undefined ? { welcomeMessage: config.welcomeMessage } : {}),
					characters: config.characters,
				});
				ctx.ui.notify(
					`${NOTIFY_CREATED_PREFIX}${runtime.state.groupChat.groupChatId}${NOTIFY_CREATED_MID}${runtime.activeDescriptor.host}:${runtime.activeDescriptor.port}`,
					"info",
				);
			} catch (error) {
				notifyError(ctx.ui.notify, error);
			}
		},
	});

	pi.registerCommand("tavern-resume", {
		description: CMD_DESC_RESUME,
		handler: async (_args, ctx) => {
			try {
				if (!ctx.hasUI) {
					throw new Error(ERROR_RESUME_REQUIRES_UI);
				}
				const config = await loadConfig({ agentDir, cwd: ctx.cwd });
				// 组合根契约：index.ts 装配注入行为默认实现（ADR-0005 层方向）。
				if (!listGroupChatSessions) {
					throw new Error(ERROR_INJECTION_LIST_SESSIONS);
				}
				const sessions = await listGroupChatSessions(agentDir, ctx.cwd);
				const resumable = sessions.filter((session) => !session.active);
				if (resumable.length === 0) {
					ctx.ui.notify(NOTIFY_NO_RESUMABLE_GROUP_CHAT, "info");
					return;
				}
				const deleteLabel = SELECT_DELETE_HISTORY_CHOICE;
				const labels = [...resumable.map(formatSessionLabel), deleteLabel];
				const choice = await ctx.ui.select(SELECT_RESUME_LABEL, labels);
				if (choice === undefined) {
					return;
				}
				if (choice === deleteLabel) {
					// 组合根契约：index.ts 装配注入行为默认实现（ADR-0005 层方向）——
					// 契约违反时显式报错（fail fast），替代非空断言（#89 check 清零）。
					if (!deleteGroupChatSession) {
						throw new Error(ERROR_INJECTION_DELETE_SESSION);
					}
					await runDeleteGroupChatFlow(
						resumable,
						ctx.ui.select,
						ctx.ui.confirm,
						ctx.ui.notify,
						deleteGroupChatSession,
						deleteBoard,
						getGroupChatBoardDirectory(agentDir, ctx.cwd),
					);
					return;
				}
				const session = resumable[labels.indexOf(choice)];
				if (!session) {
					return;
				}
				const runtime = await controller.startResume({
					cwd: ctx.cwd,
					agentDir,
					sessionPath: session.path,
					configMaxMessages: options.configMaxMessages ?? config.configMaxMessages ?? DEFAULT_CONFIG_MAX_MESSAGES,
					// 白板模型（#114）：白板额度透传（缺省 undefined → store 默认 5/140）。
					...(config.boardMaxNotes !== undefined ? { boardMaxNotes: config.boardMaxNotes } : {}),
					...(config.boardMaxNoteLength !== undefined ? { boardMaxNoteLength: config.boardMaxNoteLength } : {}),
					// #123：欢迎文案透传（缺省 undefined → creator-factory 回落代码默认值）。
					...(config.welcomeMessage !== undefined ? { welcomeMessage: config.welcomeMessage } : {}),
					characters: config.characters,
				});
				ctx.ui.notify(
					`${NOTIFY_RESUMED_PREFIX}${runtime.state.groupChat.groupChatId}${NOTIFY_CREATED_MID}${runtime.activeDescriptor.host}:${runtime.activeDescriptor.port}`,
					"info",
				);
			} catch (error) {
				notifyError(ctx.ui.notify, error);
			}
		},
	});

	pi.registerCommand("tavern-join", {
		description: CMD_DESC_JOIN,
		handler: async (_args, ctx) => {
			try {
				if (!ctx.hasUI) {
					throw new Error(ERROR_JOIN_REQUIRES_UI);
				}
				if (!discoverGroupChats) {
					throw new Error(ERROR_INJECTION_DISCOVER);
				}
				const candidates = await discoverGroupChats({
					agentDir,
					cwd: ctx.cwd,
				});
				if (candidates.length === 0) {
					ctx.ui.notify(ERROR_NO_ACTIVE_GROUP_CHAT_FOR_PROJECT, "info");
					return;
				}
				const descriptor = await selectGroupChat(candidates, ctx.ui.select);
				if (!descriptor) {
					return;
				}
				const sessionId = ctx.sessionManager.getSessionId();
				const attempt = await controller.startJoining(descriptor, sessionId, {
					...(options.triggerDebounceMs !== undefined ? { triggerDebounceMs: options.triggerDebounceMs } : {}),
					// 游标跟随 Session（User 2026-08-02）：cursors/<groupId>/<sessionId>.json，
					// 同群聊多角色互不共用游标文件；旧群聊级单文件由 loadCursor 兼容回退。
					cursorStorePath: join(
						getGroupChatCursorDirectory(agentDir, ctx.cwd),
						descriptor.groupChatId,
						`${sessionId}.json`,
					),
				});

				while (attempt.isActive) {
					if (attempt.availableCharacters.length === 0) {
						ctx.ui.notify(NOTIFY_NO_CHARACTER_AVAILABLE, "info");
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
						ctx.ui.notify(
							`${NOTIFY_JOINED_PREFIX}${descriptor.name ?? descriptor.groupChatId}${NOTIFY_JOINED_AS}${runtime.character.name}`,
							"info",
						);
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
		description: CMD_DESC_STATUS,
		handler: async (_args, ctx) => {
			const state = controller.getState();
			if (state.type === "idle") {
				ctx.ui.notify(ERROR_NO_ACTIVE_GROUP_CHAT, "info");
				return;
			}
			if (state.type === "joining") {
				ctx.ui.notify(
					`${NOTIFY_JOINING_PREFIX}${state.attempt.availableCharacters.length}${NOTIFY_JOINING_SUFFIX}`,
					"info",
				);
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
		description: CMD_DESC_NAME,
		handler: async (args, ctx) => {
			if (!isCreator(controller, ctx.ui.notify)) {
				return;
			}

			const name = args.trim();
			if (!name) {
				ctx.ui.notify(NOTIFY_USAGE_NAME, "error");
				return;
			}

			try {
				const normalizedName = await controller.setName(name);
				ctx.ui.notify(`${NOTIFY_NAME_SET_PREFIX}${normalizedName}`, "info");
			} catch (error) {
				notifyError(ctx.ui.notify, error);
			}
		},
	});

	pi.registerCommand("tavern-set-max", {
		description: CMD_DESC_SET_MAX,
		handler: async (args, ctx) => {
			if (!isCreator(controller, ctx.ui.notify)) {
				return;
			}

			const value = args.trim();
			if (!/^\d+$/.test(value)) {
				ctx.ui.notify(NOTIFY_USAGE_SET_MAX, "error");
				return;
			}
			const maxMessages = Number(value);
			if (!Number.isSafeInteger(maxMessages)) {
				ctx.ui.notify(NOTIFY_MAX_MESSAGES_INVALID, "error");
				return;
			}

			try {
				await controller.setMaxMessages(maxMessages);
				ctx.ui.notify(`${NOTIFY_MAX_SET_PREFIX}${maxMessages}`, "info");
			} catch (error) {
				notifyError(ctx.ui.notify, error);
			}
		},
	});

	// 仅测试用的命令（进程级验收套件）。RPC 模式没有输入通道、
	// 也无法调用扩展工具，因此验收套件需要显式入口来发布 User Persona
	// 消息与触发真实 pi reload。仅在 PITAVERN_TEST=1 时注册。
	if (process.env.PITAVERN_TEST === "1") {
		pi.registerCommand("tavern-test-message", {
			description: CMD_DESC_TEST_MESSAGE,
			handler: async (args, ctx) => {
				const state = controller.getState();
				if (state.type !== "creator") {
					ctx.ui.notify(NOTIFY_CREATOR_ONLY_MESSAGE, "error");
					return;
				}
				try {
					await state.runtime.submitUserPersonaMessage(args.trim());
					ctx.ui.notify(NOTIFY_MESSAGE_PUBLISHED, "info");
				} catch (error) {
					notifyError(ctx.ui.notify, error);
				}
			},
		});
		pi.registerCommand("tavern-test-reload", {
			description: CMD_DESC_TEST_RELOAD,
			handler: async (_args, ctx) => {
				await ctx.reload();
			},
		});
		pi.registerCommand("tavern-test-whoami", {
			description: CMD_DESC_TEST_WHOAMI,
			handler: async (_args, ctx) => {
				const state = controller.getState();
				if (state.type !== "character") {
					ctx.ui.notify(NOTIFY_NOT_IN_CHARACTER_STATE, "error");
					return;
				}
				const character = state.runtime.character;
				ctx.ui.notify(
					`[tavern-test-whoami] name=${character.name} character_id=${character.characterId} description=${character.description}`,
					"info",
				);
			},
		});
		pi.registerCommand("tavern-test-history", {
			description: CMD_DESC_TEST_HISTORY,
			handler: async (args, ctx) => {
				const state = controller.getState();
				if (state.type !== "character") {
					ctx.ui.notify(NOTIFY_NOT_IN_CHARACTER_STATE, "error");
					return;
				}
				try {
					// P1-4：工具等价路径观察通道——RPC 模式 LLM 无法调工具，
					// 经 notify 重发拉取结果摘要供 acceptance 断言（QA 要求）。
					const page = await state.runtime.fetchMessageHistoryPage(args.trim() || null);
					if (page === null) {
						ctx.ui.notify("[tavern-test-history] unavailable", "error");
						return;
					}
					ctx.ui.notify(
						`[tavern-test-history] count=${page.messages.length} has_more=${page.hasMore} cursor=${page.cursor ?? ""} total=${page.totalMessages}`,
						"info",
					);
				} catch (error) {
					notifyError(ctx.ui.notify, error);
				}
			},
		});
		pi.registerCommand("tavern-test-busy", {
			description: CMD_DESC_TEST_BUSY,
			handler: async (args, ctx) => {
				const state = controller.getState();
				if (state.type !== "character") {
					ctx.ui.notify(NOTIFY_NOT_IN_CHARACTER_STATE, "error");
					return;
				}
				const ms = Number(args.trim());
				if (!Number.isSafeInteger(ms) || ms < 0) {
					ctx.ui.notify(NOTIFY_USAGE_TEST_BUSY, "error");
					return;
				}
				// 进程验收缝：模拟 Tavern runtime 忙态；隐藏令牌触发的真实 pi run
				// 会经过 context 钩子完成 abort，定时器保留自然 settle 兜底。
				// 真实工具批的安全边界由 integration agent-loop 钉覆盖。
				const runtime = state.runtime;
				let finished = false;
				let timer: ReturnType<typeof setTimeout>;
				const finishBusy = (): void => {
					if (finished) return;
					finished = true;
					clearTimeout(timer);
					runtime.settleRun();
				};
				runtime.isAgentActive = true;
				runtime.updateStreaming(true);
				timer = setTimeout(finishBusy, ms);
				ctx.ui.notify(`[tavern-test-busy] busy=${ms}ms`, "info");
			},
		});
	}

	pi.registerCommand("tavern-leave", {
		description: CMD_DESC_LEAVE,
		handler: async (_args, ctx) => {
			const state = controller.getState();
			if (state.type === "idle") {
				ctx.ui.notify(ERROR_NO_ACTIVE_GROUP_CHAT, "info");
				return;
			}

			try {
				await controller.leave();
				ctx.ui.notify(
					state.type === "creator"
						? ERROR_GROUP_CHAT_CLOSED
						: state.type === "joining"
							? "Join cancelled"
							: ERROR_LEFT_GROUP_CHAT,
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
	const labels = candidates.map((candidate) => `${candidate.name ?? UI_UNNAMED_GROUP_CHAT} (${candidate.groupChatId})`);
	const selected = await select(SELECT_CHOOSE_GROUP_CHAT, labels);
	const index = selected === undefined ? -1 : labels.indexOf(selected);
	return index >= 0 ? (candidates[index] ?? null) : null;
}

function formatSessionLabel(session: GroupChatSessionSummary): string {
	const display = session.name ?? summarizeFirstMessage(session.firstMessage) ?? session.groupChatId;
	const date = session.created.toISOString().slice(0, 10);
	return `${display} (${date})`;
}

function summarizeFirstMessage(firstMessage: string): string | null {
	const text = firstMessage
		.replace(/^User Persona:\s*/, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) {
		return null;
	}
	return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

async function runDeleteGroupChatFlow(
	sessions: GroupChatSessionSummary[],
	select: (title: string, options: string[]) => Promise<string | undefined>,
	confirm: (title: string, message: string) => Promise<boolean>,
	notify: (message: string, type?: "info" | "warning" | "error") => void,
	deleteSession: (path: string) => Promise<DeleteGroupChatSessionResult>,
	deleteBoard?: (groupId: string, boardDir: string) => Promise<DeleteBoardResult>,
	boardDir?: string,
): Promise<void> {
	const labels = sessions.map(formatSessionLabel);
	const choice = await select(SELECT_DELETE_HISTORY_LABEL, labels);
	if (choice === undefined) {
		return;
	}
	const session = sessions[labels.indexOf(choice)];
	if (!session) {
		return;
	}
	const confirmed = await confirm(CONFIRM_DELETE_HISTORY_TITLE, `${CONFIRM_DELETE_HISTORY_BODY_PREFIX}${session.path}`);
	if (!confirmed) {
		return;
	}
	const result = await deleteSession(session.path);
	if (result.ok) {
		notify(`${NOTIFY_DELETED_PREFIX}${result.method}${NOTIFY_DELETED_SUFFIX}`, "info");
		// 白板模型（#114，ADR-0007 契约④）：best-effort 同步清理白板——
		// 失败仅 warning，不阻塞会话删除主流程。
		if (deleteBoard && boardDir) {
			try {
				const boardResult = await deleteBoard(session.groupChatId, boardDir);
				if (!boardResult.ok) {
					notify(`${NOTIFY_DELETED_BOARD_FAIL_PREFIX}${boardResult.error ?? "unknown error"}`, "warning");
				}
			} catch (error) {
				notify(
					`${NOTIFY_DELETED_BOARD_FAIL_PREFIX}${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		}
	} else {
		notify(`${ERROR_DELETE_HISTORY_FAILED_PREFIX}${result.error ?? "unknown error"}`, "error");
	}
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
	const selected = await select(SELECT_CHOOSE_CHARACTER, labels);
	const index = selected === undefined ? -1 : labels.indexOf(selected);
	return index >= 0 ? characters[index] : undefined;
}

function isCreator(
	controller: TavernController,
	notify: (message: string, type?: "info" | "warning" | "error") => void,
): boolean {
	const state = controller.getState();
	if (state.type !== "creator") {
		notify(ERROR_CREATOR_ONLY, "error");
		return false;
	}
	return true;
}

function formatCreatorStatus(runtime: CreatorRuntime): string {
	const { groupChat, round, onlineCharacters } = runtime.state;
	const roundStatus = round
		? `${round.usedMessages}/${round.roundMaxMessages} ${UI_MESSAGES_USED}`
		: UI_ROUND_NOT_STARTED;

	const lines = [
		`${UI_GROUP_CHAT_LABEL_PREFIX}${groupChat.name ?? groupChat.groupChatId}`,
		`${UI_ID_LABEL}${groupChat.groupChatId}`,
		`Listening: ${runtime.activeDescriptor.host}:${runtime.activeDescriptor.port}`,
		`Online Characters: ${onlineCharacters.size}`,
		`Config max messages: ${runtime.configMaxMessages}`,
		`Group max messages: ${groupChat.groupMaxMessages}`,
		`Round: ${roundStatus}`,
	];

	// 白板模型（#114，ADR-0007）：白板快照小节（纯展示，不扩协议面）——
	// store 随 runtime 装配（B3），按在线/全员角色名展示条列表。
	const boards = runtime.boardStore.read(groupChat.groupChatId);
	const boardCharacters = Object.keys(boards);
	if (boardCharacters.length > 0) {
		lines.push("Boards:");
		for (const characterId of boardCharacters) {
			const notes = boards[characterId] ?? [];
			const name = runtime.characters.get(characterId)?.name ?? characterId;
			lines.push(
				notes.length === 0 ? `  ${name}: (empty)` : `  ${name}: ${notes.map((n) => `「${n.content}」`).join("、")}`,
			);
		}
	}
	return lines.join("\n");
}

function formatCharacterStatus(
	runtime: CharacterRuntime,
	snapshot: Awaited<ReturnType<CharacterRuntime["getGroupChatState"]>>,
): string {
	const self = snapshot.online_characters.find((character) => character.is_self);
	return [
		`${UI_GROUP_CHAT_LABEL_PREFIX}${snapshot.group_chat.name ?? snapshot.group_chat.group_chat_id}`,
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
