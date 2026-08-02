import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

/** #42：投影锚点文件结构（记录最后成功投影的最大 sequence）。 */
interface ResumeProjectionAnchorFile {
	last_projected_sequence: number;
}

/**
 * #42：读取持久化投影锚点。文件缺失或损坏时返回 0（从头投影——首启
 * resume 的预期行为，acceptance A1 阶段即此路径）。
 */
export function readResumeProjectionAnchor(path: string): number {
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<ResumeProjectionAnchorFile> | null;
		const sequence = parsed?.last_projected_sequence;
		return typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0;
	} catch {
		return 0;
	}
}

/**
 * #42：持久化投影锚点。仅在投影非空时调用——空投影回写 0 会清掉既有
 * 锚点，导致下次 resume 重复投影（A3-1/A3-2 幂等破坏）。
 */
export function writeResumeProjectionAnchor(path: string, sequence: number): void {
	mkdirSync(dirname(path), { recursive: true });
	const data: ResumeProjectionAnchorFile = { last_projected_sequence: sequence };
	writeFileSync(path, JSON.stringify(data));
}
