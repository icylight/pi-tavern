import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	DEFAULT_TEMPLATES,
	MESSAGE_TEMPLATE_KEYS,
	type MessageTemplateKey,
	renderTemplate,
} from "../config/message-templates.js";
import type { TavernController } from "../controller/tavern-controller.js";
import type { BoardWriteDataWire } from "../protocol/messages.js";
import {
	ERROR_ACCESS_BOARD_FAILED_PREFIX,
	ERROR_REMOVE_MISSING_NOTE_ID,
	ERROR_SEND_FAILED_PREFIX,
	METHOD_PUBLIC_MESSAGE,
	TOOL_BOARD_ACTION_INVALID,
	TOOL_BOARD_ALL_EMPTY,
	TOOL_BOARD_ARGS_INVALID,
	TOOL_BOARD_CHANGED,
	TOOL_BOARD_CONTENT_NOT_STRING,
	TOOL_BOARD_DESCRIPTION,
	TOOL_BOARD_ID_NOT_STRING,
	TOOL_BOARD_LABEL,
	TOOL_BOARD_REASON_BOARD_EMPTY,
	TOOL_BOARD_REASON_LENGTH_EXCEEDED,
	TOOL_BOARD_REASON_MAX_NOTES,
	TOOL_BOARD_REASON_NOTE_NOT_FOUND,
	TOOL_BOARD_REASON_NOTE_UNCHANGED,
	TOOL_BOARD_RECORDED_PREFIX,
	TOOL_BOARD_REMOVE_NEEDS_ID,
	TOOL_BOARD_REMOVE_NO_CONTENT,
	TOOL_BOARD_UNCHANGED_PREFIX,
	TOOL_HISTORY_CURSOR_PREFIX,
	TOOL_HISTORY_DESCRIPTION,
	TOOL_HISTORY_EMPTY,
	TOOL_HISTORY_HAS_MORE_PREFIX,
	TOOL_HISTORY_LABEL,
	TOOL_HISTORY_TOTAL_PREFIX,
	TOOL_HISTORY_UNAVAILABLE,
	TOOL_NOT_JOINED_AS_CHARACTER,
	TOOL_SPEAK_DESCRIPTION,
	TOOL_SPEAK_LABEL,
	TOOL_TEMPLATE_DEFAULTS_DESCRIPTION,
	TOOL_TEMPLATE_DEFAULTS_LABEL,
	TOOL_TEMPLATE_DEFAULTS_STATE_REJECTED,
	TOOL_WHOAMI_DESC_PREFIX,
	TOOL_WHOAMI_DESCRIPTION,
	TOOL_WHOAMI_ID_PREFIX,
	TOOL_WHOAMI_LABEL,
	TOOL_WHOAMI_ROLE_PREFIX,
} from "../shared/messages.js";

