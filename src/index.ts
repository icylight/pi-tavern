import { randomUUID } from "node:crypto";
import type { ExtensionAPI, InputEventResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { setTestNotify } from "./character/group-chat-input.js";
import { registerCommands } from "./commands.js";
import { TavernController } from "./controller/tavern-controller.js";
import { type AutoJoinContext, autoJoinCharacter } from "./headless.js";
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
			// Keep the legacy streaming signal; its semantic correction (only
			// group-chat-triggered turns) is tracked separately (ISSUE-002/#14).
			state.runtime.updateStreaming(true);
		}
	});

	pi.on("agent_settled", () => {
		const state = ctrl.getState();
		if (state.type === "character") {
			state.runtime.isAgentActive = false;
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
		const data: CreatorDisplayEntryData = {
			kind: "public_message",
			group_chat_id: state.runtime.state.groupChat.groupChatId,
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
