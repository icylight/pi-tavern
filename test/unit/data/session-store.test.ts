import { describe, expect, it, vi } from "vitest";

import {
	type SessionEntryLike,
	type SessionHeaderLike,
	type SessionManagerFactory,
	type SessionManagerLike,
	SessionStore,
	formatEntryContent,
} from "../../../src/data/session-store.js";

const HEADER: SessionHeaderLike = {
	id: "group-chat-1",
	timestamp: "2026-08-02T00:00:00.000Z",
};

class FakeSessionManager implements SessionManagerLike {
	calls: string[] = [];
	file: string | null = null;
	entries: SessionEntryLike[] = [];
	failSetSessionFile = false;
	failAppendSessionInfo = false;
	failAppendCustomEntry = false;
	failAppendCustomMessageEntry = false;

	constructor(
		readonly cwd = "/cwd",
		readonly sessionDir = "/sessions",
	) {}

	setSessionFile(sessionFile: string): void {
		this.calls.push("setSessionFile");
		if (this.failSetSessionFile) throw new Error("setSessionFile failed");
		this.file = sessionFile;
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	getSessionFile(): string | undefined {
		return this.file ?? undefined;
	}

	getHeader(): SessionHeaderLike | null {
		return HEADER;
	}

	getEntries(): SessionEntryLike[] {
		return this.entries;
	}

	getEntry(id: string): SessionEntryLike | undefined {
		return this.entries.find((entry) => entry.id === id);
	}

	appendSessionInfo(name: string): string {
		this.calls.push(`appendSessionInfo:${name}`);
		if (this.failAppendSessionInfo) throw new Error("appendSessionInfo failed");
		return "session-info-1";
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		this.calls.push(`appendCustomEntry:${customType}`);
		if (this.failAppendCustomEntry) throw new Error("appendCustomEntry failed");
		return "custom-entry-1";
	}

	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | unknown[],
		display: boolean,
		details?: T,
	): string {
		this.calls.push(`appendCustomMessageEntry:${customType}`);
		if (this.failAppendCustomMessageEntry) throw new Error("appendCustomMessageEntry failed");
		return "message-entry-1";
	}
}

class FakeFactory implements SessionManagerFactory {
	created: FakeSessionManager[] = [];
	opened: FakeSessionManager[] = [];

	create(cwd: string, sessionDir: string, options: { id: string }): SessionManagerLike {
		const manager = new FakeSessionManager(cwd, sessionDir);
		manager.calls.push(`create:${options.id}`);
		this.created.push(manager);
		return manager;
	}

	open(path: string, sessionDir: string, cwdOverride: string): SessionManagerLike {
		const manager = new FakeSessionManager(cwdOverride, sessionDir);
		manager.calls.push(`open:${path}`);
		this.opened.push(manager);
		return manager;
	}
}

function createDeps() {
	return {
		writeFile: vi.fn<(path: string, data: string) => Promise<void>>().mockResolvedValue(undefined),
		rm: vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined),
	};
}

const BASE_INPUT = {
	sessionPath: "/agent/session.jsonl",
	header: HEADER,
	groupChatId: "group-chat-1",
	name: "My Group Chat" as string | null,
	groupMaxMessages: 100,
	sequence: 1,
	content: "Hello world",
};

function input(overrides: Partial<typeof BASE_INPUT> = {}) {
	return { ...BASE_INPUT, ...overrides };
}

