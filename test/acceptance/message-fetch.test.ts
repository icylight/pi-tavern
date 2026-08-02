import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PiProcess } from "./pi-process.js";
import { joinCharacterWs } from "./ws-helper.js";

/**
 * M7 (ISSUE-012/#24): push+pull hybrid message fetch.
 *
 * A1: broadcast is a group_chat_update notification (latest_sequence +
 * preview), not a full public_message stream.
 * A3: the incremental pull returns every message after the cursor — no
 * duplicates, strictly increasing, in order.
 * A2: the cursor persists (file on disk); a returning character diff-syncs
 * from its last delivered position.
 * A4: gap detection — a fetch with an older cursor still fills everything
 * after it (sequence filtering heals missed notifications).
 * A6: the injected context and the notification preview come from the same
 * source (sequences match).
 *
 * Each case uses its own isolated environment (two creators in one shared
 * agentDir flaked: overlapping pi processes compete on startup and on the
 * join-time group chat select).
 */
describe("acceptance: push+pull hybrid message fetch (M7 / ISSUE-012)", () => {
	const processes: PiProcess[] = [];

	afterEach(async () => {
		for (const process_ of processes.splice(0)) {
			await process_.kill("SIGTERM");
		}
	});

	async function createEnvironment(): Promise<{
		root: string;
		agentDir: string;
		projectDir: string;
	}> {
		const root = await mkdtemp(join(tmpdir(), "pi-tavern-acc-fetch-"));
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await mkdir(projectDir, { recursive: true });
		await writeFile(
			join(agentDir, "characters", "architect.md"),
			"---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt",
		);
		await writeFile(join(agentDir, "tavern.json"), JSON.stringify({ characters: ["characters/architect.md"] }));
		return { root, agentDir, projectDir };
	}

	it("A1/A3/A4: broadcasts group_chat_update and incremental pull fills the gap without duplicates", async () => {
		const { root, agentDir, projectDir } = await createEnvironment();
		const creator = PiProcess.spawn({
			label: "creator",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator"),
			cwd: projectDir,
		});
		processes.push(creator);
		const descriptor = await creator.startGroupChat(projectDir, agentDir);

		for (let i = 1; i <= 5; i++) {
			await creator.runCommand(`/tavern-test-message message ${i}`);
			await creator.waitFor(
				(e) =>
					e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
			);
		}

		// A member joins before the 6th message so it observes the broadcast.
		const member = await joinCharacterWs(descriptor, "ws-session-fetch", "characters/architect.md");
		await member.waitFor((m) => m.type === "message_history");
		// ISSUE-014/#14 (方案 A): the join itself broadcasts a
		// group_chat_update (latest_sequence 5) — the predicate below skips
		// it by requiring latest_sequence >= 6.

		// 6th message → the broadcast must now be a notification, not a raw
		// public_message stream (A1).
		await creator.runCommand("/tavern-test-message message 6");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);
		const update = await member.waitFor(
			(m) => m.type === "group_chat_update" && (m.latest_sequence as number) >= 6,
			30_000,
		);
		expect(update.latest_sequence).toBe(6);
		expect(Array.isArray(update.preview_messages)).toBe(true);
		expect((update.preview_messages as Record<string, unknown>[]).length).toBeGreaterThan(0);

		// Incremental pull from cursor 2: returns 3..6, strictly increasing,
		// no duplicates (A3/A4 — a missed notification would be healed by the
		// same sequence filtering).
		member.socket.send(JSON.stringify({ id: "pull-1", type: "fetch_messages_since", since_sequence: 2 }));
		const pull = await member.waitFor(
			(m) => m.type === "response" && m.command === "fetch_messages_since" && m.id === "pull-1",
		);
		const pulled = (pull.data as { messages: Array<{ sequence: number }> }).messages;
		expect(pulled.map((m) => m.sequence)).toEqual([3, 4, 5, 6]);
		expect((pull.data as { latest_sequence: number }).latest_sequence).toBe(6);
		expect((pull.data as { total_messages: number }).total_messages).toBe(6);

		member.terminate();
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
	});

	it("A2/A6: cursor persistence and injection are unit-covered (RPC limitation)", async () => {
		// RPC-mode pi quits the session right after the join turn completes,
		// so a real character process cannot observe messages that arrive
		// after join (verified empirically; identity-consistency relies on
		// the join-batch flush for the same reason). A2 (cursor file write /
		// read / restart survival) and A6 (injection == notification source)
		// are therefore covered at the unit layer:
		//
		// - CharacterRuntime cursor round-trip + JoinAttempt cursorStorePath
		//   propagation (test/character/join-attempt.test.ts)
		// - GroupChatInput pullIncrement: immediate pull (A1), gap fill
		//   (A4), single-flight (A7), settle-queueing (A5), injection notify
		//   (A6) — test/character/group-chat-input.test.ts M7 cases
		//
		// The full push+pull loop (notification -> pull -> cursor write ->
		// rejoin diff-sync) runs in the real (non-RPC) pi runtime; the
		// acceptance suite covers the server contract (A1 above) and the
		// smoke that a real character process survives a join.
		expect(true).toBe(true);
	});
});
