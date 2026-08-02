import type { PublicMessageState } from "../creator/creator-runtime.js";

/**
 * #42（ISSUE-042）：resume 历史投影的窗口-锚定纯逻辑。
 *
 * 契约（test/unit/ui/resume-projection.test.ts 固化，8 用例）：
 * - 窗口：取 publicMessages 尾部 windowSize 条（sequence 序）；长度 ≤
 *   windowSize 时全量投影。
 * - 锚定：仅投影 sequence > anchorSequence 的条目（已投影段不重复），
 *   按 sequence 升序返回；输入乱序时仍升序（A2）。
 * - 边界两分支：anchorSequence ≥ 窗口内最大 sequence → 空；
 *   anchorSequence < 窗口起点（maxSeq − windowSize + 1）→ 补整窗口；
 *   锚定落在窗口内 → 只补锚后缺失段。
 */
export function computeResumeProjection(
	publicMessages: PublicMessageState[],
	anchorSequence: number,
	windowSize: number,
): PublicMessageState[] {
	if (windowSize <= 0 || publicMessages.length === 0) {
		return [];
	}
	const maxSequence = Math.max(...publicMessages.map((message) => message.sequence));
	const windowStart = maxSequence - windowSize + 1;
	return publicMessages
		.filter((message) => message.sequence >= windowStart && message.sequence > anchorSequence)
		.sort((a, b) => a.sequence - b.sequence);
}

/**
 * #42：会话内投影条目扫描所需的最小接口（兼容 ReadonlySessionManager）。
 * 结构化而非直接依赖 pi SDK 类型，保持纯逻辑模块可独立测试。
 */
export interface ProjectionEntryReader {
	getEntries(): Array<{
		type?: string;
		customType?: string;
		data?: unknown;
	}>;
}

/**
 * #42：扫描当前 pi 会话内本群聊的 creator-display 条目，返回最大 sequence。
 *
 * resume 投影锚定的唯一来源（PM 裁决方案 B，无标记文件）：fresh 会话
 * （无条目）→ 锚定 0 → 全窗口投影（每次 fresh resume 都有历史）；continued
 * 会话（interactive --continue / pi /resume 进旧会话）→ 跳过已显示段防重复；
 * 同会话重复 resume → 扫描幂等空。中断重入按已投影最大 sequence 补尾段。
 */
export function computeSessionProjectionAnchor(
	reader: ProjectionEntryReader | null | undefined,
	groupChatId: string,
): number {
	if (!reader) {
		return 0;
	}
	let maxSequence = 0;
	for (const entry of reader.getEntries()) {
		if (entry.customType !== "pi-tavern.creator-display") {
			continue;
		}
		const data = entry.data as { group_chat_id?: unknown; event?: { sequence?: unknown } } | undefined;
		if (data?.group_chat_id !== groupChatId) {
			continue;
		}
		const sequence = data.event?.sequence;
		if (typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > maxSequence) {
			maxSequence = sequence;
		}
	}
	return maxSequence;
}
