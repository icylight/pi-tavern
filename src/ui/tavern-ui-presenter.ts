import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { TavernController } from "../controller/tavern-controller.js";
import type { RoundState } from "../data/group-chat-state.js";
import {
	UI_CHARACTER_TITLE_MID,
	UI_CHARACTER_TITLE_PREFIX,
	UI_CREATOR_TITLE,
	UI_CREATOR_TITLE_PREFIX,
	UI_HAND_RAISED_PREFIX,
	UI_JOINING_GROUP_CHAT,
	UI_MEMBER_COUNT_UNKNOWN,
	UI_ONLINE_COUNT_SUFFIX,
	UI_SPEECH_COUNT_MID,
	UI_SPEECH_COUNT_PREFIX,
} from "../shared/messages.js";

/** 页脚状态与底部 widget 共用的固定键。 */
const TAVERN_UI_KEY = "pi-tavern";

export interface TavernViewModel {
	status: string | null;
	widgetLines: string[] | null;
}

/**
 * 从 Controller 与 runtime 状态快照派生的只读视图模型。缓存只为避免
 * 冗余刷新；它绝不参与协议、配额、成员资格或 resume 决策。
 */
export function buildTavernViewModel(controller: TavernController): TavernViewModel {
	const state = controller.getState();
	switch (state.type) {
		case "idle":
			return { status: null, widgetLines: null };
		case "joining":
			return { status: UI_JOINING_GROUP_CHAT, widgetLines: null };
		case "creator": {
			const { runtime } = state;
			const name = runtime.state.groupChat.name;
			const status = name ? `${UI_CREATOR_TITLE_PREFIX}${name}` : UI_CREATOR_TITLE;
			return {
				status,
				widgetLines: creatorWidgetLines(runtime.state),
			};
		}
		case "character": {
			const { runtime } = state;
			const groupName = runtime.lastGroupChatState?.group_chat?.name ?? null;
			const status = groupName
				? `${UI_CHARACTER_TITLE_PREFIX}${runtime.character.name}${UI_CHARACTER_TITLE_MID}${groupName}`
				: `${UI_CHARACTER_TITLE_PREFIX}${runtime.character.name}`;
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
	const onlineCount = state.onlineCharacters.size + 1; // + User Persona 也计入
	const streaming = [...state.onlineCharacters.values()]
		.filter((online) => online.isStreaming)
		.map((online) => online.character.name);
	const raised = [...state.onlineCharacters.values()]
		.filter((online) => online.handRaised)
		.map((online) => online.character.name);
	const lines = [`${onlineCount}${UI_ONLINE_COUNT_SUFFIX}`];
	if (streaming.length > 0) {
		// #77：语义 = 「正在工作」（run 活跃即亮，User 2026-08-03 拍板）。
		lines.push(`正在工作：${streaming.join("、")}`);
	}
	const round = state.round;
	if (round) {
		lines.push(
			`${UI_SPEECH_COUNT_PREFIX}${round.usedMessages}/${round.roundMaxMessages}${UI_SPEECH_COUNT_MID}${round.roundMaxMessages - round.usedMessages}`,
		);
	}
	if (raised.length > 0) {
		lines.push(`${UI_HAND_RAISED_PREFIX}${raised.join("、")}`);
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
		return [UI_MEMBER_COUNT_UNKNOWN];
	}
	const lines = [`${snapshot.online_characters.length + 1}${UI_ONLINE_COUNT_SUFFIX}`];
	const streaming = snapshot.online_characters.filter((c) => c.is_streaming).map((c) => c.name);
	if (streaming.length > 0) {
		// #77：语义 = 「正在工作」（run 活跃即亮，User 2026-08-03 拍板）。
		lines.push(`正在工作：${streaming.join("、")}`);
	}
	const round = snapshot.round;
	if (round) {
		lines.push(
			`${UI_SPEECH_COUNT_PREFIX}${round.used_messages}/${round.round_max_messages}${UI_SPEECH_COUNT_MID}${round.remaining_messages}`,
		);
	}
	const raised = snapshot.online_characters.filter((c) => c.hand_raised).map((c) => c.name);
	if (raised.length > 0) {
		lines.push(`${UI_HAND_RAISED_PREFIX}${raised.join("、")}`);
	}
	return lines;
}

/**
 * 通过当前 Extension Runtime 的 UI 上下文渲染视图模型。
 * UI 失败只是局部展示问题：它们绝不改变群聊状态、撤销公共消息
 * 或关闭 WebSocket。
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
			// 尽力展示即可。
		}
	}
}
