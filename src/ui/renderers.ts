import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { DEFAULT_TEMPLATES, type MessageTemplateKey, renderTemplate } from "../config/message-templates.js";
import {
	UI_BOARD_PREFIX,
	UI_BOARD_VERB_ADD,
	UI_BOARD_VERB_CLEAR,
	UI_BOARD_VERB_REMOVE,
	UI_BOARD_VERB_UPDATE,
} from "../shared/messages.js";

export function registerRenderers(
	pi: ExtensionAPI,
	// #154：模板集 getter 闭包注入（组合根装配；可重赋值字段须 getter 而非值拷贝，
	// 防值拷贝注入陷阱——reload/新群聊后模板集变化需实时可见）。
	getTemplates: () => Record<MessageTemplateKey, string> = () => DEFAULT_TEMPLATES,
): void {
	pi.registerEntryRenderer("pi-tavern.creator-display", (entry, _options, theme) => {
		const data = entry.data as {
			kind: "public_message" | "whisper_message" | "whisper_placeholder" | "board_update";
			group_chat_id: string;
			event?: {
				sender: { type: string; name?: string; character_id?: string };
				recipient?: { type: string; name?: string; character_id?: string };
				content?: string;
			};
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
		// #154：TUI 与 history/实时注入共用同一模板集（T3）——模板产出整行字符串，
		// Box/Text 只做布局；sender 传值与 history 一致（user_persona → "User Persona"，
		// 原 TUI 特有 "You"/[label] 前缀样式随统一移除，留痕 T3）。
		const sender = data.event.sender;
		const label =
			sender.type === "user_persona"
				? "User Persona"
				: sender.type === "character"
					? (sender.name ?? "Character")
					: sender.type;
		const templates = getTemplates();
		if (data.kind === "whisper_message") {
			// #152：创建者视角完整正文（需求基线 WH4）——whisper_full 模板。
			const sender = data.event.sender;
			const recipient = data.event.recipient;
			const senderLabel = sender.name ?? sender.character_id ?? "Character";
			const recipientLabel = recipient?.name ?? recipient?.character_id ?? "Character";
			box.addChild(
				new Text(
					renderTemplate(templates.whisper_full, {
						sender: senderLabel,
						receiver: recipientLabel,
						content: data.event.content ?? "",
					}),
					0,
					0,
				),
			);
			return box;
		}
		if (data.kind === "whisper_placeholder") {
			const sender = data.event.sender;
			const recipient = data.event.recipient;
			const senderLabel = sender.name ?? sender.character_id ?? "Character";
			const recipientLabel = recipient?.name ?? recipient?.character_id ?? "Character";
			box.addChild(
				new Text(
					renderTemplate(templates.whisper_placeholder, {
						sender: senderLabel,
						receiver: recipientLabel,
					}),
					0,
					0,
				),
			);
			return box;
		}
		box.addChild(
			new Text(renderTemplate(templates.public_message, { sender: label, content: data.event.content ?? "" }), 0, 0),
		);
		return box;
	});

	pi.registerMessageRenderer("pi-tavern.group-chat-input", (message, { outputPad }, theme) => {
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(message.content as string, 0, 0));
		return box;
	});
}
