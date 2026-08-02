import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getGroupChatCursorDirectory } from "../../src/data/discovery/active-descriptor.js";
import { PiProcess } from "./pi-process.js";

/**
 * ISSUE-014 acceptance: headless RPC character mode (CPU 根治).
 *
 * A character pi started with PITAVERN_AUTO_JOIN=1 joins the active group
 * chat programmatically (no dialogs, no TUI). The acceptance asserts the
 * full chain: auto-join lands on the creator's online list, group-chat
 * input reaches the headless session (cursor file advances — RPC has no
 * session_start so the PITAVERTEST notify channel is unavailable), and the
 * process idles with negligible CPU (RPC mode has no TUI render pipeline).
 */
describe("acceptance: headless RPC character auto-join (ISSUE-014)", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	const processes: PiProcess[] = [];

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-tavern-acc-headless-"));
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

	it("auto-joins on startup, appears online, receives input, idles at ~0% CPU", async () => {
		const creator = PiProcess.spawn({
			label: "creator",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator"),
			cwd: projectDir,
		});
		processes.push(creator);
		const descriptor = await creator.startGroupChat(projectDir, agentDir);

		// One User Persona message creates the round.
		await creator.runCommand("/tavern-test-message hello");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);

		// ── Headless character: RPC mode + auto-join env ───────────────────
		const headless = PiProcess.spawn({
			label: "hl",
			agentDir,
			sessionDir: join(agentDir, "sessions", "h"),
			cwd: projectDir,
			env: {
				PITAVERN_AUTO_JOIN: "1",
				PITAVERN_CHARACTER: "architect",
				PITAVERN_GROUP_CHAT: descriptor.groupChatId,
			},
		});
		processes.push(headless);

		// The headless process reports the programmatic join on stderr
		// (headless notify goes to stderr to keep the RPC JSONL stream clean).
		// Join completes lazily: process boot + 3s scheduled delay + claim.
		const joinStarted = Date.now();
		await headless.waitForStderr("Auto-joined", 60_000);
		console.log(`[headless] auto-join completed in ${Date.now() - joinStarted}ms`);

		// The creator sees the headless character online (2 people).
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[])?.[0]?.startsWith("2 人在线") === true,
		);

		// ── Group-chat input reaches the headless session ─────────────────
		// The delivery pipeline advances the persisted cursor file on a
		// successful increment (RPC has no session_start, so the PITAVERTEST
		// [tavern-inject] notify is not wired; the cursor file is the
		// deterministic proof the message was pulled and delivered).
		const cursorPath = join(getGroupChatCursorDirectory(agentDir, projectDir), `${descriptor.groupChatId}.json`);
		await creator.runCommand("/tavern-test-message second message");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);
		const deadline = Date.now() + 30_000;
		let lastSequence = 0;
		for (;;) {
			try {
				const raw = await readFile(cursorPath, "utf8");
				lastSequence = (JSON.parse(raw) as { last_sequence: number }).last_sequence;
				if (lastSequence >= 2) {
					break;
				}
			} catch {
				// Cursor file not written yet.
			}
			if (Date.now() > deadline) {
				throw new Error(`cursor file did not reach seq 2 (last: ${lastSequence})`);
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 200));
		}

		// ── ISSUE-014 core: idle CPU is negligible (no TUI pipeline) ──────
		const cpu = await headless.sampleCpuPercent(3_000);
		expect(cpu).toBeLessThanOrEqual(2);
	});
});
