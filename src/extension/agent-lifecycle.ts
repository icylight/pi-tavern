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
			// #77：语义 = 「正在工作」（run 活跃即亮，User 2026-08-03 拍板）。
			// 任何 run（群聊触发/忙态 steer/救援/私有直聊）启动都点亮，
			// 不区分触发源——「正在发言」指示改为 agent 活跃指示。
			state.runtime.updateStreaming(true);
			// #66：agent_start 布防 run wedged watchdog（W 内无 agent_settled →
			// 强制收敛）；happy path 由 agent_settled 的 settleRun 清除。
			state.runtime.armRunWedgedWatchdog();
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
			// #66：统一 settle 路径（含 run watchdog 清除与 wedged 幂等合并）。
			state.runtime.settleRun();
		}
	});
}
