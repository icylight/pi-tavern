import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type WebSocket from "ws";

import { PiProcess } from "./pi-process.js";
import { joinCharacterWs } from "./ws-helper.js";

/** Connect a raw WebSocket client and complete the join flow. */

describe("acceptance: concurrent speaks keep creator order and global quota", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	const processes: PiProcess[] = [];
	const sockets: WebSocket[] = [];

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-tavern-acc-quota-"));
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await mkdir(projectDir, { recursive: true });
		await writeFile(
			join(agentDir, "characters", "architect.md"),
			"---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt",
		);
		await writeFile(
			join(agentDir, "characters", "reviewer.md"),
			"---\nname: Reviewer\ndescription: Reviews designs\n---\nReviewer prompt",
		);
		await writeFile(
			join(agentDir, "tavern.json"),
			JSON.stringify({
				config_max_messages: 3,
				characters: ["characters/architect.md", "characters/reviewer.md"],
			}),
		);
	});

	afterAll(async () => {
		for (const socket of sockets) {
			socket.terminate();
		}
		for (const process_ of processes) {
			await process_.kill("SIGTERM");
		}
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
	});

	it("broadcasts concurrent speaks in creator order and enforces the round quota", async () => {
		// ── Creator (real pi) ──────────────────────────────────────────────
		const creator = PiProcess.spawn({
			label: "creator",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator"),
			cwd: projectDir,
		});
		processes.push(creator);
		const descriptor = await creator.startGroupChat(projectDir, agentDir);

		// A User Persona message creates the round (RPC has no input channel;
		// the test-only command stands in for the creator's text input).
		await creator.runCommand("/tavern-test-message Hello from the creator");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);

		// ── Two raw clients join as characters ─────────────────────────────
		const memberA = await joinCharacterWs(descriptor, "ws-session-a", "characters/architect.md");
		sockets.push(memberA.socket);
		const memberB = await joinCharacterWs(descriptor, "ws-session-b", "characters/reviewer.md");
		sockets.push(memberB.socket);
		// Both saw their join-time history (the frame can be in flight right
		// after character_ready, so wait for it).
		await memberA.waitFor((m) => m.type === "message_history");
		await memberB.waitFor((m) => m.type === "message_history");
		expect(
			memberA
				.allFrames()
				.filter((m) => m.type === "message_history")
				.some((m) => (m.messages as unknown[]).length === 1),
		).toBe(true);

		// ── Concurrent speaks (interleaved senders) ────────────────────────
		// M7 (ISSUE-012): speaks are announced via group_chat_update
		// notifications (WeChat-style); content/sender is pulled on demand.
		const collectA = memberA.collect((m) => m.type === "group_chat_update", 3);
		const collectB = memberB.collect((m) => m.type === "group_chat_update", 3);
		// Two from A, one from B — sent in a burst so arrival order is not
		// guaranteed by the clients; the creator serializes them.
		memberA.send({ id: "s1", type: "speak", content: "one" });
		memberB.send({ id: "s2", type: "speak", content: "two" });
		memberA.send({ id: "s3", type: "speak", content: "three" });

		const [seenByA, seenByB] = await Promise.all([collectA, collectB]);

		// Every receiver observes the same strictly increasing notification
		// sequence set: creator order is authoritative and identical for all
		// members (the notification carries the latest published sequence).
		const sequencesA = seenByA.map((m) => m.latest_sequence as number);
		const sequencesB = seenByB.map((m) => m.latest_sequence as number);
		expect(sequencesA).toEqual([2, 3, 4]);
		expect(sequencesB).toEqual([2, 3, 4]);

		// The final notification's preview carries the 3 published messages
		// (sequence 2..4, oldest-first); cross identity check: each preview
		// message's sender name must be the persona its connection claimed.
		// The sender-to-sequence mapping is nondeterministic (interleaved
		// sends), so assert the multiset, not per-sequence names (ISSUE-003:
		// protocol-level attribution follows the claimed character).
		const lastNotification = seenByA[2];
		expect(lastNotification).toBeDefined();
		if (!lastNotification) {
			throw new Error("expected 3 notifications");
		}
		const preview = lastNotification.preview_messages as Record<string, unknown>[];
		expect(preview.map((m) => m.sequence)).toEqual([2, 3, 4]);
		const senderNames = preview.map((m) => (m.sender as Record<string, unknown>).name).sort();
		expect(senderNames).toEqual(["Architect", "Architect", "Reviewer"]);

		// The pull path returns the same content, same order (same source).
		memberA.send({ id: "f1", type: "fetch_messages_since", since_sequence: 1 });
		const pulled = await memberA.waitFor(
			(m) => m.type === "response" && m.command === "fetch_messages_since" && m.id === "f1",
		);
		const pulledMessages = (pulled.data as Record<string, unknown>).messages as Record<string, unknown>[];
		expect(pulledMessages.map((m) => m.sequence)).toEqual([2, 3, 4]);
		expect((pulled.data as Record<string, unknown>).latest_sequence).toBe(4);
		expect(pulledMessages.map((m) => (m.sender as Record<string, unknown>).name).sort()).toEqual([
			"Architect",
			"Architect",
			"Reviewer",
		]);

		// ── Quota: the round allows 3 speaks; the 4th is not published ─────
		const baseline = memberA.allFrames().length;
		memberA.send({ id: "s4", type: "speak", content: "four" });
		// ISSUE-010: match the response by its request id — the creator replies
		// after broadcasting, so under parallel load earlier speak responses may
		// arrive after `baseline`; matching any speak response could pick s1's
		// (published: true) and flake. The response echoes the request id.
		const fourth = await memberA.waitFor(
			(m) => m.type === "response" && m.command === "speak" && m.id === "s4",
			30_000,
			baseline,
		);
		expect(fourth.success).toBe(true);
		expect((fourth.data as Record<string, unknown>).published).toBe(false);
		expect((fourth.data as Record<string, unknown>).hand_raised).toBe(true);

		// No 4th notification is broadcast (give any wrong broadcast a chance).
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 800));

		// Negative assertions from the receivers' perspective: a buggy
		// implementation that broadcast/persisted the 4th speak would still
		// satisfy toContain('"sequence":4') (the 3rd published speak already
		// holds sequence 4), so the absence must be asserted explicitly.
		const updatesA = memberA
			.allFrames()
			.filter((m) => m.type === "group_chat_update")
			.map((m) => m.latest_sequence as number);
		const updatesB = memberB
			.allFrames()
			.filter((m) => m.type === "group_chat_update")
			.map((m) => m.latest_sequence as number);
		expect(updatesA).toEqual([2, 3, 4]);
		expect(updatesB).toEqual([2, 3, 4]);
		// And the pull path confirms only 3 published messages.
		memberA.send({ id: "f2", type: "fetch_messages_since", since_sequence: 0 });
		const pulledAfter = await memberA.waitFor(
			(m) => m.type === "response" && m.command === "fetch_messages_since" && m.id === "f2",
		);
		const afterMessages = (pulledAfter.data as Record<string, unknown>).messages as Record<string, unknown>[];
		expect(afterMessages.map((m) => m.sequence)).toEqual([1, 2, 3, 4]);
		expect(afterMessages.some((m) => m.sequence === 5 || m.content === "four")).toBe(false);

		const files = await readGroupChatFile(agentDir, projectDir);
		expect(files).toContain('"sequence":4');
		expect(files).not.toContain('"sequence":5');
		expect(files).not.toContain("four");
		// Persisted senders match the claimed personas (entry content is
		// "<senderLabel>:\n<body>\n" per formatEntryContent; in the JSONL file
		// the newline is escaped as \\n).
		expect(files).toContain("Architect:\\none");
		expect(files).toContain("Architect:\\nthree");
		expect(files).toContain("Reviewer:\\ntwo");

		// ── Clean shutdown ─────────────────────────────────────────────────
		memberA.terminate();
		memberB.terminate();
		await creator.runCommand("/tavern-leave");
	}, 120_000);
});

async function readGroupChatFile(agentDir: string, projectDir: string): Promise<string> {
	const { getGroupChatSessionDirectory } = await import("../../src/discovery/active-descriptor.js");
	const { readdir, readFile } = await import("node:fs/promises");
	const chatsDir = getGroupChatSessionDirectory(agentDir, projectDir);
	const files = await readdir(chatsDir).catch(() => []);
	if (files.length === 0) {
		return "";
	}
	return readFile(join(chatsDir, files[0] ?? ""), "utf8");
}
