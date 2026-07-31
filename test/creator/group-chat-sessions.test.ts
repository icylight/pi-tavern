import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteGroupChatSession, listGroupChatSessions } from "../../src/creator/group-chat-sessions.js";
import { getActiveDescriptorPath, getGroupChatSessionDirectory } from "../../src/discovery/active-descriptor.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-sessions-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("group chat sessions", () => {
	it("lists persisted group chats and marks active ones", async () => {
		const root = await createTemporaryDirectory();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const sessionDir = getGroupChatSessionDirectory(agentDir, cwd);
		await mkdir(sessionDir, { recursive: true });
		await writeFile(
			join(sessionDir, "2026-07-01T00:00:00.000Z_group-1.jsonl"),
			[
				JSON.stringify({ type: "session", id: "group-1", timestamp: "2026-07-01T00:00:00.000Z", version: 1, cwd }),
				JSON.stringify({
					type: "custom_message",
					id: "evt-1",
					parentId: null,
					timestamp: "2026-07-01T00:00:01.000Z",
					customType: "pi-tavern.public-message",
					content: "User Persona:\nFirst public message",
					display: true,
					details: {
						sequence: 1,
						sender: { type: "user_persona" },
						content: "First public message",
						round: { round_max_messages: 10, used_messages: 0, remaining_messages: 10 },
					},
				}),
			].join("\n"),
		);
		await writeFile(
			join(sessionDir, "2026-07-02T00:00:00.000Z_group-2.jsonl"),
			`${JSON.stringify({ type: "session", id: "group-2", timestamp: "2026-07-02T00:00:00.000Z", version: 1, cwd })}\n`,
		);

		// group-2 has an active descriptor
		const activePath = getActiveDescriptorPath(agentDir, cwd, "group-2");
		await mkdir(dirname(activePath), { recursive: true });
		await writeFile(
			activePath,
			JSON.stringify({
				instanceId: "instance-2",
				groupChatId: "group-2",
				name: null,
				cwd,
				pid: 1234,
				host: "127.0.0.1",
				port: 54321,
				startedAt: "2026-07-02T00:00:00.000Z",
			}),
		);

		const sessions = await listGroupChatSessions(agentDir, cwd, {
			trash: () => ({ status: 0 }),
			exists: () => false,
			unlink: async () => undefined,
			readActiveDescriptor: async (path) =>
				path === activePath
					? {
							instanceId: "instance-2",
							groupChatId: "group-2",
							name: null,
							cwd,
							pid: 1234,
							host: "127.0.0.1",
							port: 54321,
							startedAt: "2026-07-02T00:00:00.000Z",
						}
					: null,
		});

		const byId = new Map(sessions.map((session) => [session.groupChatId, session]));
		expect(byId.get("group-1")?.active).toBe(false);
		expect(byId.get("group-2")?.active).toBe(true);
		expect(byId.get("group-1")?.path.endsWith("group-1.jsonl")).toBe(true);
		// firstMessage is scanned from the file, not pi's message-only firstMessage
		expect(byId.get("group-1")?.firstMessage).toBe("User Persona:\nFirst public message");
	});

	it("deletes through trash when available", async () => {
		const trash = vi.fn(() => ({ status: 0 }));
		const unlink = vi.fn(async () => undefined);

		const result = await deleteGroupChatSession("/chats/old.jsonl", {
			trash,
			exists: () => false,
			unlink,
		});

		expect(result).toEqual({ ok: true, method: "trash" });
		expect(trash).toHaveBeenCalledWith("/chats/old.jsonl");
		expect(unlink).not.toHaveBeenCalled();
	});

	it("falls back to unlink when trash is unavailable", async () => {
		const unlink = vi.fn(async () => undefined);

		const result = await deleteGroupChatSession("/chats/old.jsonl", {
			trash: () => ({ status: 1, stderr: "trash: command not found" }),
			exists: () => true,
			unlink,
		});

		expect(result).toEqual({ ok: true, method: "unlink" });
		expect(unlink).toHaveBeenCalledWith("/chats/old.jsonl");
	});

	it("reports failure when both trash and unlink fail", async () => {
		const result = await deleteGroupChatSession("/chats/old.jsonl", {
			trash: () => ({ status: 1, error: new Error("spawn trash ENOENT") }),
			exists: () => true,
			unlink: async () => {
				throw new Error("permission denied");
			},
		});

		expect(result.ok).toBe(false);
		expect(result.method).toBe("unlink");
		expect(result.error).toContain("permission denied");
		expect(result.error).toContain("spawn trash ENOENT");
	});

	it("treats a vanished file as deleted even when trash reports failure", async () => {
		const result = await deleteGroupChatSession("/chats/old.jsonl", {
			trash: () => ({ status: 1 }),
			exists: () => false,
			unlink: async () => undefined,
		});

		expect(result).toEqual({ ok: true, method: "trash" });
	});

	it("deletes real files with unlink through the default dependencies", async () => {
		const root = await createTemporaryDirectory();
		const path = join(root, "old.jsonl");
		await writeFile(path, "{}");

		const result = await deleteGroupChatSession(path);

		expect(result.ok).toBe(true);
		expect(result.method).toBe("unlink");
		expect(await readdir(root)).toEqual([]);
	});
});