/** 注册 PiTavern 暴露给 pi Agent 的工具（tavern_speak / tavern_whoami）。 */
export function registerTavernTools(pi: ExtensionAPI, ctrl: TavernController): void {
	pi.registerTool({
		name: "tavern_speak",
		label: TOOL_SPEAK_LABEL,
		description: TOOL_SPEAK_DESCRIPTION,
		parameters: Type.Object({ content: Type.String() }, { additionalProperties: false }),
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			const state = ctrl.getState();
			if (state.type !== "character") {
				return {
					content: [{ type: "text", text: TOOL_NOT_JOINED_AS_CHARACTER }],
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
				if (result.reason === "unread_first") {
					// #128：未读先读（两段式，B3 零动摇）——本地判定、不耗配额、不举手。
					// 首拒已安排 settle 拉全（markIncrementPending）；重复调用只短告知
					//（风暴场景防刷）。告知无预览（苍蓝星选 A）：只含未读条数。
					const countText =
						result.unreadCount !== undefined
							? result.unreadExact
								? `有未读 ${result.unreadCount} 条`
								: `有至少 ${result.unreadCount} 条未读`
							: "有未读消息";
					const body = result.first
						? `${countText}，请先阅读再决定是否发言。未读已安排拉取，注入后将自动重新决策。`
						: `未读拉取中，请等待新信息到达后再决定。`;
					return {
						content: [
							{
								type: "text",
								text:
									`Message NOT published: ${body} ` +
									`Your message was not counted against the round quota and no hand was raised.`,
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
							text: `${ERROR_SEND_FAILED_PREFIX}${error instanceof Error ? error.message : String(error)}`,
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
		max_notes_exceeded: TOOL_BOARD_REASON_MAX_NOTES,
		note_length_exceeded: TOOL_BOARD_REASON_LENGTH_EXCEEDED,
		note_not_found: TOOL_BOARD_REASON_NOTE_NOT_FOUND,
		board_empty: TOOL_BOARD_REASON_BOARD_EMPTY,
		note_unchanged: TOOL_BOARD_REASON_NOTE_UNCHANGED,
	};

	/** 白板响应四态 → 角色可读文本。 */
	function formatBoardWriteData(data: BoardWriteDataWire): string {
		if (data.changed && data.note) {
			return `${TOOL_BOARD_RECORDED_PREFIX}id=${data.note.id}）：${data.note.content}`;
		}
		if (data.changed) {
			return TOOL_BOARD_CHANGED;
		}
		return `${TOOL_BOARD_UNCHANGED_PREFIX}${data.code}）：${boardCodeExplanations[data.code] ?? ""}`;
	}

	/**
	 * F11（PR #116 review）：工具层形状前置校验——判别 union 收窄后的运行时兜底。
	 * 返回错误提示文本（null = 合法）。非法组合在工具层即拒（isError、可读可恢复），
	 * 不发 wire 请求——模型误调不会触发服务端 fail-close 断连（防线分层：
	 * 工具层拒非法参数 → codec 拒畸形消息 → 断连仅兜底，Arch 权衡结论）。
	 */
	function validateBoardToolParams(params: unknown): string | null {
		if (typeof params !== "object" || params === null) {
			return TOOL_BOARD_ARGS_INVALID;
		}
		const action = (params as { action?: unknown }).action;
		if (action !== "set" && action !== "remove" && action !== "clear" && action !== "query") {
			return TOOL_BOARD_ACTION_INVALID;
		}
		const note = (params as { note?: unknown }).note;
		if (action === "remove") {
			// remove 必带 id（与 F1 服务端变体同构）；content 禁止。
			if (typeof note !== "object" || note === null || typeof (note as { id?: unknown }).id !== "string") {
				return TOOL_BOARD_REMOVE_NEEDS_ID;
			}
			if ((note as { content?: unknown }).content !== undefined) {
				return TOOL_BOARD_REMOVE_NO_CONTENT;
			}
		}
		if (action === "clear" || action === "query") {
			if (note !== undefined) {
				return `Error: ${action} 不得携带 note`;
			}
		}
		if (action === "set" && note !== undefined) {
			// set 的 note 字段类型兜底（id/content 若提供必须是字符串）。
			const n = note as { id?: unknown; content?: unknown };
			if (n.id !== undefined && typeof n.id !== "string") {
				return TOOL_BOARD_ID_NOT_STRING;
			}
			if (n.content !== undefined && typeof n.content !== "string") {
				return TOOL_BOARD_CONTENT_NOT_STRING;
			}
		}
		return null;
	}

	pi.registerTool({
		name: "tavern_board",
		label: TOOL_BOARD_LABEL,
		description: TOOL_BOARD_DESCRIPTION,
		// Function tool schemas must have a top-level JSON Schema type of "object".
		// Cross-field action/note invariants remain enforced by validateBoardToolParams
		// before any wire request is sent.
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
					content: [{ type: "text", text: TOOL_NOT_JOINED_AS_CHARACTER }],
					details: undefined,
					isError: true,
				};
			}
			try {
				// F11：形状前置校验（判别 union 类型收窄后此处兜底运行时畸形输入——
				// 工具层即拒、不发 wire 请求，杜绝模型误调触发服务端 fail-close 断连）。
				const invalid = validateBoardToolParams(params);
				if (invalid !== null) {
					return {
						content: [{ type: "text", text: invalid }],
						details: undefined,
						isError: true,
					};
				}
				if (params.action === "query") {
					const boards = await state.runtime.boardQuery();
					const lines = Object.entries(boards).map(([characterId, notes]) => {
						if (notes.length === 0) {
							return `${characterId} 的白板：（空）`;
						}
						return `${characterId} 的白板：\n${notes.map((n) => `- ${n.content}（id=${n.id}）`).join("\n")}`;
					});
					return {
						content: [{ type: "text", text: lines.length > 0 ? lines.join("\n\n") : TOOL_BOARD_ALL_EMPTY }],
						details: { boards },
					};
				}
				let result: BoardWriteDataWire;
				if (params.action === "remove") {
					const id = params.note?.id;
					if (typeof id !== "string") {
						throw new Error(ERROR_REMOVE_MISSING_NOTE_ID);
					}
					result = await state.runtime.boardWrite("remove", { id });
				} else if (params.action === "clear") {
					result = await state.runtime.boardWrite("clear");
				} else if (params.note !== undefined) {
					result = await state.runtime.boardWrite("set", params.note);
				} else {
					result = await state.runtime.boardWrite("set");
				}
				return {
					content: [{ type: "text", text: formatBoardWriteData(result) }],
					details: { result },
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `${ERROR_ACCESS_BOARD_FAILED_PREFIX}${error instanceof Error ? error.message : String(error)}`,
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
		label: TOOL_WHOAMI_LABEL,
		description: TOOL_WHOAMI_DESCRIPTION,
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async () => {
			const state = ctrl.getState();
			if (state.type !== "character") {
				return {
					content: [{ type: "text", text: TOOL_NOT_JOINED_AS_CHARACTER }],
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
							`${TOOL_WHOAMI_ROLE_PREFIX}${character.name}\n` +
							`${TOOL_WHOAMI_ID_PREFIX}${character.characterId}\n` +
							`${TOOL_WHOAMI_DESC_PREFIX}${character.description}`,
					},
				],
				details: { name: character.name, character_id: character.characterId, description: character.description },
			};
		},
	});

	pi.registerTool({
		name: "tavern_history",
		label: TOOL_HISTORY_LABEL,
		description: TOOL_HISTORY_DESCRIPTION,
		parameters: Type.Object({ cursor: Type.Optional(Type.String()) }, { additionalProperties: false }),
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			const state = ctrl.getState();
			if (state.type !== "character") {
				return {
					content: [{ type: "text", text: TOOL_NOT_JOINED_AS_CHARACTER }],
					details: undefined,
					isError: true,
				};
			}
			try {
				const page = await state.runtime.fetchMessageHistoryPage((params as { cursor?: string }).cursor ?? null);
				if (page === null) {
					return {
						content: [{ type: "text", text: TOOL_HISTORY_UNAVAILABLE }],
						details: undefined,
						isError: true,
					};
				}
				// P1-4：AI 自主拉取——消息列表 + 游标/分页元数据（has_more 决定续页）。
				// #154：统一文案模板渲染（默认模板 `{sender}:\n{content}`，双行化按
				// Arch 裁决 2026-08-09 留痕 T3；自定义模板逐字生效）。
				const templates = state.runtime.messageTemplates ?? DEFAULT_TEMPLATES;
				const lines = page.messages.map((m) => {
					if (!("method" in m) || m.method !== METHOD_PUBLIC_MESSAGE) {
						return "";
					}
					const sender = m.params.sender.type === "user_persona" ? "User Persona" : m.params.sender.name;
					return renderTemplate(templates.public_message, { sender, content: m.params.content });
				});
				const text =
					(page.messages.length === 0 ? TOOL_HISTORY_EMPTY : lines.join("\n")) +
					`\n${TOOL_HISTORY_CURSOR_PREFIX}${page.cursor ?? ""} ${TOOL_HISTORY_HAS_MORE_PREFIX}${page.hasMore} ${TOOL_HISTORY_TOTAL_PREFIX}${page.totalMessages}`;
				return { content: [{ type: "text", text }], details: undefined };
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					details: undefined,
					isError: true,
				};
			}
		},
	});

	// #154 T7：LLM-only 只读工具——返回内置中文默认值/合法 key/占位符规则/JSON 骨架。
	// 不注册 slash command（仅 registerTool，T7 定稿）；idle/Character 可用，
	// creator/joining 拒绝（门禁与 /tavern-character-edit 同语义）。
	pi.registerTool({
		name: "tavern_template_defaults",
		label: TOOL_TEMPLATE_DEFAULTS_LABEL,
		description: TOOL_TEMPLATE_DEFAULTS_DESCRIPTION,
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async (_toolCallId, _params, _signal, _onUpdate, _ctx) => {
			const state = ctrl.getState();
			if (state.type === "creator" || state.type === "joining") {
				return {
					content: [{ type: "text", text: TOOL_TEMPLATE_DEFAULTS_STATE_REJECTED }],
					details: undefined,
					isError: true,
				};
			}
			const ruleLines = MESSAGE_TEMPLATE_KEYS.map((key) => {
				const rule = TEMPLATE_RULES_DOC[key];
				return `- ${key}: 必留 ${rule.required.join("/")}；合法 ${rule.allowed.join("/")}（未知/缺失/禁止占位符判无效）`;
			}).join("\n");
			const skeletonLines = MESSAGE_TEMPLATE_KEYS.map((key) => {
				const rule = TEMPLATE_RULES_DOC[key];
				const sample = rule.allowed.map((name) => `{${name}}`).join(" ");
				return `  "${key}": "${sample}"`;
			}).join(",\n");
			const text =
				`群聊文案模板（message_templates JSON 文件）内置中文默认值与规则：\n` +
				`\n合法 key（5 个）：\n${MESSAGE_TEMPLATE_KEYS.join("、")}\n` +
				`\n占位符规则：\n${ruleLines}\n` +
				`\n默认值：\n${JSON.stringify(DEFAULT_TEMPLATES, null, 2)}\n` +
				`\nJSON 骨架（tavern.json 的 message_templates 指向该文件，相对路径）：\n{\n${skeletonLines}\n}`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	});
}

/** #154 T7：各 key 占位符规则（工具输出文档用；校验逻辑以 validateTemplate 为准）。 */
const TEMPLATE_RULES_DOC: Record<MessageTemplateKey, { required: string[]; allowed: string[] }> = {
	public_message: { required: ["sender", "content"], allowed: ["sender", "content"] },
	whisper_full: { required: ["sender", "receiver", "content"], allowed: ["sender", "receiver", "content"] },
	whisper_placeholder: { required: ["sender", "receiver"], allowed: ["sender", "receiver"] },
	seconds_ago: { required: ["count"], allowed: ["count"] },
	minutes_ago: { required: ["count"], allowed: ["count"] },
};
