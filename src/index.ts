import type { ExtensionAPI, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";

import { registerCommands } from "./commands.js";
import { TavernController } from "./controller/tavern-controller.js";

export default function piTavern(pi: ExtensionAPI, controller?: TavernController): void {
	const ctrl = controller ?? new TavernController();
	registerCommands(pi, ctrl);

	pi.on("input", (_event: InputEvent) => {
		if (ctrl.getState().type === "creator") {
			return { action: "handled" } as InputEventResult;
		}
		return { action: "continue" } as InputEventResult;
	});
}
