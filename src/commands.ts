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

export interface RegisterCommandsOptions {
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

	pi.registerCommand("tavern-resume", {
		description: "Resume a PiTavern group chat from its history",
		handler: async (_args, ctx) => {
			try {
				if (!ctx.hasUI) {
					throw new Error("/tavern-resume requires an interactive UI");
				}
				const config = await loadConfig({ agentDir, cwd: ctx.cwd });
				// 组合根契约：index.ts 装配注入行为默认实现（ADR-0005 层方向）。
				if (!listGroupChatSessions) {
					throw new Error("listGroupChatSessions 未注入（组合根契约违反）");
				}
				const sessions = await listGroupChatSessions(agentDir, ctx.cwd);
				const resumable = sessions.filter((session) => !session.active);
				if (resumable.length === 0) {
					ctx.ui.notify("No resumable group chat found for this project", "info");
					return;
				}
				const deleteLabel = "Delete a group chat history…";
				const labels = [...resumable.map(formatSessionLabel), deleteLabel];
				const choice = await ctx.ui.select("Resume group chat:", labels);
				if (choice === undefined) {
					return;
				}
				if (choice === deleteLabel) {
					// 组合根契约：index.ts 装配注入行为默认实现（ADR-0005 层方向）——
					// 契约违反时显式报错（fail fast），替代非空断言（#89 check 清零）。
					if (!deleteGroupChatSession) {
						throw new Error("deleteGroupChatSession 未注入（组合根契约违反）");
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
					characters: config.characters,
				});
				ctx.ui.notify(
					`Resumed group chat ${runtime.state.groupChat.groupChatId} at ${runtime.activeDescriptor.host}:${runtime.activeDescriptor.port}`,
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
				if (!discoverGroupChats) {
					throw new Error("discoverGroupChats 未注入（组合根契约违反）");
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

	// 仅测试用的命令（进程级验收套件）。RPC 模式没有输入通道、
	// 也无法调用扩展工具，因此验收套件需要显式入口来发布 User Persona
	// 消息与触发真实 pi reload。仅在 PITAVERN_TEST=1 时注册。
	if (process.env.PITAVERN_TEST === "1") {
		pi.registerCommand("tavern-test-message", {
			description: "[test] Publish a User Persona message as the creator",
			handler: async (args, ctx) => {
				const state = controller.getState();
				if (state.type !== "creator") {
					ctx.ui.notify("Only the group chat creator can send User Persona messages", "error");
					return;
				}
				try {
					await state.runtime.submitUserPersonaMessage(args.trim());
					ctx.ui.notify("User Persona message published", "info");
				} catch (error) {
					notifyError(ctx.ui.notify, error);
				}
			},
		});
		pi.registerCommand("tavern-test-reload", {
			description: "[test] Trigger a real pi reload to exercise the handoff",
			handler: async (_args, ctx) => {
				await ctx.reload();
			},
		});
		pi.registerCommand("tavern-test-whoami", {
			description: "[test] Report the registered character identity (ISSUE-007 observation channel)",
			handler: async (_args, ctx) => {
				const state = controller.getState();
				if (state.type !== "character") {
					ctx.ui.notify("Not in character state", "error");
					return;
				}
				const character = state.runtime.character;
				ctx.ui.notify(
					`[tavern-test-whoami] name=${character.name} character_id=${character.characterId} description=${character.description}`,
					"info",
				);
			},
		});
	}

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
	const choice = await select("Delete group chat history:", labels);
	if (choice === undefined) {
		return;
	}
	const session = sessions[labels.indexOf(choice)];
	if (!session) {
		return;
	}
	const confirmed = await confirm("Delete group chat history?", `This cannot be undone: ${session.path}`);
	if (!confirmed) {
		return;
	}
	const result = await deleteSession(session.path);
	if (result.ok) {
		notify(`Deleted group chat history (${result.method})`, "info");
		// 白板模型（#114，ADR-0007 契约④）：best-effort 同步清理白板——
		// 失败仅 warning，不阻塞会话删除主流程。
		if (deleteBoard && boardDir) {
			try {
				const boardResult = await deleteBoard(session.groupChatId, boardDir);
				if (!boardResult.ok) {
					notify(
						`Deleted group chat history, but failed to delete its board: ${boardResult.error ?? "unknown error"}`,
						"warning",
					);
				}
			} catch (error) {
				notify(
					`Deleted group chat history, but failed to delete its board: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		}
	} else {
		notify(`Failed to delete group chat history: ${result.error ?? "unknown error"}`, "error");
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

	const lines = [
		`Group chat: ${groupChat.name ?? groupChat.groupChatId}`,
		`ID: ${groupChat.groupChatId}`,
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
