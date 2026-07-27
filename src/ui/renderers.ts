import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export function registerRenderers(pi: ExtensionAPI): void {
	pi.registerEntryRenderer("pi-tavern.creator-display", (entry, _options, theme) => {
		const data = entry.data as {
			kind: "public_message";
			group_chat_id: string;
			event: { sender: { type: string; name?: string }; content: string };
		};
		const sender = data.event.sender;
		const label =
			sender.type === "user_persona" ? "You" : sender.type === "character" ? (sender.name ?? "Character") : sender.type;
		const prefix = theme.fg("accent", `[${label}]`);
		const box = new Box(0, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${prefix} ${data.event.content}`, 0, 0));
		return box;
	});

	pi.registerMessageRenderer("pi-tavern.group-chat-input", (message, { outputPad }, theme) => {
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(message.content as string, 0, 0));
		return box;
	});
}
