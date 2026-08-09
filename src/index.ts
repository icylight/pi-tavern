import { randomUUID } from "node:crypto";
import { type ExtensionAPI, type InputEventResult, SessionManager } from "@earendil-works/pi-coding-agent";
import { setTestNotify } from "./character/group-chat-input.js";
import { JoinAttempt } from "./character/join-attempt.js";
import { registerCommands } from "./commands.js";
import { DEFAULT_TEMPLATES } from "./config/message-templates.js";
import { TavernController } from "./controller/tavern-controller.js";
import type { CreatorRuntime } from "./creator/creator-runtime.js";
import { createBoardStore } from "./data/board-store.js";
import { discoverGroupChats as discoverActiveGroupChats } from "./data/discovery/discover-group-chats.js";
import {
	defaultGroupChatSessionIoDependencies,
	deleteGroupChatSession as deleteGroupChatSessionFile,
	listGroupChatSessions as listPersistedGroupChatSessions,
} from "./data/group-chat-sessions.js";
import {
	computeResumeProjection,
	computeSessionProjectionAnchor,
	type ProjectionEntryReader,
} from "./data/resume-projection.js";
import { wireAgentLifecycle } from "./extension/agent-lifecycle.js";
import { registerTavernTools } from "./extension/tavern-tools.js";
import { type AutoJoinContext, autoJoinCharacter } from "./headless.js";
import type { PublicMessageState } from "./protocol/public-message-state.js";
import {
	ERROR_TUI_PROJECTION_FAILED_PREFIX,
	ERROR_UNKNOWN,
	UI_CONFIRM_LEAVE_BODY,
	UI_CONFIRM_LEAVE_TITLE,
} from "./shared/messages.js";
import { registerRenderers } from "./ui/renderers.js";
import { TavernUiPresenter } from "./ui/tavern-ui-presenter.js";

interface CreatorDisplayEvent {
	event_id: string;
	sequence: number;
	timestamp: string;
	sender: { type: "user_persona" } | { type: "character"; character_id: string; name: string } | { type: "system" };
	content: string;
	round: { round_max_messages: number; used_messages: number; remaining_messages: number };
}

interface CreatorDisplayEntryData {
	kind: "public_message";
	group_chat_id: string;
	event: CreatorDisplayEvent;
}

/** 白板模型（#114）：creator-display 的 board_update 条目（纯展示，非协议）。 */
interface CreatorBoardEntryData {
	kind: "board_update";
	group_chat_id: string;
	actor: string;
	actor_name: string;
	action: "add" | "update" | "remove" | "clear";
	note?: { id: string; content: string };
}

/** #42：当前 pi 会话的只读引用（session_start 捕获，用于投影锚定扫描）。 */
let sessionManagerRef: ProjectionEntryReader | null = null;

