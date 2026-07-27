import type { ExtensionAPI, InputEventResult } from "@earendil-works/pi-coding-agent";

import { registerCommands } from "./commands.js";
import { TavernController } from "./controller/tavern-controller.js";

export default function piTavern(pi: ExtensionAPI, controller?: TavernController): void {
	const ctrl = controller ?? new TavernController();
	registerCommands(pi, ctrl);

	pi.on("input", async (event, ctx) => {
		const state = ctrl.getState();
		if (state.type === "creator") {
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
