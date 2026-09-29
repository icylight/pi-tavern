/**
 * 角色卡 model/thinking 字段 → 转换队列输入（#180 L3，契约 §1/§7）。
 *
 * 纯函数：只做「基础检查通过维度 = ok」的派生，不做任何语义校验（provider-id
 * 格式、thinking 枚举归执行器/pi）。absent 不出现在 mask 也不产生 warning；
 * invalid（非 string/空串）不提交、不拍基线、不恢复，仅产出一条提示——提示由
 * 装配方经 executor.notifyWarning 发出（§10：提示逻辑不落 runtime 层）。
 */
import type { CharacterCard } from "../config/character-card.js";
import type { ModelTransitionTarget, ProfileMask } from "./model-transition-queue.js";

export interface ModelProfilePlan {
	/** 基础检查通过维度（= status ok）；其余维度保持 false，不捕捉不恢复。 */
	mask: ProfileMask;
	/** switch 目标（仅 ok 维度）；模型为角色卡原始串，拆分归队列。 */
	target: ModelTransitionTarget;
	/** 配置非法维度的提示文案（调用方经单一 warning 通道发出）。 */
	warnings: string[];
}

export function planModelProfile(card: CharacterCard): ModelProfilePlan {
	const mask: ProfileMask = {
		model: card.model?.status === "ok",
		thinking: card.thinking?.status === "ok",
	};
	const target: ModelTransitionTarget = {
		...(card.model?.status === "ok" ? { model: card.model.model } : {}),
		...(card.thinking?.status === "ok" ? { thinking: card.thinking.level } : {}),
	};
	const warnings: string[] = [];
	if (card.model?.status === "invalid") {
		warnings.push("Model hook: invalid model field (expected a non-empty string); skipping model switch");
	}
	if (card.thinking?.status === "invalid") {
		warnings.push("Model hook: invalid thinking field (expected a non-empty string); skipping thinking change");
	}
	return { mask, target, warnings };
}