describe("SessionStore", () => {
	describe("lifecycle factories", () => {
		it("create builds a store around a factory-created manager", () => {
			const factory = new FakeFactory();
			const store = SessionStore.create(factory, "/cwd", "/sessions", { id: "gc-1" }, createDeps());
			expect(factory.created).toHaveLength(1);
			expect(factory.created[0]?.calls).toEqual(["create:gc-1"]);
			expect(store.getSessionManager()).toBe(factory.created[0]);
		});

		it("open builds a store around a factory-opened manager", () => {
			const factory = new FakeFactory();
			const store = SessionStore.open(factory, "/path/session.jsonl", "/sessions", "/cwd", createDeps());
			expect(factory.opened).toHaveLength(1);
			expect(factory.opened[0]?.calls).toEqual(["open:/path/session.jsonl"]);
			expect(store.getSessionManager()).toBe(factory.opened[0]);
		});
	});

	describe("getSessionFilePath", () => {
		it("throws before the session file is set", () => {
			const store = new SessionStore(new FakeSessionManager(), new FakeFactory(), createDeps());
			expect(() => store.getSessionFilePath()).toThrow("Session file not set");
		});

		it("returns the file after setSessionFile", () => {
			const manager = new FakeSessionManager();
			const store = new SessionStore(manager, new FakeFactory(), createDeps());
			manager.setSessionFile("/agent/session.jsonl");
			expect(store.getSessionFilePath()).toBe("/agent/session.jsonl");
		});
	});

	describe("persistFirstMessage", () => {
		it("writes header, sets session file, appends name + settings + message in order", async () => {
			const manager = new FakeSessionManager();
			const deps = createDeps();
			const store = new SessionStore(manager, new FakeFactory(), deps);

			const result = await store.persistFirstMessage(input());

			expect(deps.writeFile).toHaveBeenCalledWith("/agent/session.jsonl", `${JSON.stringify(HEADER)}\n`);
			expect(manager.calls).toEqual([
				"setSessionFile",
				"appendSessionInfo:My Group Chat",
				"appendCustomEntry:pi-tavern.group-settings",
				"appendCustomMessageEntry:pi-tavern.public-message",
			]);
			expect(result.entryId).toBe("message-entry-1");
			expect(result.entriesPersisted).toBe(3);
		});

		it("skips session_info append when the group chat has no name", async () => {
			const manager = new FakeSessionManager();
			const deps = createDeps();
			const store = new SessionStore(manager, new FakeFactory(), deps);

			const result = await store.persistFirstMessage(input({ name: null }));

			expect(manager.calls).toEqual([
				"setSessionFile",
				"appendCustomEntry:pi-tavern.group-settings",
				"appendCustomMessageEntry:pi-tavern.public-message",
			]);
			expect(result.entriesPersisted).toBe(2);
		});

		it("rolls back (rm + no recreate) when writeFile fails at the header step", async () => {
			const manager = new FakeSessionManager();
			const deps = createDeps();
			deps.writeFile.mockRejectedValue(new Error("disk full"));
			const factory = new FakeFactory();
			const store = new SessionStore(manager, factory, deps);

			await expect(store.persistFirstMessage(input())).rejects.toThrow("disk full");

			expect(deps.rm).toHaveBeenCalledWith("/agent/session.jsonl");
			expect(factory.created).toHaveLength(0);
		});

		it("rolls back (rm + recreate) when setSessionFile fails", async () => {
			const manager = new FakeSessionManager();
			manager.failSetSessionFile = true;
			const deps = createDeps();
			const factory = new FakeFactory();
			const store = new SessionStore(manager, factory, deps);

			await expect(store.persistFirstMessage(input())).rejects.toThrow("setSessionFile failed");

			expect(deps.rm).toHaveBeenCalledWith("/agent/session.jsonl");
			expect(factory.created).toHaveLength(1);
			expect(factory.created[0]?.calls).toEqual(["create:group-chat-1"]);
		});

		it("rolls back (rm + recreate) when appendSessionInfo fails", async () => {
			const manager = new FakeSessionManager();
			manager.failAppendSessionInfo = true;
			const deps = createDeps();
			const factory = new FakeFactory();
			const store = new SessionStore(manager, factory, deps);

			await expect(store.persistFirstMessage(input())).rejects.toThrow("appendSessionInfo failed");

			expect(deps.rm).toHaveBeenCalledWith("/agent/session.jsonl");
			expect(factory.created).toHaveLength(1);
		});

		it("rolls back (rm + recreate) when appendCustomEntry fails", async () => {
			const manager = new FakeSessionManager();
			manager.failAppendCustomEntry = true;
			const deps = createDeps();
			const factory = new FakeFactory();
			const store = new SessionStore(manager, factory, deps);

			await expect(store.persistFirstMessage(input())).rejects.toThrow("appendCustomEntry failed");

			expect(deps.rm).toHaveBeenCalledWith("/agent/session.jsonl");
			expect(factory.created).toHaveLength(1);
		});

		it("rolls back (rm + recreate) when the message append fails — the last step", async () => {
			const manager = new FakeSessionManager();
			manager.failAppendCustomMessageEntry = true;
			const deps = createDeps();
			const factory = new FakeFactory();
			const store = new SessionStore(manager, factory, deps);

			await expect(store.persistFirstMessage(input())).rejects.toThrow("appendCustomMessageEntry failed");

			expect(deps.rm).toHaveBeenCalledWith("/agent/session.jsonl");
			expect(factory.created).toHaveLength(1);
		});

		it("wraps rollback failures and marks persistence fatal", async () => {
			const manager = new FakeSessionManager();
			const deps = createDeps();
			deps.writeFile.mockRejectedValue(new Error("disk full"));
			deps.rm.mockRejectedValue(new Error("rm failed"));
			const store = new SessionStore(manager, new FakeFactory(), deps);

			await expect(store.persistFirstMessage(input())).rejects.toThrow(
				"Rollback failed: Failed to delete half-initialized session file during rollback",
			);
			expect(() => store.assertWritable()).toThrow("persistence is broken");
		});

		it("does not recreate when only the header step failed", async () => {
			const manager = new FakeSessionManager();
			const deps = createDeps();
			deps.writeFile.mockRejectedValue(new Error("disk full"));
			const factory = new FakeFactory();
			const store = new SessionStore(manager, factory, deps);

			await expect(store.persistFirstMessage(input())).rejects.toThrow("disk full");
			expect(factory.created).toHaveLength(0);
		});
	});

	describe("append wrappers + recovery", () => {
		it("appends pass through to the underlying manager", () => {
			const manager = new FakeSessionManager();
			const store = new SessionStore(manager, new FakeFactory(), createDeps());
			store.appendSessionInfo("name");
			store.appendCustomEntry("pi-tavern.group-settings", { group_max_messages: 10 });
			const entryId = store.appendCustomMessageEntry("pi-tavern.public-message", "label:\nbody\n", true, { seq: 1 });
			expect(manager.calls).toEqual([
				"appendSessionInfo:name",
				"appendCustomEntry:pi-tavern.group-settings",
				"appendCustomMessageEntry:pi-tavern.public-message",
			]);
			expect(entryId).toBe("message-entry-1");
		});

		it("recoverFromFailedAppend reloads via setSessionFile and rethrows the original error", () => {
			const manager = new FakeSessionManager();
			manager.setSessionFile("/agent/session.jsonl");
			const store = new SessionStore(manager, new FakeFactory(), createDeps());
			const original = new Error("disk full");

			expect(() => store.recoverFromFailedAppend(original)).toThrow("disk full");
			expect(manager.calls).toContain("setSessionFile");
			// 恢复成功：未置致命位。
			expect(() => store.assertWritable()).not.toThrow();
		});

		it("recoverFromFailedAppend marks persistence fatal when reload itself fails", () => {
			const manager = new FakeSessionManager();
			manager.file = "/agent/session.jsonl";
			manager.failSetSessionFile = true;
			const store = new SessionStore(manager, new FakeFactory(), createDeps());
			const original = new Error("disk full");

			expect(() => store.recoverFromFailedAppend(original)).toThrow("Persistence recovery failed: setSessionFile failed");
			expect(() => store.assertWritable()).toThrow("persistence is broken");
		});

		it("recoverFromFailedAppendAndCatch returns the original error without throwing", () => {
			const manager = new FakeSessionManager();
			manager.setSessionFile("/agent/session.jsonl");
			const store = new SessionStore(manager, new FakeFactory(), createDeps());
			const original = new Error("disk full");

			const report = store.recoverFromFailedAppendAndCatch(original);
			expect(report).toBe(original);
			expect(() => store.assertWritable()).not.toThrow();
		});

		it("recoverFromFailedAppendAndCatch returns a wrapped error and marks fatal when reload fails", () => {
			const manager = new FakeSessionManager();
			manager.file = "/agent/session.jsonl";
			manager.failSetSessionFile = true;
			const store = new SessionStore(manager, new FakeFactory(), createDeps());

			const report = store.recoverFromFailedAppendAndCatch(new Error("disk full"));
			expect(report.message).toContain("Persistence recovery failed");
			expect(() => store.assertWritable()).toThrow("persistence is broken");
		});

		it("getSessionManager returns the recreated manager after rollback", async () => {
			const manager = new FakeSessionManager();
			manager.failAppendCustomEntry = true;
			const deps = createDeps();
			const factory = new FakeFactory();
			const store = new SessionStore(manager, factory, deps);

			await expect(store.persistFirstMessage(input())).rejects.toThrow("appendCustomEntry failed");
			expect(store.getSessionManager()).toBe(factory.created[0]);
			expect(store.getSessionManager()).not.toBe(manager);
		});
	});

	describe("formatEntryContent", () => {
		it("formats sender label + trimmed body", () => {
			expect(formatEntryContent("User Persona", "hello")).toBe("User Persona:\nhello\n");
			expect(formatEntryContent("Dev", "line1\nline2\n\n")).toBe("Dev:\nline1\nline2\n");
		});
	});
});
