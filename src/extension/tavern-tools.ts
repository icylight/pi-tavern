import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { TavernController } from "../controller/tavern-controller.js";

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
