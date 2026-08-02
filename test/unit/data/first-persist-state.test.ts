import { describe, expect, it } from "vitest";

import {
	FIRST_PERSIST_HEADER_WRITTEN,
	FIRST_PERSIST_MESSAGE_APPENDED,
	FIRST_PERSIST_NAME_APPENDED,
	FIRST_PERSIST_SESSION_OPENED,
	FIRST_PERSIST_SETTINGS_APPENDED,
	FirstPersistState,
} from "../../../src/data/first-persist-state.js";

const ALL_STEPS = [
	FIRST_PERSIST_HEADER_WRITTEN,
	FIRST_PERSIST_SESSION_OPENED,
	FIRST_PERSIST_NAME_APPENDED,
	FIRST_PERSIST_SETTINGS_APPENDED,
	FIRST_PERSIST_MESSAGE_APPENDED,
] as const;

describe("FirstPersistState", () => {
	it("starts with no bits set", () => {
		const state = new FirstPersistState();
		for (const step of ALL_STEPS) {
			expect(state.has(step)).toBe(false);
		}
	});

	it("marks steps independently", () => {
		const state = new FirstPersistState();
		state.mark(FIRST_PERSIST_HEADER_WRITTEN);
		expect(state.has(FIRST_PERSIST_HEADER_WRITTEN)).toBe(true);
		expect(state.has(FIRST_PERSIST_SESSION_OPENED)).toBe(false);
		expect(state.has(FIRST_PERSIST_MESSAGE_APPENDED)).toBe(false);
	});

	it("accumulates along the 0 → all-set sequence", () => {
		const state = new FirstPersistState();
		for (const [index, step] of ALL_STEPS.entries()) {
			state.mark(step);
			for (const [otherIndex, other] of ALL_STEPS.entries()) {
				expect(state.has(other)).toBe(otherIndex <= index);
			}
		}
	});

	it("supports marking out of order (marking a later step implies nothing about earlier ones)", () => {
		const state = new FirstPersistState();
		state.mark(FIRST_PERSIST_MESSAGE_APPENDED);
		expect(state.has(FIRST_PERSIST_MESSAGE_APPENDED)).toBe(true);
		expect(state.has(FIRST_PERSIST_HEADER_WRITTEN)).toBe(false);
	});

	it("reset clears all bits", () => {
		const state = new FirstPersistState();
		for (const step of ALL_STEPS) {
			state.mark(step);
		}
		state.reset();
		for (const step of ALL_STEPS) {
			expect(state.has(step)).toBe(false);
		}
	});

	it("repeat mark is idempotent", () => {
		const state = new FirstPersistState();
		state.mark(FIRST_PERSIST_NAME_APPENDED);
		state.mark(FIRST_PERSIST_NAME_APPENDED);
		expect(state.has(FIRST_PERSIST_NAME_APPENDED)).toBe(true);
	});
});
