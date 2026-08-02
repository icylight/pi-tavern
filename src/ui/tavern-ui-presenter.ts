import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { TavernController } from "../controller/tavern-controller.js";
import type { RoundState } from "../creator/group-chat-state.js";

/** Fixed key used for both the footer status and the bottom widget. */
export const TAVERN_UI_KEY = "pi-tavern";

export interface TavernViewModel {
	status: string | null;
	widgetLines: string[] | null;
}

/**
 * Read-only view model derived from the Controller and runtime state
 * snapshots. The cache exists only to avoid redundant refreshes; it never
 * participates in protocol, quota, membership, or resume decisions.
 */
export function buildTavernViewModel(controller: TavernController): TavernViewModel {
	const state = controller.getState();
	switch (state.type) {
		case "idle":
			return { status: null, widgetLines: null };
		case "joining":
			return { status: "正在加入群聊…", widgetLines: null };
		case "creator": {
			const { runtime } = state;
			const name = runtime.state.groupChat.name;
			const status = name ? `Tavern Creator · ${name}` : "Tavern Creator";
			return {
				status,
				widgetLines: creatorWidgetLines(runtime.state),
			};
		}
		case "character": {
			const { runtime } = state;
			const groupName = runtime.lastGroupChatState?.group_chat?.name ?? null;
			const status = groupName
				? `Tavern Character · ${runtime.character.name} · ${groupName}`
				: `Tavern Character · ${runtime.character.name}`;
			return {
				status,
				widgetLines: characterWidgetLines(runtime.lastGroupChatState),
			};
		}
	}
}

function creatorWidgetLines(state: {
	onlineCharacters: Map<string, { character: { name: string }; isStreaming: boolean; handRaised: boolean }>;
	round: RoundState | null;
}): string[] | null {
	const onlineCount = state.onlineCharacters.size + 1; // + User Persona
	const streaming = [...state.onlineCharacters.values()]
		.filter((online) => online.isStreaming)
		.map((online) => online.character.name);
	const raised = [...state.onlineCharacters.values()]
		.filter((online) => online.handRaised)
		.map((online) => online.character.name);
	const lines = [`${onlineCount} 人在线`];
	if (streaming.length > 0) {
		lines.push(`正在发言：${streaming.join("、")}`);
	}
	const round = state.round;
	if (round) {
		lines.push(
			`发言 ${round.usedMessages}/${round.roundMaxMessages} · 剩余 ${round.roundMaxMessages - round.usedMessages}`,
		);
	}
	if (raised.length > 0) {
		lines.push(`举手：${raised.join("、")}`);
	}
	return lines;
}

function characterWidgetLines(
	snapshot: {
		round: {
			round_max_messages: number;
			used_messages: number;
			remaining_messages: number;
		} | null;
		online_characters: Array<{ name: string; is_streaming: boolean; hand_raised: boolean }>;
	} | null,
): string[] | null {
	if (!snapshot) {
		return ["成员数未知"];
	}
	const lines = [`${snapshot.online_characters.length + 1} 人在线`];
	const streaming = snapshot.online_characters.filter((c) => c.is_streaming).map((c) => c.name);
	if (streaming.length > 0) {
		lines.push(`正在发言：${streaming.join("、")}`);
	}
	const round = snapshot.round;
	if (round) {
		lines.push(`发言 ${round.used_messages}/${round.round_max_messages} · 剩余 ${round.remaining_messages}`);
	}
	const raised = snapshot.online_characters.filter((c) => c.hand_raised).map((c) => c.name);
	if (raised.length > 0) {
		lines.push(`举手：${raised.join("、")}`);
	}
	return lines;
}

/**
 * Renders the view model through the current Extension Runtime's UI context.
 * UI failures are local display problems only: they never change group chat
 * state, roll back public messages, or close WebSockets.
 */
export class TavernUiPresenter {
	private ui: ExtensionUIContext | null = null;

	bind(ui: ExtensionUIContext): void {
		this.ui = ui;
	}

	unbind(): void {
		this.ui = null;
	}

	refresh(controller: TavernController): void {
		const ui = this.ui;
		if (!ui) {
			return;
		}
		const view = buildTavernViewModel(controller);
		try {
			ui.setStatus(TAVERN_UI_KEY, view.status ?? undefined);
			ui.setWidget(TAVERN_UI_KEY, view.widgetLines ?? undefined, { placement: "belowEditor" });
		} catch {
			// Best-effort display only.
		}
	}
}
