import { describe, expect, it } from "vitest";
import {
	computeResumeProjection,
	computeSessionProjectionAnchor,
	type ProjectionEntryReader,
} from "../../../src/data/resume-projection.js";
import type { PublicMessageState } from "../../../src/protocol/public-message-state.js";

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
		expect(projected.map((m: PublicMessageState) => m.sequence)).toEqual(
			aSequenceRange(1, 30).map((m: PublicMessageState) => m.sequence),
		);
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
		expect(projected.map((m: PublicMessageState) => m.sequence)).toEqual(
			aSequenceRange(101, 120).map((m: PublicMessageState) => m.sequence),
		);
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
		expect(projected.map((m: PublicMessageState) => m.sequence)).toEqual(
			aSequenceRange(111, 120).map((m: PublicMessageState) => m.sequence),
		);
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

	describe("#42 resume projection: session-anchor scan (A3-1 会话复用防御)", () => {
		const GROUP_CHAT_ID = "group-1";

		function aDisplayEntry(
			sequence: number,
			groupChatId = GROUP_CHAT_ID,
		): {
			customType?: string;
			data?: { group_chat_id?: string; event?: { sequence?: unknown } };
		} {
			return {
				customType: "pi-tavern.creator-display",
				data: {
					group_chat_id: groupChatId,
					event: { sequence },
				},
			};
		}

		function readerOf(entries: Array<ReturnType<typeof aDisplayEntry> | Record<string, never>>): ProjectionEntryReader {
			return { getEntries: () => entries };
		}

		it("null/undefined reader 与空条目均返回 0", () => {
			expect(computeSessionProjectionAnchor(null, GROUP_CHAT_ID)).toBe(0);
			expect(computeSessionProjectionAnchor(undefined, GROUP_CHAT_ID)).toBe(0);
			expect(computeSessionProjectionAnchor(readerOf([]), GROUP_CHAT_ID)).toBe(0);
		});

		it("非 creator-display 条目忽略（其他 customType 不参与锚定）", () => {
			const reader = readerOf([
				{ customType: "pi-tavern.other", data: { group_chat_id: GROUP_CHAT_ID, event: { sequence: 99 } } },
				aDisplayEntry(5),
			]);
			expect(computeSessionProjectionAnchor(reader, GROUP_CHAT_ID)).toBe(5);
		});

		it("其他群聊条目忽略（group_chat_id 过滤）", () => {
			const reader = readerOf([aDisplayEntry(42, "group-other"), aDisplayEntry(7, GROUP_CHAT_ID)]);
			expect(computeSessionProjectionAnchor(reader, GROUP_CHAT_ID)).toBe(7);
		});

		it("乱序输入取最大 sequence", () => {
			const reader = readerOf([aDisplayEntry(3), aDisplayEntry(9), aDisplayEntry(1), aDisplayEntry(5)]);
			expect(computeSessionProjectionAnchor(reader, GROUP_CHAT_ID)).toBe(9);
		});

		it("非数值/非安全整数 sequence 忽略（string、NaN、小数）", () => {
			const reader = readerOf([
				aDisplayEntry(3),
				{ customType: "pi-tavern.creator-display", data: { group_chat_id: GROUP_CHAT_ID, event: { sequence: "9" } } },
				{ customType: "pi-tavern.creator-display", data: { group_chat_id: GROUP_CHAT_ID, event: { sequence: NaN } } },
				{ customType: "pi-tavern.creator-display", data: { group_chat_id: GROUP_CHAT_ID, event: { sequence: 1.5 } } },
			]);
			expect(computeSessionProjectionAnchor(reader, GROUP_CHAT_ID)).toBe(3);
		});

		it("缺 data/group_chat_id/event.sequence 的条目忽略（不抛错）", () => {
			const reader = readerOf([
				{ customType: "pi-tavern.creator-display", data: { group_chat_id: GROUP_CHAT_ID } },
				{ customType: "pi-tavern.creator-display", data: { event: { sequence: 8 } } },
				{ customType: "pi-tavern.creator-display" },
				aDisplayEntry(4),
			]);
			expect(computeSessionProjectionAnchor(reader, GROUP_CHAT_ID)).toBe(4);
		});

		it("组合：扫描锚定 + 窗口投影——已投影段跳过、只补缺失段（会话复用场景）", () => {
			// 会话内已有 1..3（life-1 增量已写），扫描锚定 = 3；
			// resume 投影从锚后补：4..5 出现 → 只投影 4..5。
			const messages = aSequenceRange(1, 5);
			const anchor = computeSessionProjectionAnchor(
				readerOf([aDisplayEntry(1), aDisplayEntry(2), aDisplayEntry(3)]),
				GROUP_CHAT_ID,
			);
			expect(anchor).toBe(3);
			expect(computeResumeProjection(messages, anchor, 100).map((m) => m.sequence)).toEqual([4, 5]);
		});
	});
});
