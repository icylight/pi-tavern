import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ABORT_CONTROL_CUSTOM_TYPE } from "../character/group-chat-input.js";
import type { TavernController } from "../controller/tavern-controller.js";

/** 接线 pi Agent 生命周期事件（run 状态/流式汇报/Character 系统提示词注入）。 */
export function wireAgentLifecycle(pi: ExtensionAPI, ctrl: TavernController): void {
	// 隐藏打断令牌只负责在 steer 安全边界唤起 context 钩子。所有历史令牌都从
	// 模型上下文过滤；只有当前 CharacterRuntime 的输入管线仍持有待打断状态时，
	// 才在这一边界 abort 当前 run。
	pi.on("context", (event, ctx) => {
		const hasAbortControlToken = event.messages.some(
			(message) => message.role === "custom" && message.customType === ABORT_CONTROL_CUSTOM_TYPE,
		);
		if (hasAbortControlToken) {
			const state = ctrl.getState();
			if (state.type === "character") {
				state.runtime.groupChatInput?.consumeAbortControlToken(() => ctx.abort());
			}
		}
		return {
			messages: event.messages.filter(
				(message) => !(message.role === "custom" && message.customType === ABORT_CONTROL_CUSTOM_TYPE),
			),
		};
	});

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
			// #90：agent_start 续命——取消上一次 agent_end 布防的 5s 显示复位
			// watchdog（continue 段边界：agent_end → 毫秒级 continue → agent_start；
			// 不清除则定时器在段内 LLM 调用 >5s 时误灭灯，长 run 收尾段最易触发）。
			state.runtime.clearStreamingResetWatchdog();
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
