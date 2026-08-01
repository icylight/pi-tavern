import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PiProcess } from "./pi-process.js";
import { joinCharacterWs } from "./ws-helper.js";

describe("acceptance: join history snapshot advertises paging beyond 100 messages (ISSUE-008 + User 2026-08-01 10→100)", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	const processes: PiProcess[] = [];

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-tavern-acc-history-"));
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await mkdir(projectDir, { recursive: true });
		await writeFile(
			join(agentDir, "characters", "architect.md"),
			"---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt",
		);
		await writeFile(join(agentDir, "tavern.json"), JSON.stringify({ characters: ["characters/architect.md"] }));
	});

	afterAll(async () => {
		for (const process_ of processes) {
			await process_.kill("SIGTERM");
		}
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
	});

	it("advertises paging on join when history exceeds the 100-message snapshot window", async () => {
		const creator = PiProcess.spawn({
			label: "creator",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator"),
			cwd: projectDir,
		});
		processes.push(creator);
		const descriptor = await creator.startGroupChat(projectDir, agentDir);

		// 102 User Persona messages create history beyond the 100-message
		// join-time snapshot window.
		for (let i = 1; i <= 102; i++) {
			await creator.runCommand(`/tavern-test-message message ${i}`);
			await creator.waitFor(
				(e) =>
					e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
			);
		}

		// A fresh character join sees exactly the 100 newest messages plus the
		// server's paging contract (has_more + cursor + total): the snapshot
		// is what the client must walk to recover older history (ISSUE-008).
		const member = await joinCharacterWs(descriptor, "ws-session-history", "characters/architect.md");
		const history = await member.waitFor((m) => m.type === "message_history");
		const messages = history.messages as Record<string, unknown>[];
		expect(messages).toHaveLength(100);
		expect(history.has_more).toBe(true);
		expect(history.cursor).toBeTruthy();
		expect(history.total_messages).toBe(102);
		// The snapshot is oldest-first within the newest-100 window: the
		// window covers sequences 3..102 (100 of 102 messages).
		expect(messages[0]?.sequence).toBe(3);
		expect(messages[99]?.sequence).toBe(102);

		// End-to-end smoke: the real character process survives the join with
		// the advertised paging contract and the creator sees a healthy set.
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[])?.[0]?.startsWith("2 人在线") === true,
		);
	});
});
