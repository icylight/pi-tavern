import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
	UI_BOARD_PREFIX,
	UI_BOARD_VERB_ADD,
	UI_BOARD_VERB_CLEAR,
	UI_BOARD_VERB_REMOVE,
	UI_BOARD_VERB_UPDATE,
} from "../shared/messages.js";

export function registerRenderers(pi: ExtensionAPI): void {
	pi.registerEntryRenderer("pi-tavern.creator-display", (entry, _options, theme) => {
		const data = entry.data as {
			kind: "public_message" | "board_update";
			group_chat_id: string;
			event?: { sender: { type: string; name?: string }; content: string };
			actor?: string;
			actor_name?: string;
			action?: "add" | "update" | "remove" | "clear";
			note?: { id: string; content: string };
		};
		const box = new Box(0, 1, (t) => theme.bg("customMessageBg", t));
		if (data.kind === "board_update") {
			// 白板模型（#114）：board 实时提示行（纯展示）。
			const verb =
				data.action === "add"
					? UI_BOARD_VERB_ADD
					: data.action === "update"
						? UI_BOARD_VERB_UPDATE
						: data.action === "remove"
							? UI_BOARD_VERB_REMOVE
							: UI_BOARD_VERB_CLEAR;
			const suffix = data.action === "clear" ? "。" : `：「${data.note?.content ?? ""}」`;
			const label = data.actor_name ?? data.actor ?? "Character";
			const prefix = theme.fg("accent", UI_BOARD_PREFIX);
			box.addChild(new Text(`${prefix} ${label} ${verb}${suffix}`, 0, 0));
			return box;
		}
		if (!data.event) {
			return box;
		}
		const sender = data.event.sender;
		const label =
			sender.type === "user_persona" ? "You" : sender.type === "character" ? (sender.name ?? "Character") : sender.type;
		const prefix = theme.fg("accent", `[${label}]`);
		box.addChild(new Text(`${prefix} ${data.event.content}`, 0, 0));
		return box;
	});

	pi.registerMessageRenderer("pi-tavern.group-chat-input", (message, { outputPad }, theme) => {
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(message.content as string, 0, 0));
		return box;
	});
}
