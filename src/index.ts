import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir, type InputEventResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { setTestNotify } from "./character/group-chat-input.js";
import { registerCommands } from "./commands.js";
import { TavernController } from "./controller/tavern-controller.js";
import type { CreatorRuntime, PublicMessageState } from "./creator/creator-runtime.js";
import { getGroupChatSessionDirectory } from "./discovery/active-descriptor.js";
import { type AutoJoinContext, autoJoinCharacter } from "./headless.js";
import { JOIN_HISTORY_LIMIT } from "./shared/constants.js";
import { registerRenderers } from "./ui/renderers.js";
import {
	computeResumeProjection,
	readResumeProjectionAnchor,
	writeResumeProjectionAnchor,
} from "./ui/resume-projection.js";
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

export default function piTavern(pi: ExtensionAPI, controller?: TavernController): void {
	const ctrl = controller ?? new TavernController();
	const presenter = new TavernUiPresenter();
	registerCommands(pi, ctrl);
	registerRenderers(pi);

	// ISSUE-014: headless RPC character mode — auto-join on startup.
	// RPC mode fires no session_start/resources_discover events, so the join
	// is scheduled from extension load (the session is already bound when the
	// extension runs; the delay only lets the runner finish session bootstrap).
	// Reloads are not part of headless operation (no TUI commands); identity
	// and connection are held for the process lifetime instead.
	if (process.env.PITAVERN_AUTO_JOIN === "1") {
		const ctx: AutoJoinContext = {
			cwd: process.cwd(),
			sessionManager: { getSessionId: () => randomUUID() },
			ui: {
				notify: (message, type = "info") => {
					// stderr keeps the RPC JSONL protocol stream clean.
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

	// Keep tavern_speak active-tool state in sync with controller state
	// Wire up creator-display entry appending when controller enters creator state
	ctrl.onStateChange = () => {
		syncActiveTools(pi, ctrl);
		wireCreatorDisplay(pi, ctrl);
		wirePresenter(ctrl, presenter);
		presenter.refresh(ctrl);
	};

	pi.registerTool({
		name: "tavern_speak",
		label: "Tavern Speak",
		description:
			"Publish a message to the PiTavern group chat. " +
			"Only available when joined as a Character. " +
			"Keep messages concise (under 2000 characters). " +
			"Long analysis should stay in the private session.",
		parameters: Type.Object({ content: Type.String() }, { additionalProperties: false }),
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			const state = ctrl.getState();
			if (state.type !== "character") {
				return {
					content: [{ type: "text", text: "Error: You are not currently joined to a group chat as a Character." }],
					details: undefined,
					isError: true,
				};
			}

			try {
				const result = await state.runtime.speak(params.content);
				if (result.published) {
					return {
						content: [
							{
								type: "text",
								text:
									`Message published (sequence ${result.sequence}). ` +
									`Round: ${result.round?.usedMessages}/${result.round?.roundMaxMessages} messages used.`,
							},
						],
						details: undefined,
					};
				}
				if (result.reason === "stale") {
					// ISSUE-013 B3 (final, per User "怎么简单怎么来"): no in-tool pull,
					// no cache, no truncation — just flag the existing A2 increment
					// mark and return a short notice. The settle hook pulls once
					// through the unified pipeline (identity line, snapshot, echo
					// filter) and the LLM re-decides in the next turn with the
					// full context. B5: budgeted per round — beyond it, only the
					// notice, no auto-recovery.
					if (result.autoRecover) {
						state.runtime.markIncrementPending();
					}
					return {
						content: [
							{
								type: "text",
								text:
									`Message NOT published: you are out of sync with the group chat ` +
									`(you last saw seq ${result.missingFrom !== undefined ? result.missingFrom - 1 : "?"}; ` +
									`messages ${result.missingFrom}..${result.missingTo} arrived before your speak). ` +
									`Your message was not counted against the round quota and no hand was raised.` +
									(result.autoRecover
										? `\nThe new messages will be delivered to you after this turn (auto-recovery ${result.autoRecover ? 1 : 0}/2 this round); re-decide then — revise or drop.`
										: `\nAuto-recovery budget exhausted this round — wait for the group chat input before speaking again.`),
							},
						],
						details: undefined,
					};
				}
				return {
					content: [
						{
							type: "text",
							text:
								`Message not published: round limit reached. ` +
								`Your hand is now raised — the creator will see you have more to say. ` +
								`The full message remains in your private session.`,
						},
					],
					details: undefined,
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to send message: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					details: undefined,
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "tavern_whoami",
		label: "Tavern Whoami",
		description:
			"Report this session's registered Character identity in the PiTavern group chat. " +
			"Only available when joined as a Character. " +
			"Returns the same single source of truth (runtime.character) used for identity lines.",
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async () => {
			const state = ctrl.getState();
			if (state.type !== "character") {
				return {
					content: [{ type: "text", text: "Error: You are not currently joined to a group chat as a Character." }],
					details: undefined,
					isError: true,
				};
			}
			const character = state.runtime.character;
			return {
				content: [
					{
						type: "text",
						text:
							`当前角色：${character.name}\n` +
							`character_id：${character.characterId}\n` +
							`描述：${character.description}`,
					},
				],
				details: { name: character.name, character_id: character.characterId, description: character.description },
			};
		},
	});

	// Inject Character Markdown as system prompt extension when online
	pi.on("before_agent_start", (event) => {
		const state = ctrl.getState();
		if (state.type !== "character") return;

		const character = state.runtime.character;
		return {
			systemPrompt: `${event.systemPrompt}\n\n---\n# Character Persona: ${character.name}\n${character.prompt}`,
		};
	});

	// Report streaming state to the group chat creator
	pi.on("agent_start", () => {
		const state = ctrl.getState();
		if (state.type === "character") {
			// M7 (ISSUE-012/#24): mark the run active so a group_chat_update
			// pull queues instead of interrupting the current turn.
			state.runtime.isAgentActive = true;
			// ISSUE-014/#14-A1/A2: only group-chat-triggered turns light up
			// is_streaming (semantic convergence). User-direct turns (direct
			// chat, non-group follow-ups) stay dark. The flag is set by
			// GroupChatInput.flush right before its delivery.
			state.runtime.updateStreaming(state.runtime.consumeGroupChatTurnTriggered());
		}
	});

	pi.on("agent_end", () => {
		const state = ctrl.getState();
		if (state.type === "character") {
			// ISSUE-014/#14-A3: arm the streaming reset watchdog. If
			// agent_settled never arrives (aborted/errored/wedged run), the
			// timer force-resets is_streaming so the "正在发言" display
			// cannot hang. agent_settled clears the timer on the happy path.
			state.runtime.armStreamingResetWatchdog();
		}
	});

	pi.on("agent_settled", () => {
		const state = ctrl.getState();
		if (state.type === "character") {
			state.runtime.isAgentActive = false;
			state.runtime.clearStreamingResetWatchdog();
			state.runtime.updateStreaming(false);
			// Flush any increment queued while the run was active.
			state.runtime.onAgentSettled?.();
		}
	});

	// Enable tavern_speak only when in character state; disable otherwise
	pi.on("session_start", (event, ctx) => {
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

	// /new and /resume: confirm leaving the group chat first when bound.
	pi.on("session_before_switch", async (_event, ctx) => {
		const result = await ctrl.prepareForSessionOperation(() =>
			ctx.ui.confirm(
				"退出群聊？",
				"PiTavern 当前已加入群聊。继续将先退出群聊，之后即使本次操作失败或取消也不会自动恢复。",
			),
		);
		return { cancel: result.cancel };
	});

	// /fork and /clone: the same confirmation gate as /new and /resume.
	pi.on("session_before_fork", async (_event, ctx) => {
		const result = await ctrl.prepareForSessionOperation(() =>
			ctx.ui.confirm(
				"退出群聊？",
				"PiTavern 当前已加入群聊。继续将先退出群聊，之后即使本次操作失败或取消也不会自动恢复。",
			),
		);
		return { cancel: result.cancel };
	});

	// quit: finish group chat cleanup (bounded by the coordination timeout)
	// before pi continues to exit. reload: detach and publish a handoff.
	pi.on("session_shutdown", async (event, ctx) => {
		await ctrl.handleSessionShutdown(event.reason, ctx.sessionManager.getSessionId());
	});

	pi.on("input", async (event, ctx) => {
		const state = ctrl.getState();
		if (state.type === "creator") {
			// Exclude extension-injected input to prevent re-broadcast loops
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

	// Wire fallback error path: when onPublicMessage itself crashes (e.g., pi unavailable)
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
			// Nothing more we can do
		}
	};

	// #42（ISSUE-042）：resume 后把持久化历史窗口投影到当前会话。幂等
	// （锚定文件防重复），creator-runtime 零改动、零协议变更。
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
		// Best-effort error notification so creator sees projection failure
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
			// Even error notification failed — nothing more we can do
		}
	}
}

/**
 * #42：resume 历史投影。锚定 = 上次成功投影的最大 sequence（持久化在群聊
 * 会话目录的 <groupId>.projection.json），只补锚后缺失段；窗口 = JOIN_HISTORY_LIMIT
 * 对称（与 join 拉取视图一致）。投影完成后同步回写锚点——重复 resume /
 * 中断重入均按 sequence 补段（A3-1/A3-2），新消息增量路径不受影响（A4）。
 */
function projectResumeHistory(pi: ExtensionAPI, runtime: CreatorRuntime): void {
	const groupChatId = runtime.state.groupChat.groupChatId;
	const anchorPath = join(
		getGroupChatSessionDirectory(getAgentDir(), runtime.activeDescriptor.cwd),
		`${groupChatId}.projection.json`,
	);
	const anchor = readResumeProjectionAnchor(anchorPath);
	const messages = computeResumeProjection(runtime.publicMessageList, anchor, JOIN_HISTORY_LIMIT);
	if (messages.length === 0) {
		return;
	}
	for (const message of messages) {
		appendCreatorDisplayEntry(pi, runtime, message);
	}
	const last = messages[messages.length - 1];
	if (last !== undefined) {
		writeResumeProjectionAnchor(anchorPath, last.sequence);
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
