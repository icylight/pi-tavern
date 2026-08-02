import { describe, expect, it } from "vitest";

import { countPersistedEntries, decodeCursor, encodeCursor } from "../../../src/data/cursor-store.js";

describe("cursor-store", () => {
	describe("encodeCursor / decodeCursor", () => {
		it("round-trips valid sequences", () => {
			for (const sequence of [1, 2, 100, Number.MAX_SAFE_INTEGER]) {
				expect(decodeCursor(encodeCursor(sequence))).toBe(sequence);
			}
		});

		it("pins current behavior: negative safe integers round-trip (isSafeInteger only)", () => {
			expect(decodeCursor(encodeCursor(-5))).toBe(-5);
		});

		it("rejects malformed base64url", () => {
			expect(decodeCursor("not-base64url!!")).toBeNull();
			expect(decodeCursor("")).toBeNull();
			expect(decodeCursor("***")).toBeNull();
		});

		it("rejects wrong version", () => {
			const cursor = Buffer.from(JSON.stringify({ v: 2, seq: 5 })).toString("base64url");
			expect(decodeCursor(cursor)).toBeNull();
		});

		it("rejects missing / non-safe-integer seq", () => {
			const encode = (value: unknown): string => Buffer.from(JSON.stringify({ v: 1, seq: value })).toString("base64url");
			expect(decodeCursor(encode(undefined))).toBeNull();
			expect(decodeCursor(encode(1.5))).toBeNull();
			expect(decodeCursor(encode(Number.MAX_SAFE_INTEGER + 1))).toBeNull();
			expect(decodeCursor(encode("5"))).toBeNull();
			expect(decodeCursor(encode(null))).toBeNull();
		});

		it("rejects non-object payloads", () => {
			const cursor = Buffer.from(JSON.stringify([1, 2, 3])).toString("base64url");
			expect(decodeCursor(cursor)).toBeNull();
		});
	});

	describe("countPersistedEntries", () => {
		it("counts the three PiTavern-owned entry types", () => {
			const entries = [
				{ type: "session_info" },
				{ type: "custom", customType: "pi-tavern.group-settings" },
				{ type: "custom_message", customType: "pi-tavern.public-message" },
				{ type: "message" },
				{ type: "custom", customType: "some-other.custom-type" },
			];
			expect(countPersistedEntries(entries)).toBe(3);
		});

		it("returns 0 for empty or foreign-only entry lists", () => {
			expect(countPersistedEntries([])).toBe(0);
			expect(countPersistedEntries([{ type: "message" }])).toBe(0);
			expect(countPersistedEntries([{ type: "label" }])).toBe(0);
		});
	});
});
