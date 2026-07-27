import type { ExtensionAPI, InputEventResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { registerCommands } from "./commands.js";
import { TavernController } from "./controller/tavern-controller.js";

export default function piTavern(pi: ExtensionAPI, controller?: TavernController): void {
	const ctrl = controller ?? new TavernController();
	registerCommands(pi, ctrl);

	// Keep tavern_speak active-tool state in sync with controller state
	ctrl.onStateChange = () => syncActiveTools(pi, ctrl);

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
			state.runtime.updateStreaming(true);
		}
	});

	pi.on("agent_settled", () => {
		const state = ctrl.getState();
		if (state.type === "character") {
			state.runtime.updateStreaming(false);
		}
	});

	// Enable tavern_speak only when in character state; disable otherwise
	pi.on("session_start", () => {
		syncActiveTools(pi, ctrl);
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
