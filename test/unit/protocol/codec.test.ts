import { describe, expect, it } from "vitest";

import {
	decodeClientMessage,
	decodeServerMessage,
	encodeMessage,
	MAX_WEBSOCKET_FRAME_BYTES,
	ProtocolError,
} from "../../../src/protocol/codec.js";

import { DEFAULT_WELCOME_MESSAGE } from "../../../src/shared/constants.js";

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

	// #97 来源显式化（S1）：public_message 显式 source 字段，缺省=group，未知取值 fail-close。
	// 红测先行：当前 schema 无 source 字段（additionalProperties:false）——①④ 显式 source
	// 帧被拒（红），② 旧格式无 source 通过（兼容锚），③ 未知取值被拒（当前即红，Green 后
	// 由 Literal 判别拒绝，语义不变）。
	describe("source 来源字段（#97 S1）", () => {
		const publicMessage = (params: Record<string, unknown>) => ({
			jsonrpc: "2.0",
			method: "public_message",
			params,
		});
		const baseParams = {
			event_id: "evt-1",
			sequence: 1,
			timestamp: "2026-07-01T00:00:00.000Z",
			sender: { type: "user_persona" },
			content: "Hello",
			round: { round_max_messages: 10, used_messages: 0, remaining_messages: 10 },
		};

		it('S1-1 显式 source:"group" 解码通过且值可读', () => {
			const decoded = decodeServerMessage(
				Buffer.from(JSON.stringify(publicMessage({ ...baseParams, source: "group" }))),
			);
			expect(decoded).toEqual(publicMessage({ ...baseParams, source: "group" }));
		});

		it("S1-2 无 source 字段旧格式解码通过（缺省=group 兼容）", () => {
			expect(decodeServerMessage(Buffer.from(JSON.stringify(publicMessage(baseParams))))).toEqual(
				publicMessage(baseParams),
			);
		});

		it("S1-3 source 未知取值 fail-close", () => {
			expect(() =>
				decodeServerMessage(Buffer.from(JSON.stringify(publicMessage({ ...baseParams, source: "dm" })))),
			).toThrow(ProtocolError);
		});

		it("S1-4 message_history 条目 source 语义同 public_message", () => {
			// 历史条目带 source:"group" 通过（history 与 public_message 同 schema 单点覆盖）。
			const withSource = {
				jsonrpc: "2.0",
				id: "req-1",
				result: {
					messages: [publicMessage({ ...baseParams, source: "group" })],
					cursor: null,
					has_more: false,
					total_messages: 1,
				},
			};
			expect(decodeServerMessage(Buffer.from(JSON.stringify(withSource)))).toEqual(withSource);

			// 历史条目 source 未知取值同样 fail-close。
			const badSource = {
				jsonrpc: "2.0",
				id: "req-1",
				result: {
					messages: [publicMessage({ ...baseParams, source: "dm" })],
					cursor: null,
					has_more: false,
					total_messages: 1,
				},
			};
			expect(() => decodeServerMessage(Buffer.from(JSON.stringify(badSource)))).toThrow(ProtocolError);
		});
	});

	describe("ready 响应携带 latest_sequence（#144 P1-4 方案 a，红钉）", () => {
		it("ready 响应 result 含 latest_sequence（进入时刻水位）可解码", () => {
			const frame = Buffer.from(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 5,
					result: { latest_sequence: 12 },
				}),
			);
			// 当前实现（EmptySuccess result: null）下红；方案 a 拆 ReadyResponseSchema 后绿。
			expect(() => decodeServerMessage(frame)).not.toThrow();
			const decoded = decodeServerMessage(frame);
			expect(decoded).toEqual({ jsonrpc: "2.0", id: 5, result: { latest_sequence: 12 } });
		});

		it("旧帧兼容：result: null 仍可解码（双路径）", () => {
			const frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 5, result: null }));
			expect(() => decodeServerMessage(frame)).not.toThrow();
		});
	});

	describe("system_message（#123 WL1/WL6，红钉）", () => {
		const WELCOME = DEFAULT_WELCOME_MESSAGE;
		const systemMessage = (params: Record<string, unknown>) => ({
			jsonrpc: "2.0",
			method: "system_message",
			params,
		});

		it("W1 合法 system_message 通知帧解码通过且值可读（WL1 信封一致）", () => {
			const frame = systemMessage({ content: WELCOME });
			expect(decodeServerMessage(Buffer.from(JSON.stringify(frame)))).toEqual(frame);
		});

		it("W2 params 未知字段 fail-close（additionalProperties:false 严格校验）", () => {
			expect(() =>
				decodeServerMessage(Buffer.from(JSON.stringify(systemMessage({ content: WELCOME, extra: 1 })))),
			).toThrow(ProtocolError);
		});

		it("W3 带 id 的 system_message 拒帧（通知不得携带 id，与 A4 同族）", () => {
			expect(() =>
				decodeServerMessage(Buffer.from(JSON.stringify({ ...systemMessage({ content: WELCOME }), id: "req-1" }))),
			).toThrow(ProtocolError);
		});

		it("W4 缺 content 拒帧（params 仅 content 必填）", () => {
			expect(() => decodeServerMessage(Buffer.from(JSON.stringify(systemMessage({}))))).toThrow(ProtocolError);
		});
	});

	describe("whisper 响应三态解码（#152 PR #160 AI 评审阻断 1 修复，QA codec 规格 A，Arch 编写）", () => {
		const ROUND = { round_max_messages: 10, used_messages: 6, remaining_messages: 4 };
		const whisperResponse = (result: Record<string, unknown>) => ({
			jsonrpc: "2.0",
			id: "req-1",
			result,
		});

		it("A1 published 态：{published:true, sequence, round} 逐字段透传", () => {
			const frame = whisperResponse({ published: true, sequence: 5, round: ROUND });
			const decoded = decodeServerMessage(Buffer.from(JSON.stringify(frame)));
			expect(decoded).toEqual(frame);
			if ("result" in decoded && "published" in decoded.result) {
				expect(decoded.result.published).toBe(true);
				expect(decoded.result.sequence).toBe(5);
				expect(decoded.result.round).toEqual(ROUND);
			} else {
				throw new Error("expected published whisper response");
			}
		});

		it("A2 stale 态：{published:false, reason:stale, missing_sequences:{from,to}, round} 透传", () => {
			const frame = whisperResponse({
				published: false,
				reason: "stale",
				missing_sequences: { from: 3, to: 5 },
				round: ROUND,
			});
			const decoded = decodeServerMessage(Buffer.from(JSON.stringify(frame)));
			expect(decoded).toEqual(frame);
		});

		it("A3 round_limit_reached 态：{published:false, reason, hand_raised:true, round} 透传", () => {
			const frame = whisperResponse({
				published: false,
				reason: "round_limit_reached",
				hand_raised: true,
				round: ROUND,
			});
			const decoded = decodeServerMessage(Buffer.from(JSON.stringify(frame)));
			expect(decoded).toEqual(frame);
		});

		it("A4 错误响应（-32110 离线 / -32111 自发自收）走 error 路径可解码", () => {
			const offline = decodeServerMessage(
				Buffer.from(
					JSON.stringify({
						jsonrpc: "2.0",
						id: "req-1",
						error: { code: -32110, message: "Whisper target character is not online" },
					}),
				),
			);
			expect(offline).toEqual({
				jsonrpc: "2.0",
				id: "req-1",
				error: { code: -32110, message: "Whisper target character is not online" },
			});
			const self = decodeServerMessage(
				Buffer.from(
					JSON.stringify({
						jsonrpc: "2.0",
						id: "req-1",
						error: { code: -32111, message: "Cannot whisper to yourself" },
					}),
				),
			);
			expect(self).toEqual({
				jsonrpc: "2.0",
				id: "req-1",
				error: { code: -32111, message: "Cannot whisper to yourself" },
			});
		});

		it("A5 非法 reason 拒帧（三态外形态 fail-close）", () => {
			expect(() =>
				decodeServerMessage(
					Buffer.from(JSON.stringify(whisperResponse({ published: false, reason: "unknown", round: ROUND }))),
				),
			).toThrow(ProtocolError);
		});
	});
});
