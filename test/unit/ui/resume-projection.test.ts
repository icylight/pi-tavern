import { describe, expect, it } from "vitest";

import type { PublicMessageState } from "../../../src/creator/creator-runtime.js";
import { computeResumeProjection } from "../../../src/ui/resume-projection.js";

/**
 * #42 红测（unit 层）：resume 历史投影的窗口-锚定纯逻辑。
 *
 * 契约（与 Dev 落点对齐，index.ts 扩展层调用）：
 * - 窗口：取 publicMessages 尾部 windowSize 条（sequence 序）；长度 ≤
 *   windowSize 时全量。
 * - 锚定：仅投影 sequence > anchorSequence 的条目（已投影段不重复），
 *   按 sequence 升序返回。
 * - 边界两分支（Arch 评审）：anchorSequence ≥ 窗口内最大 sequence → 空；
 *   anchorSequence < 窗口起点 sequence → 补整窗口。
 *
 * 红测语义：本模块尚不存在（Dev 实现时新建），测试为行为规格先行；
 * 实现后按此转绿。
 */

function aMessage(sequence: number, content = `msg-${sequence}`): PublicMessageState {
	return {
		sender: { type: "user_persona" },
		content,
		event_id: `evt-${sequence}`,
		sequence,
		timestamp: `2026-08-01T00:00:00.000Z`,
		round: { round_max_messages: 20, used_messages: 0, remaining_messages: 20 },
	};
}

function aSequenceRange(from: number, to: number): PublicMessageState[] {
	const messages: PublicMessageState[] = [];
	for (let sequence = from; sequence <= to; sequence += 1) {
		messages.push(aMessage(sequence));
	}
	return messages;
}

describe("#42 resume projection: window-anchor pure logic (A1/A3)", () => {
	it("A1: 长度 ≤ 窗口时全量投影（30 条 < 100）", () => {
		const messages = aSequenceRange(1, 30);
		const projected = computeResumeProjection(messages, 0, 100);
		expect(projected.map((m: PublicMessageState) => m.sequence)).toEqual(aSequenceRange(1, 30).map((m: PublicMessageState) => m.sequence));
	});

	it("A1: 长度 > 窗口时仅投影尾部窗口（120 条 → 尾部 100 条）", () => {
		const messages = aSequenceRange(1, 120);
		const projected = computeResumeProjection(messages, 0, 100);
		expect(projected).toHaveLength(100);
		expect(projected[0]?.sequence).toBe(21);
		expect(projected[99]?.sequence).toBe(120);
	});

	it("A1: 锚定 ≥ 窗口起点时只补锚后缺失段（anchor=100 → 101..120）", () => {
		const messages = aSequenceRange(1, 120);
		const projected = computeResumeProjection(messages, 100, 100);
		expect(projected.map((m: PublicMessageState) => m.sequence)).toEqual(aSequenceRange(101, 120).map((m: PublicMessageState) => m.sequence));
	});

	it("A1: 锚定 ≥ 窗口内最大 sequence 时为空（无新投影）", () => {
		const messages = aSequenceRange(1, 120);
		expect(computeResumeProjection(messages, 120, 100)).toEqual([]);
		expect(computeResumeProjection(messages, 200, 100)).toEqual([]);
	});

	it("A1: 锚定 < 窗口起点时补整窗口（anchor=10 → 21..120 全窗口）", () => {
		const messages = aSequenceRange(1, 120);
		const projected = computeResumeProjection(messages, 10, 100);
		expect(projected).toHaveLength(100);
		expect(projected[0]?.sequence).toBe(21);
	});

	it("A3-1: 幂等——同锚定重复调用返回空（重复 resume 无重复）", () => {
		const messages = aSequenceRange(1, 30);
		const first = computeResumeProjection(messages, 0, 100);
		expect(first).toHaveLength(30);
		// 首次投影后锚定 = 最大 sequence，再次调用不重复
		expect(computeResumeProjection(messages, 30, 100)).toEqual([]);
	});

	it("A3-2: 中断重入——半程投影态只补缺失段（anchor=110 → 111..120）", () => {
		const messages = aSequenceRange(1, 120);
		// 模拟投影中断：已投影 21..110（锚定 110），重入补 111..120
		const projected = computeResumeProjection(messages, 110, 100);
		expect(projected.map((m: PublicMessageState) => m.sequence)).toEqual(aSequenceRange(111, 120).map((m: PublicMessageState) => m.sequence));
	});

	it("A2: 投影条目按 sequence 升序、字段逐条透传（内容/发送者/round 一致）", () => {
		const messages = [aMessage(2, "second"), aMessage(1, "first"), aMessage(3, "third")];
		const projected = computeResumeProjection(messages, 0, 100);
		expect(projected.map((m: PublicMessageState) => m.sequence)).toEqual([1, 2, 3]);
		for (const message of projected) {
			const source = messages.find((m) => m.sequence === message.sequence);
			expect(message.content).toBe(source?.content);
			expect(message.event_id).toBe(source?.event_id);
			expect(message.timestamp).toBe(source?.timestamp);
			expect(message.sender).toEqual(source?.sender);
			expect(message.round).toEqual(source?.round);
		}
	});
});
