import { randomUUID } from "node:crypto";
import type { ExtensionAPI, InputEventResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { setTestNotify } from "./character/group-chat-input.js";
import { registerCommands } from "./commands.js";
import { TavernController } from "./controller/tavern-controller.js";
import type { CreatorRuntime } from "./creator/creator-runtime.js";
import {
	computeResumeProjection,
	computeSessionProjectionAnchor,
	type ProjectionEntryReader,
} from "./data/resume-projection.js";
import { wireAgentLifecycle } from "./extension/agent-lifecycle.js";
import { registerTavernTools } from "./extension/tavern-tools.js";
import { type AutoJoinContext, autoJoinCharacter } from "./headless.js";
import type { PublicMessageState } from "./protocol/public-message-state.js";
import { JOIN_HISTORY_LIMIT } from "./shared/constants.js";
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

/** #42：当前 pi 会话的只读引用（session_start 捕获，用于投影锚定扫描）。 */
let sessionManagerRef: ProjectionEntryReader | null = null;

export default function piTavern(pi: ExtensionAPI, controller?: TavernController): void {
	const ctrl = controller ?? new TavernController();
	const presenter = new TavernUiPresenter();
	registerCommands(pi, ctrl);
	registerRenderers(pi);
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
		const run = () => {
			void autoJoinCharacter(pi, ctrl, ctx, {
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
		setTimeout(run, 3_000);
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
			ctx.ui.confirm(
				"退出群聊？",
				"PiTavern 当前已加入群聊。继续将先退出群聊，之后即使本次操作失败或取消也不会自动恢复。",
			),
		);
		return { cancel: result.cancel };
	});

	// /fork 与 /clone：与 /new、/resume 相同的确认闸门。
	pi.on("session_before_fork", async (_event, ctx) => {
		const result = await ctrl.prepareForSessionOperation(() =>
			ctx.ui.confirm(
				"退出群聊？",
				"PiTavern 当前已加入群聊。继续将先退出群聊，之后即使本次操作失败或取消也不会自动恢复。",
			),
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
					content: `TUI projection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
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
 * （无条目）→ 全窗口投影（每次 fresh resume 都有历史）；continued 会话
 * → 跳过已显示段防重复；同会话重复 resume → 幂等空。窗口 =
 * JOIN_HISTORY_LIMIT 对称（与 join 拉取视图一致）。中断重入按已投影
 * 最大 sequence 补尾段。新消息增量路径不受影响（A4）。
 */
function projectResumeHistory(pi: ExtensionAPI, runtime: CreatorRuntime): void {
	const anchor = computeSessionProjectionAnchor(sessionManagerRef, runtime.state.groupChat.groupChatId);
	const messages = computeResumeProjection(runtime.publicMessageList, anchor, JOIN_HISTORY_LIMIT);
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
