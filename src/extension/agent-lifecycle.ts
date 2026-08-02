import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { TavernController } from "../controller/tavern-controller.js";

/** 接线 pi Agent 生命周期事件（run 状态/流式汇报/Character 系统提示词注入）。 */
export function wireAgentLifecycle(pi: ExtensionAPI, ctrl: TavernController): void {
	// 在线时把角色卡 Markdown 注入为系统提示词扩展
	pi.on("before_agent_start", (event) => {
		const state = ctrl.getState();
		if (state.type !== "character") return;

		const character = state.runtime.character;
		return {
			systemPrompt: `${event.systemPrompt}\n\n---\n# Character Persona: ${character.name}\n${character.prompt}`,
		};
	});

	// 向群聊 creator 汇报流式状态
	pi.on("agent_start", () => {
		const state = ctrl.getState();
		if (state.type === "character") {
			// M7（ISSUE-012/#24）：标记 run 活跃，使 group_chat_update 拉取排队
			// 而不是打断当前轮次。
			state.runtime.isAgentActive = true;
			// ISSUE-014/#14-A1/A2：只有群聊触发的轮次点亮 is_streaming（语义收敛）。
			// 用户直聊轮次（直聊、非群聊跟进）保持暗。标记由 GroupChatInput.flush
			// 在投递前设置。
			state.runtime.updateStreaming(state.runtime.consumeGroupChatTurnTriggered());
		}
	});

	pi.on("agent_end", () => {
		const state = ctrl.getState();
		if (state.type === "character") {
			// ISSUE-014/#14-A3：布防流式复位 watchdog。若 agent_settled 永不
			// 到达（run 中止/报错/卡死），定时器强制复位 is_streaming，使「正在
			// 发言」显示不会悬挂；happy path 下 agent_settled 清除定时器。
			state.runtime.armStreamingResetWatchdog();
		}
	});

	pi.on("agent_settled", () => {
		const state = ctrl.getState();
		if (state.type === "character") {
			state.runtime.isAgentActive = false;
			state.runtime.clearStreamingResetWatchdog();
			state.runtime.updateStreaming(false);
			// 冲刷 run 活跃期间排队的增量。
			state.runtime.onAgentSettled?.();
		}
	});
}
