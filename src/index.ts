import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCommands } from "./commands.js";
import { TavernController } from "./controller/tavern-controller.js";

export default function piTavern(pi: ExtensionAPI): void {
	const controller = new TavernController();
	registerCommands(pi, controller);
}
