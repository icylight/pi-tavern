import { describe, expect, it } from "vitest";

import {
	decodeClientMessage,
	decodeServerMessage,
	encodeMessage,
	MAX_WEBSOCKET_FRAME_BYTES,
	ProtocolError,
} from "../../../src/protocol/codec.js";

describe("PiTavern protocol codec", () => {
	it("decodes a strict snake_case client request", () => {
		expect(
			decodeClientMessage(
				Buffer.from(
					JSON.stringify({
						id: "req-1",
						type: "join_group_chat",
						session_id: "session-1",
					}),
				),
			),
		).toEqual({
			id: "req-1",
			type: "join_group_chat",
			session_id: "session-1",
		});
	});

	it("rejects malformed JSON, unknown types, and extra fields", () => {
		expect(() => decodeClientMessage(Buffer.from("{broken"))).toThrow(ProtocolError);
		expect(() => decodeClientMessage(Buffer.from(JSON.stringify({ type: "unknown" })))).toThrow(ProtocolError);
		expect(() =>
			decodeClientMessage(
				Buffer.from(
					JSON.stringify({
						type: "character_ready",
						sessionId: "camel-case-is-invalid",
					}),
				),
			),
		).toThrow(ProtocolError);
	});

	it("decodes server messages and encodes compact JSON", () => {
		const message = {
			id: "req-1",
			type: "response",
			command: "character_ready",
			success: true,
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
					id: "req-8",
					type: "speak",
					content: "I suggest starting with the persistence layer.",
				}),
			),
		);

		expect(message).toEqual({
			id: "req-8",
			type: "speak",
			content: "I suggest starting with the persistence layer.",
		});
	});

	it("decodes a speak response", () => {
		const published = decodeServerMessage(
			Buffer.from(
				JSON.stringify({
					id: "req-8",
					type: "response",
					command: "speak",
					success: true,
					data: {
						published: true,
						event_id: "evt-1",
						sequence: 1,
						// ISSUE-013 B6: success carries latest_sequence so the client
						// can advance its last-seen past its own published message.
						latest_sequence: 1,
						round: { round_max_messages: 10, used_messages: 1, remaining_messages: 9 },
					},
				}),
			),
		);

		expect(published).toEqual({
			id: "req-8",
			type: "response",
			command: "speak",
			success: true,
			data: {
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
					id: "req-9",
					type: "response",
					command: "speak",
					success: true,
					data: {
						published: false,
						reason: "round_limit_reached",
						hand_raised: true,
						round: { round_max_messages: 10, used_messages: 10, remaining_messages: 0 },
					},
				}),
			),
		);

		expect(rejected).toEqual({
			id: "req-9",
			type: "response",
			command: "speak",
			success: true,
			data: {
				published: false,
				reason: "round_limit_reached",
				hand_raised: true,
				round: { round_max_messages: 10, used_messages: 10, remaining_messages: 0 },
			},
		});
	});

	it("decodes get_message_history and get_chat_history_file requests", () => {
		expect(decodeClientMessage(Buffer.from(JSON.stringify({ id: "req-1", type: "get_message_history" })))).toEqual({
			id: "req-1",
			type: "get_message_history",
		});
		expect(
			decodeClientMessage(Buffer.from(JSON.stringify({ id: "req-2", type: "get_message_history", cursor: "opaque" }))),
		).toEqual({ id: "req-2", type: "get_message_history", cursor: "opaque" });
		expect(
			decodeClientMessage(Buffer.from(JSON.stringify({ id: "req-3", type: "get_message_history", cursor: null }))),
		).toEqual({ id: "req-3", type: "get_message_history", cursor: null });
		expect(decodeClientMessage(Buffer.from(JSON.stringify({ id: "req-4", type: "get_chat_history_file" })))).toEqual({
			id: "req-4",
			type: "get_chat_history_file",
		});
	});

	it("decodes a get_message_history response with cursor fields", () => {
		const response = {
			id: "req-1",
			type: "response",
			command: "get_message_history",
			success: true,
			data: {
				messages: [
					{
						type: "public_message",
						event_id: "evt-1",
						sequence: 1,
						timestamp: "2026-07-01T00:00:00.000Z",
						sender: { type: "user_persona" },
						content: "Hello",
						round: { round_max_messages: 10, used_messages: 0, remaining_messages: 10 },
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
			id: "req-1",
			type: "response",
			command: "get_chat_history_file",
			success: true,
			data: { path: "/absolute/path/to/chats/group-1.jsonl" },
		};
		expect(decodeServerMessage(Buffer.from(JSON.stringify(response)))).toEqual(response);
	});
});
