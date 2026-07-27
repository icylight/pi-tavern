import { describe, expect, it } from "vitest";

import {
	decodeClientMessage,
	decodeServerMessage,
	encodeMessage,
	MAX_WEBSOCKET_FRAME_BYTES,
	ProtocolError,
} from "../../src/protocol/codec.js";

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
});
