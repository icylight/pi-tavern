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

	describe("历史/增量容器接受 whisper 帧（#152 PR #161 评审阻断 1，Arch 编写 codec 契约钉测）", () => {
		const SENDER = { type: "character", character_id: "alice", name: "Alice" };
		const RECIPIENT = { type: "character", character_id: "carol", name: "Carol" };
		const ROUND = { round_max_messages: 10, used_messages: 6, remaining_messages: 4 };
		const whisperMessage = {
			jsonrpc: "2.0",
			method: "whisper_message",
			params: {
				event_id: "evt-5",
				sequence: 5,
				timestamp: "2026-08-09T00:00:05.000Z",
				sender: SENDER,
				recipient: RECIPIENT,
				content: "悄悄话R1",
				round: ROUND,
			},
		};
		const whisperPlaceholder = {
			jsonrpc: "2.0",
			method: "whisper_placeholder",
			params: {
				event_id: "evt-5",
				sequence: 5,
				timestamp: "2026-08-09T00:00:05.000Z",
				sender: SENDER,
				recipient: RECIPIENT,
			},
		};

		it("C1 message_history 通知 messages 含 whisper_message 完整帧解码通过", () => {
			const frame = {
				jsonrpc: "2.0",
				method: "message_history",
				params: { messages: [whisperMessage], cursor: null, has_more: false, total_messages: 1 },
			};
			expect(decodeServerMessage(Buffer.from(JSON.stringify(frame)))).toEqual(frame);
		});

		it("C2 get_message_history 响应 messages 含 whisper_placeholder 解码通过", () => {
			const frame = {
				jsonrpc: "2.0",
				id: "req-1",
				result: { messages: [whisperPlaceholder], cursor: null, has_more: false, total_messages: 1 },
			};
			expect(decodeServerMessage(Buffer.from(JSON.stringify(frame)))).toEqual(frame);
		});

		it("C3 fetch_messages_since 响应 messages 含 full+placeholder 混合解码通过", () => {
			const frame = {
				jsonrpc: "2.0",
				id: "req-1",
				result: { messages: [whisperMessage, whisperPlaceholder], latest_sequence: 5, total_messages: 2 },
			};
			expect(decodeServerMessage(Buffer.from(JSON.stringify(frame)))).toEqual(frame);
		});

		it("C5 preview_messages 含 whisper_message 完整帧必拒（单变量负钉：params 完整合法基准，仅换 public→full——拒绝原因唯一）", () => {
			expect(() =>
				decodeServerMessage(
					Buffer.from(
						JSON.stringify({
							jsonrpc: "2.0",
							method: "group_chat_update",
							params: { latest_sequence: 5, preview_messages: [whisperMessage], total_messages: 5 },
						}),
					),
				),
			).toThrow(ProtocolError);
		});

		it("C6 preview_messages 含 whisper_placeholder 必拒（单变量负钉——占位不得纳入公共更新唤醒面，WH6 防御）", () => {
			expect(() =>
				decodeServerMessage(
					Buffer.from(
						JSON.stringify({
							jsonrpc: "2.0",
							method: "group_chat_update",
							params: { latest_sequence: 5, preview_messages: [whisperPlaceholder], total_messages: 5 },
						}),
					),
				),
			).toThrow(ProtocolError);
		});

		it("C7 preview_messages 含 public_message 解码通过（正向对照——负钉只改变一个变量）", () => {
			const frame = {
				jsonrpc: "2.0",
				method: "group_chat_update",
				params: {
					latest_sequence: 5,
					preview_messages: [
						{
							jsonrpc: "2.0",
							method: "public_message",
							params: {
								event_id: "evt-4",
								sequence: 4,
								timestamp: "2026-08-09T00:00:04.000Z",
								sender: { type: "user_persona" },
								content: "R4",
								round: ROUND,
							},
						},
					],
					total_messages: 5,
				},
			};
			expect(decodeServerMessage(Buffer.from(JSON.stringify(frame)))).toEqual(frame);
		});
		it("C4 placeholder 带 content 必拒（任意容器内 fail-close——无 content 字段是契约）", () => {
			const leaked = {
				...whisperPlaceholder,
				params: { ...whisperPlaceholder.params, content: "secret leaked" },
			};
			expect(() =>
				decodeServerMessage(
					Buffer.from(
						JSON.stringify({
							jsonrpc: "2.0",
							method: "message_history",
							params: { messages: [leaked], cursor: null, has_more: false, total_messages: 1 },
						}),
					),
				),
			).toThrow(ProtocolError);
		});
	});
});
