import { describe, expect, it } from "vitest";

import {
	decodeClientMessage,
	decodeServerMessage,
	encodeMessage,
	MAX_WEBSOCKET_FRAME_BYTES,
	ProtocolError,
} from "../../../src/protocol/codec.js";

describe("PiTavern protocol codec", () => {
	// #119 阻断①（苍蓝星 2026-08-06）：request/notification/response 三态 schema 区分。
	// 红测先行：当前 RequestIdSchema = Optional，无 id 帧可通过 codec（红）；
	// 拆分后 request/response 强制字符串 id，仅 update_character_state 为无 id notification。
	describe("id 三态区分（#119 阻断①）", () => {
		it("A1 无 id 的 request 被拒", () => {
			expect(() =>
				decodeClientMessage(
					Buffer.from(
						JSON.stringify({
							jsonrpc: "2.0",
							method: "join_group_chat",
							params: { session_id: "session-1" },
						}),
					),
				),
			).toThrow(ProtocolError);
		});

		it("A2 无 id 的 response 被拒", () => {
			expect(() =>
				decodeServerMessage(
					Buffer.from(
						JSON.stringify({
							jsonrpc: "2.0",
							result: { published: true, event_id: "evt-1", sequence: 1, latest_sequence: 1 },
						}),
					),
				),
			).toThrow(ProtocolError);
		});

		it("A3 update_character_state 无 id notification 被接受", () => {
			expect(
				decodeClientMessage(
					Buffer.from(
						JSON.stringify({
							jsonrpc: "2.0",
							method: "update_character_state",
							params: { is_streaming: true },
						}),
					),
				),
			).toEqual({ jsonrpc: "2.0", method: "update_character_state", params: { is_streaming: true } });
		});

		it("A4 update_character_state 带 id 被拒（notification 不得携带 id）", () => {
			expect(() =>
				decodeClientMessage(
					Buffer.from(
						JSON.stringify({
							jsonrpc: "2.0",
							id: "req-n",
							method: "update_character_state",
							params: { is_streaming: true },
						}),
					),
				),
			).toThrow(ProtocolError);
		});

		it("A5 JSON-RPC 标准错误码响应被接受（库自产帧不判协议破坏）", () => {
			// 二轮评审阻断④（苍蓝星）：vscode-jsonrpc 会自产标准错误
			// （handler 抛普通 Error → -32603、无 handler → -32601、参数错 → -32602）——
			// schema 必须接受，否则本端合法响应被 codec 拒 → 误断线。
			for (const code of [-32700, -32600, -32601, -32602, -32603]) {
				const decoded = decodeServerMessage(
					Buffer.from(
						JSON.stringify({
							jsonrpc: "2.0",
							id: "req-s",
							error: { code, message: "standard error" },
						}),
					),
				);
				expect(decoded).toEqual({ jsonrpc: "2.0", id: "req-s", error: { code, message: "standard error" } });
			}
		});
	});

	it("decodes a strict snake_case client request", () => {
		expect(
			decodeClientMessage(
				Buffer.from(
					JSON.stringify({
						jsonrpc: "2.0",
						id: "req-1",
						method: "join_group_chat",
						params: { session_id: "session-1" },
					}),
				),
			),
		).toEqual({
			jsonrpc: "2.0",
			id: "req-1",
			method: "join_group_chat",
			params: { session_id: "session-1" },
		});
	});

	it("rejects malformed JSON, unknown methods, and extra fields", () => {
		expect(() => decodeClientMessage(Buffer.from("{broken"))).toThrow(ProtocolError);
		expect(() =>
			decodeClientMessage(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "unknown_method" }))),
		).toThrow(ProtocolError);
		expect(() =>
			decodeClientMessage(
				Buffer.from(
					JSON.stringify({
						jsonrpc: "2.0",
						id: "req-1",
						method: "character_ready",
						params: { sessionId: "camel-case-is-invalid" },
					}),
				),
			),
		).toThrow(ProtocolError);
	});

	it("decodes server messages and encodes compact JSON", () => {
		const message = {
			jsonrpc: "2.0",
			id: "req-1",
			result: null,
		};

		expect(decodeServerMessage(Buffer.from(JSON.stringify(message)))).toEqual(message);
		expect(encodeMessage(message)).toBe(JSON.stringify(message));
	});

	it("rejects encoded frames larger than 1 MiB", () => {
		expect(() =>
			encodeMessage({
				type: "oversized",
				content: "x".repeat(MAX_WEBSOCKET_FRAME_BYTES),
			}),
		).toThrow(/1 MiB/);
	});

	it("decodes a speak client message", () => {
		const message = decodeClientMessage(
			Buffer.from(
				JSON.stringify({
					jsonrpc: "2.0",
					id: "req-8",
					method: "speak",
					params: { content: "I suggest starting with the persistence layer." },
				}),
			),
		);

		expect(message).toEqual({
			jsonrpc: "2.0",
			id: "req-8",
			method: "speak",
			params: { content: "I suggest starting with the persistence layer." },
		});
	});

	it("decodes a speak response", () => {
		const published = decodeServerMessage(
			Buffer.from(
				JSON.stringify({
					jsonrpc: "2.0",
					id: "req-8",
					result: {
						published: true,
						event_id: "evt-1",
						sequence: 1,
						// ISSUE-013 B6：成功携带 latest_sequence，客户端可将
						// last-seen 推进到越过自己已发布的消息。
						latest_sequence: 1,
						round: { round_max_messages: 10, used_messages: 1, remaining_messages: 9 },
					},
				}),
			),
		);

		expect(published).toEqual({
			jsonrpc: "2.0",
			id: "req-8",
			result: {
				published: true,
				event_id: "evt-1",
				sequence: 1,
				latest_sequence: 1,
				round: { round_max_messages: 10, used_messages: 1, remaining_messages: 9 },
			},
		});

		const rejected = decodeServerMessage(
			Buffer.from(
				JSON.stringify({
					jsonrpc: "2.0",
					id: "req-9",
					result: {
						published: false,
						reason: "round_limit_reached",
						hand_raised: true,
						round: { round_max_messages: 10, used_messages: 10, remaining_messages: 0 },
					},
				}),
			),
		);

		expect(rejected).toEqual({
			jsonrpc: "2.0",
			id: "req-9",
			result: {
				published: false,
				reason: "round_limit_reached",
				hand_raised: true,
				round: { round_max_messages: 10, used_messages: 10, remaining_messages: 0 },
			},
		});
	});

	it("decodes get_message_history and get_chat_history_file requests", () => {
		expect(
			decodeClientMessage(
				Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "req-1", method: "get_message_history", params: {} })),
			),
		).toEqual({ jsonrpc: "2.0", id: "req-1", method: "get_message_history", params: {} });
		expect(
			decodeClientMessage(
				Buffer.from(
					JSON.stringify({ jsonrpc: "2.0", id: "req-2", method: "get_message_history", params: { cursor: "opaque" } }),
				),
			),
		).toEqual({ jsonrpc: "2.0", id: "req-2", method: "get_message_history", params: { cursor: "opaque" } });
		expect(
			decodeClientMessage(
				Buffer.from(
					JSON.stringify({ jsonrpc: "2.0", id: "req-3", method: "get_message_history", params: { cursor: null } }),
				),
			),
		).toEqual({ jsonrpc: "2.0", id: "req-3", method: "get_message_history", params: { cursor: null } });
		expect(
			decodeClientMessage(
				Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "req-4", method: "get_chat_history_file" })),
			),
		).toEqual({ jsonrpc: "2.0", id: "req-4", method: "get_chat_history_file" });
	});

	it("decodes a get_message_history response with cursor fields", () => {
		const response = {
			jsonrpc: "2.0",
			id: "req-1",
			result: {
				messages: [
					{
						jsonrpc: "2.0",
						method: "public_message",
						params: {
							event_id: "evt-1",
							sequence: 1,
							timestamp: "2026-07-01T00:00:00.000Z",
							sender: { type: "user_persona" },
							content: "Hello",
							round: { round_max_messages: 10, used_messages: 0, remaining_messages: 10 },
						},
					},
				],
				cursor: null,
				has_more: false,
				total_messages: 1,
			},
		};
		expect(decodeServerMessage(Buffer.from(JSON.stringify(response)))).toEqual(response);
	});

	it("decodes a get_chat_history_file response", () => {
		const response = {
			jsonrpc: "2.0",
			id: "req-1",
			result: { path: "/absolute/path/to/chats/group-1.jsonl" },
		};
		expect(decodeServerMessage(Buffer.from(JSON.stringify(response)))).toEqual(response);
	});
});
