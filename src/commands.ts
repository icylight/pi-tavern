import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { TavernController } from "./controller/tavern-controller.js";

export function registerCommands(pi: ExtensionAPI, controller: TavernController): void {
	pi.registerCommand("tavern-status", {
		description: "Show the current PiTavern group chat status",
		handler: async (_args, ctx) => {
			const state = controller.getState();
			if (state.type === "idle") {
				ctx.ui.notify("No active group chat", "info");
			}
		},
	});
}
