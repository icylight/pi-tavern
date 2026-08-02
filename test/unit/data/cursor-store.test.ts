import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	countPersistedEntries,
	decodeCursor,
	encodeCursor,
	readCursorFile,
	writeCursorFile,
} from "../../../src/data/cursor-store.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-cursor-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

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
			const encode = (value: unknown): string =>
				Buffer.from(JSON.stringify({ v: 1, seq: value })).toString("base64url");
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

	describe("readCursorFile / writeCursorFile（文件原语：同步、失败如实抛错）", () => {
		it("round-trips a sequence through write and read", async () => {
			const directory = await createTemporaryDirectory();
			const path = join(directory, "cursor.json");
			writeCursorFile(path, 42);
			expect(readCursorFile(path)).toBe(42);
		});

		it("atomically replaces an existing file with no leftover tmp file", async () => {
			const directory = await createTemporaryDirectory();
			const path = join(directory, "cursor.json");
			writeCursorFile(path, 1);
			writeCursorFile(path, 7);
			expect(readCursorFile(path)).toBe(7);
			await expect(import("node:fs/promises").then(({ readFile }) => readFile(`${path}.tmp`))).rejects.toThrow();
		});

		it("creates missing parent directories", async () => {
			const directory = await createTemporaryDirectory();
			const path = join(directory, "deep", "nested", "cursor.json");
			writeCursorFile(path, 3);
			expect(readCursorFile(path)).toBe(3);
		});

		it("returns null for corrupt content (bad JSON / raw bytes / empty file)", async () => {
			const directory = await createTemporaryDirectory();
			const contents = ["not json", "\u0000\u0001\u0002", ""];
			for (const [index, content] of contents.entries()) {
				const path = join(directory, `corrupt-${index}.json`);
				await writeFile(path, content);
				expect(readCursorFile(path)).toBeNull();
			}
		});

		it("returns null when last_sequence shape is invalid (missing / string / negative / non-integer)", async () => {
			const directory = await createTemporaryDirectory();
			const payloads = [{}, { last_sequence: "7" }, { last_sequence: -1 }, { last_sequence: 1.5 }];
			for (const [index, payload] of payloads.entries()) {
				const path = join(directory, `shape-${index}.json`);
				await writeFile(path, JSON.stringify(payload));
				expect(readCursorFile(path)).toBeNull();
			}
		});

		it("serializes rapid writes with the last write winning (sync semantics)", async () => {
			const directory = await createTemporaryDirectory();
			const path = join(directory, "cursor.json");
			writeCursorFile(path, 1);
			writeCursorFile(path, 2);
			writeCursorFile(path, 3);
			expect(readCursorFile(path)).toBe(3);
		});

		it("throws on read IO failure (EISDIR) instead of swallowing", async () => {
			const directory = await createTemporaryDirectory();
			const asDirectory = join(directory, "as-dir");
			await mkdir(asDirectory);
			expect(() => readCursorFile(asDirectory)).toThrow();
		});

		it("throws on write IO failure (ENOTDIR parent / rename onto directory) instead of swallowing", async () => {
			const directory = await createTemporaryDirectory();
			const fileAsParent = join(directory, "not-a-dir");
			await writeFile(fileAsParent, "x");
			expect(() => writeCursorFile(join(fileAsParent, "cursor.json"), 5)).toThrow();
			const asDirectory = join(directory, "as-dir");
			await mkdir(asDirectory);
			expect(() => writeCursorFile(asDirectory, 5)).toThrow();
		});
	});

});