export default function piTavern(pi: ExtensionAPI, controller?: TavernController): void {
	// 闲态触发窗口注入化（Arch 提速项）：默认 1000ms 行为零变化；测试可设
	// PITAVERN_TRIGGER_DEBOUNCE_MS 缩短（idle 感知延迟降 ~750ms）。启动早期一次性读取。
	const triggerDebounceMs = Number(process.env.PITAVERN_TRIGGER_DEBOUNCE_MS ?? "1000");
	const injectTriggerDebounce =
		Number.isFinite(triggerDebounceMs) && triggerDebounceMs >= 0 ? triggerDebounceMs : undefined;
	// #138：增量拉取上下文窗口——拉取起点前移游标前 N 条已读（默认 1，暂不配置）。
	// getter 闭包注入（每轮拉取实时取值，非快照）；显式传入优先，undefined → 窗口 0 行为不变。
	const DEFAULT_FETCH_CONTEXT_WINDOW = 1;
	const getFetchContextWindow = () => DEFAULT_FETCH_CONTEXT_WINDOW;
	const ctrl =
		controller ??
		new TavernController(undefined, (descriptor, sessionId, options) =>
			JoinAttempt.connect(descriptor, sessionId, {
				...options,
				...(options.getFetchContextWindow === undefined ? { getFetchContextWindow } : {}),
			}),
		);
	const presenter = new TavernUiPresenter();
	// 组合根装配（ADR-0005 层方向，Phase 4）：adapter 行为默认实现在此注入——
	// commands/headless 只留注入面与类型/纯函数导入。
	const piSessionManager = {
		list: (cwd: string, sessionDir: string) => SessionManager.list(cwd, sessionDir),
		open: (path: string, sessionDir: string, cwd: string) => SessionManager.open(path, sessionDir, cwd),
	};
	registerCommands(pi, ctrl, {
		...(injectTriggerDebounce !== undefined ? { triggerDebounceMs: injectTriggerDebounce } : {}),
		discoverGroupChats: (options) => discoverActiveGroupChats(options),
		listGroupChatSessions: (agentDir, cwd) =>
			listPersistedGroupChatSessions(agentDir, cwd, {
				...defaultGroupChatSessionIoDependencies,
				sessionManager: piSessionManager,
			}),
		deleteGroupChatSession: (path) => deleteGroupChatSessionFile(path),
		// 白板模型（#114，ADR-0007 契约④）：删除群聊同步清理白板（boards/<groupId>.json）。
		// 组合根装配行为默认实现（ADR-0005 层方向）；每调用新建 store 实例——删除仅发生在
		// 非活跃群聊（resumable 语义），无并发写者；B3 活动实例复用同一 store 时另行显式摘除。
		deleteBoard: (groupId, boardDir) => createBoardStore({ boardDir }).deleteBoard(groupId),
	});
	// #154：TUI 模板集 getter 闭包——从当前 creator runtime 实时取（reload/
	// 新群聊后模板集变化可见），非 creator 态回落内置中文。
	registerRenderers(pi, () => {
		const state = ctrl.getState();
		return state.type === "creator" ? (state.runtime.messageTemplates ?? DEFAULT_TEMPLATES) : DEFAULT_TEMPLATES;
	});
	registerTavernTools(pi, ctrl);
	wireAgentLifecycle(pi, ctrl);

	// ISSUE-014：headless RPC 角色模式——启动时自动 join。RPC 模式不触发
	// session_start/resources_discover 事件，因此 join 从扩展加载时调度（会话
	// 在扩展运行时已绑定；延迟只是让 runner 完成会话引导）。reload 不属于
	// headless 操作（无 TUI 命令）；身份与连接由进程生命周期持有。
	if (process.env.PITAVERN_AUTO_JOIN === "1") {
		const ctx: AutoJoinContext = {
			cwd: process.cwd(),
			sessionManager: { getSessionId: () => randomUUID() },
			ui: {
				notify: (message, type = "info") => {
					// stderr 保持 RPC JSONL 协议流干净。
					process.stderr.write(`[pi-tavern:auto-join:${type}] ${message}\n`);
				},
			},
		};
		// headless 进程不触发 session_start（观察通道在 headless 是死通道，QA B6
		// 实证）——补接线：注入代码有 PITAVERN_TEST=1 门闸，生产零影响。
		setTestNotify(ctx.ui.notify);
		const run = () => {
			void autoJoinCharacter(pi, ctrl, ctx, {
				// 组合根装配（ADR-0005 层方向，Phase 4）。
				...(injectTriggerDebounce !== undefined ? { triggerDebounceMs: injectTriggerDebounce } : {}),
				discoverGroupChats: (options) => discoverActiveGroupChats(options),
				...(process.env.PITAVERN_CHARACTER !== undefined && process.env.PITAVERN_CHARACTER !== ""
					? { character: process.env.PITAVERN_CHARACTER }
					: {}),
				...(process.env.PITAVERN_GROUP_CHAT !== undefined && process.env.PITAVERN_GROUP_CHAT !== ""
					? { groupChat: process.env.PITAVERN_GROUP_CHAT }
					: {}),
			}).catch((error) => {
				process.stderr.write(`[pi-tavern:auto-join:error] ${error instanceof Error ? error.message : String(error)}\n`);
			});
		};
		// 延迟注入化（Phase 4 提速 ①）：默认 3s 等 boot 完成后再 join；测试可设
		// PITAVERN_AUTO_JOIN_DELAY_MS 缩短（行为零变化——默认路径不变）。
		const autoJoinDelayMs = Number(process.env.PITAVERN_AUTO_JOIN_DELAY_MS ?? "3000");
		setTimeout(run, Number.isFinite(autoJoinDelayMs) && autoJoinDelayMs >= 0 ? autoJoinDelayMs : 3_000);
	}

	// 保持 tavern_speak 工具可用状态与 controller 状态同步
	// controller 进入 creator 状态时接线 creator-display 条目追加
	ctrl.onStateChange = () => {
		syncActiveTools(pi, ctrl);
		wireCreatorDisplay(pi, ctrl);
		wirePresenter(ctrl, presenter);
		presenter.refresh(ctrl);
	};

	// 仅 character 状态启用 tavern_speak，其余禁用
	pi.on("session_start", (event, ctx) => {
		// #42：捕获会话引用供 resume 投影锚定扫描（会话复用场景跳过已显示段）。
		sessionManagerRef = ctx.sessionManager;
		presenter.bind(ctx.ui);
		setTestNotify(ctx.ui.notify);
		if (event.reason === "reload") {
			void ctrl
				.takeReloadHandoff(ctx.sessionManager.getSessionId(), pi, ctx.ui.notify)
				.then(() => presenter.refresh(ctrl));
		}
		syncActiveTools(pi, ctrl);
		presenter.refresh(ctrl);
	});

	// /new 与 /resume：已绑定群聊时先确认退出。
	pi.on("session_before_switch", async (_event, ctx) => {
		const result = await ctrl.prepareForSessionOperation(() =>
			ctx.ui.confirm(UI_CONFIRM_LEAVE_TITLE, UI_CONFIRM_LEAVE_BODY),
		);
		return { cancel: result.cancel };
	});

	// /fork 与 /clone：与 /new、/resume 相同的确认闸门。
	pi.on("session_before_fork", async (_event, ctx) => {
		const result = await ctrl.prepareForSessionOperation(() =>
			ctx.ui.confirm(UI_CONFIRM_LEAVE_TITLE, UI_CONFIRM_LEAVE_BODY),
		);
		return { cancel: result.cancel };
	});

	// quit：先完成群聊清理（受协调超时约束）再让 pi 退出；reload：分离并发布 handoff。
	pi.on("session_shutdown", async (event, ctx) => {
		await ctrl.handleSessionShutdown(event.reason, ctx.sessionManager.getSessionId());
	});

	pi.on("input", async (event, ctx) => {
		const state = ctrl.getState();
		if (state.type === "creator") {
			// 排除扩展注入的输入，防止重新广播循环
			if (event.source === "extension") {
				return { action: "continue" } as InputEventResult;
			}
			try {
				await state.runtime.submitUserPersonaMessage(event.text);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			return { action: "handled" } as InputEventResult;
		}
		return { action: "continue" } as InputEventResult;
	});
}

function syncActiveTools(pi: ExtensionAPI, ctrl: TavernController): void {
	const activeTools = pi.getActiveTools();
	const hasSpeak = activeTools.includes("tavern_speak");
	const isCharacter = ctrl.getState().type === "character";

	if (isCharacter && !hasSpeak) {
		pi.setActiveTools([...activeTools, "tavern_speak"]);
	} else if (!isCharacter && hasSpeak) {
		pi.setActiveTools(activeTools.filter((t) => t !== "tavern_speak"));
	}
}

function wireCreatorDisplay(pi: ExtensionAPI, ctrl: TavernController): void {
	const state = ctrl.getState();
	if (state.type !== "creator") return;

	state.runtime.onPublicMessage = (msg) => {
		appendCreatorDisplayEntry(pi, state.runtime, msg);
	};

	// 白板模型（#114）：board_update 实时提示（纯展示，不扩协议面）——
	// 组合根接线，runtime 无 ui 句柄；显示通道与 public_message 同源。
	state.runtime.onBoardUpdated = (update) => {
		appendCreatorBoardEntry(pi, state.runtime, update);
	};

	// 接线降级错误路径：onPublicMessage 自身崩溃时（如 pi 不可用）
	state.runtime.onPublicMessageError = (error, sequence, timestamp) => {
		try {
			pi.appendEntry("pi-tavern.creator-display", {
				kind: "public_message" as const,
				group_chat_id: state.runtime.state.groupChat.groupChatId,
				event: {
					event_id: "",
					sequence,
					timestamp,
					sender: { type: "system" as const },
					content: error,
					round: { round_max_messages: 0, used_messages: 0, remaining_messages: 0 },
				},
			});
		} catch {
			// 无能为力
		}
	};

	// #42（ISSUE-042）：resume 后把持久化历史窗口投影到当前会话。
	// 幂等（会话扫描锚定防重复，方案 B），creator-runtime 零改动、零协议变更。
	projectResumeHistory(pi, state.runtime);
}

/**
 * #42：增量/回放共用的 creator-display 条目落盘（格式唯一来源，保证
 * 回放与增量投影逐字一致——A2）。失败时降级为错误通知条目（与旧行为一致）。
 */
/** 白板模型（#114）：creator 实时提示——board_update 追加到 creator-display
 * 面板（尽力而为；与 appendCreatorDisplayEntry 同容错）。
 */
function appendCreatorBoardEntry(
	pi: ExtensionAPI,
	runtime: CreatorRuntime,
	update: { actor: string; action: "add" | "update" | "remove" | "clear"; note?: { id: string; content: string } },
): void {
	const data: CreatorBoardEntryData = {
		kind: "board_update",
		group_chat_id: runtime.state.groupChat.groupChatId,
		actor: update.actor,
		actor_name: runtime.characters.get(update.actor)?.name ?? update.actor,
		action: update.action,
		...(update.note ? { note: update.note } : {}),
	};
	try {
		pi.appendEntry("pi-tavern.creator-display", data);
	} catch (error) {
		// 尽力而为：board 提示失败不阻塞（与 public_message 投影同容错）。
		try {
			pi.appendEntry("pi-tavern.creator-display", {
				kind: "board_update" as const,
				group_chat_id: data.group_chat_id,
				actor: data.actor,
				actor_name: data.actor_name,
				action: data.action,
				error: error instanceof Error ? error.message : String(error),
			});
		} catch {
			// 双失败静默（display 通道不可用）。
		}
	}
}

function appendCreatorDisplayEntry(pi: ExtensionAPI, runtime: CreatorRuntime, msg: PublicMessageState): void {
	const data: CreatorDisplayEntryData = {
		kind: "public_message",
		group_chat_id: runtime.state.groupChat.groupChatId,
		event: {
			event_id: msg.event_id,
			sequence: msg.sequence,
			timestamp: msg.timestamp,
			sender: msg.sender,
			content: msg.content,
			round: msg.round,
		},
	};
	try {
		pi.appendEntry("pi-tavern.creator-display", data);
	} catch (error) {
		// 尽力而为的错误通知，让 creator 看到投影失败
		try {
			pi.appendEntry("pi-tavern.creator-display", {
				kind: "public_message" as const,
				group_chat_id: data.group_chat_id,
				event: {
					event_id: msg.event_id,
					sequence: msg.sequence,
					timestamp: msg.timestamp,
					sender: msg.sender,
					content: `${ERROR_TUI_PROJECTION_FAILED_PREFIX}${error instanceof Error ? error.message : ERROR_UNKNOWN}`,
					round: msg.round,
				},
			});
		} catch {
			// 连错误通知都失败——无能为力
		}
	}
}

/**
 * #42：resume 历史投影（PM 裁决方案 B：纯扫描锚定，无标记文件）。锚定 =
 * 当前 pi 会话内本群聊 creator-display 条目最大 sequence——fresh 会话
 * （无条目）→ 全量投影（每次 fresh resume 都有历史）；continued 会话
 * → 跳过已显示段防重复；同会话重复 resume → 幂等空。窗口 = 当前全量
 * 列表长度（#155：移除 JOIN_HISTORY_LIMIT=10 截断，投影完整历史）。
 * 中断重入按已投影最大 sequence 补尾段。新消息增量路径不受影响（A4）。
 */
function projectResumeHistory(pi: ExtensionAPI, runtime: CreatorRuntime): void {
	const anchor = computeSessionProjectionAnchor(sessionManagerRef, runtime.state.groupChat.groupChatId);
	// 窗口 = 当前全量列表长度（空列表时 windowSize=0 → 自然返回 []）。
	const messages = computeResumeProjection(runtime.publicMessageList, anchor, runtime.publicMessageList.length);
	for (const message of messages) {
		appendCreatorDisplayEntry(pi, runtime, message);
	}
}

function wirePresenter(ctrl: TavernController, presenter: TavernUiPresenter): void {
	const state = ctrl.getState();
	if (state.type === "creator") {
		state.runtime.onMembersChanged = () => presenter.refresh(ctrl);
	}
	if (state.type === "character") {
		state.runtime.onStateSnapshot = () => presenter.refresh(ctrl);
	}
}
