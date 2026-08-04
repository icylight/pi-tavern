import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { TavernController } from "../controller/tavern-controller.js";
import type { BoardWriteDataWire } from "../protocol/messages.js";

/** 注册 PiTavern 暴露给 pi Agent 的工具（tavern_speak / tavern_whoami）。 */
export function registerTavernTools(pi: ExtensionAPI, ctrl: TavernController): void {
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
					// ISSUE-013 B3（最终版，按 User「怎么简单怎么来」）：不在工具内拉取、
					// 无缓存、无截断——只标记既有 A2 增量待投递并返回简短提示。settle
					// 钩子经统一管道补拉一次（身份行、快照、echo 过滤），LLM 在下一轮
					// 以完整上下文重新决策。B5：每轮配额预算——超限后只有提示，无自动恢复。
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

	/** 白板 reason_code 五码 → 角色可读说明（工具返回用）。 */
	const boardCodeExplanations: Record<string, string> = {
		max_notes_exceeded: "已达白板条数上限（默认 5 条）——先撕一条再贴",
		note_length_exceeded: "超过单条长度上限（默认 140 码点）",
		note_not_found: "条不存在（已被撕、非本人条或 id 无效）",
		board_empty: "白板为空",
		note_unchanged: "内容无变化（幂等）",
	};

	/** 白板响应四态 → 角色可读文本。 */
	function formatBoardWriteData(data: BoardWriteDataWire): string {
		if (data.changed && data.note) {
			return `已记录（id=${data.note.id}）：${data.note.content}`;
		}
		if (data.changed) {
			return "已生效（白板已更新）";
		}
		return `未变化（${data.code}）：${boardCodeExplanations[data.code] ?? ""}`;
	}

	pi.registerTool({
		name: "tavern_board",
		label: "Tavern Board",
		description:
			"Access the PiTavern whiteboard (per-character notes, visible to the whole group). " +
			"Only available when joined as a Character. " +
			"Actions: set (post a new note, or edit an existing one by id), remove (tear off a note by id), " +
			"clear (empty your own board), query (read all boards). " +
			"Each character has their own board (max 5 notes, 140 code points each by default); " +
			"you can only modify your own board. Keep note content concise (under 140 characters).",
		parameters: Type.Object(
			{
				action: Type.Union([Type.Literal("set"), Type.Literal("remove"), Type.Literal("clear"), Type.Literal("query")]),
				note: Type.Optional(
					Type.Object(
						{
							id: Type.Optional(Type.String()),
							content: Type.Optional(Type.String()),
						},
						{ additionalProperties: false },
					),
				),
			},
			{ additionalProperties: false },
		),
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
				if (params.action === "query") {
					const boards = await state.runtime.boardQuery();
					const lines = Object.entries(boards).map(([characterId, notes]) => {
						if (notes.length === 0) {
							return `${characterId} 的白板：（空）`;
						}
						return `${characterId} 的白板：\n${notes.map((n) => `- ${n.content}（id=${n.id}）`).join("\n")}`;
					});
					return {
						content: [{ type: "text", text: lines.length > 0 ? lines.join("\n\n") : "（全员白板均为空）" }],
						details: { boards },
					};
				}
				const result = await state.runtime.boardWrite(params.action, params.note);
				return {
					content: [{ type: "text", text: formatBoardWriteData(result) }],
					details: { result },
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to access the board: ${error instanceof Error ? error.message : String(error)}`,
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
}
