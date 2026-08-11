import { describe, expect, it } from "vitest";

import { computeLatestOtherSequence } from "../../../../src/creator/creator-pipelines/message-stream.js";
import type { PublicMessageState } from "../../../../src/protocol/public-message-state.js";
import type { WhisperMessageState } from "../../../../src/protocol/whisper-message-state.js";

function publicMessage(
	sequence: number,
	senderId: string,
	senderType: "character" | "user_persona" = "character",
): PublicMessageState {
	return {
		sender: { type: senderType, character_id: senderId, name: senderId },
		content: `public-${sequence}`,
		event_id: `e-${sequence}`,
		sequence,
		timestamp: "2026-08-10T00:00:00Z",
		round: { round_max_messages: 10, used_messages: 1, remaining_messages: 9 },
	} as PublicMessageState;
}

function whisper(sequence: number, senderId: string, recipientId: string): WhisperMessageState {
	return {
		sender: { type: "character", character_id: senderId, name: senderId },
		recipient: { type: "character", character_id: recipientId, name: recipientId },
		content: `whisper-${sequence}`,
		event_id: `w-${sequence}`,
		sequence,
		timestamp: "2026-08-10T00:00:00Z",
		round: { round_max_messages: 10, used_messages: 1, remaining_messages: 9 },
	};
}

describe("computeLatestOtherSequence（服务端投影半场：旁观者占位豁免 stale）", () => {
	it("旁观者视角：A→B whisper 跳过（只可见占位零信息增量），回落更早公开消息", () => {
		const merged = [publicMessage(1, "A"), whisper(2, "A", "B")];
		// 请求者 C：既非 sender 也非 recipient → whisper seq2 不计入 → 回落 seq1。
		expect(computeLatestOtherSequence(merged, "C")).toBe(1);
	});

	it("接收者视角：recipient=我 的 whisper 计入（全文已投递，旧游标发言确应 stale）", () => {
		const merged = [publicMessage(1, "A"), whisper(2, "A", "B")];
		expect(computeLatestOtherSequence(merged, "B")).toBe(2);
	});

	it("发送者视角：自己发送的消息排除（发送者零事件，游标不越自己的私信）", () => {
		const merged = [publicMessage(1, "A"), whisper(2, "C", "D")];
		expect(computeLatestOtherSequence(merged, "C")).toBe(1);
	});

	it("public 恒计入（公开消息防线不破）", () => {
		const merged = [publicMessage(1, "A"), publicMessage(2, "A")];
		expect(computeLatestOtherSequence(merged, "B")).toBe(2);
	});

	it("纯旁观者 whisper 序列：全部跳过 → 0（无可见他人消息）", () => {
		const merged = [whisper(1, "A", "B"), whisper(2, "B", "A")];
		expect(computeLatestOtherSequence(merged, "C")).toBe(0);
	});

	it("空流 → 0", () => {
		expect(computeLatestOtherSequence([], "C")).toBe(0);
	});
});
