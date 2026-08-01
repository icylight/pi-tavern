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
		const collectA = memberA.collect(
			(m) => m.type === "public_message" && (m.sender as Record<string, unknown> | undefined)?.type === "character",
			3,
		);
		const collectB = memberB.collect(
			(m) => m.type === "public_message" && (m.sender as Record<string, unknown> | undefined)?.type === "character",
			3,
		);
		// Two from A, one from B — sent in a burst so arrival order is not
		// guaranteed by the clients; the creator serializes them.
		memberA.send({ id: "s1", type: "speak", content: "one" });
		memberB.send({ id: "s2", type: "speak", content: "two" });
		memberA.send({ id: "s3", type: "speak", content: "three" });

		const [seenByA, seenByB] = await Promise.all([collectA, collectB]);

		// Every receiver observes the same strictly increasing sequence set:
		// creator order is authoritative and identical for all members.
		const sequencesA = seenByA.map((m) => m.sequence as number);
		const sequencesB = seenByB.map((m) => m.sequence as number);
		expect(sequencesA).toEqual([2, 3, 4]);
		expect(sequencesB).toEqual([2, 3, 4]);

		// Cross identity check: each published message's sender name must be
		// the persona its connection claimed (Architect x2, Reviewer x1). The
		// sender-to-sequence mapping is nondeterministic (interleaved sends),
		// so assert the multiset, not per-sequence names (ISSUE-003 point:
		// protocol-level attribution follows the claimed character).
		const senderNamesA = seenByA.map((m) => (m.sender as Record<string, unknown>).name).sort();
		const senderNamesB = seenByB.map((m) => (m.sender as Record<string, unknown>).name).sort();
		expect(senderNamesA).toEqual(["Architect", "Architect", "Reviewer"]);
		expect(senderNamesB).toEqual(["Architect", "Architect", "Reviewer"]);

		// ── Quota: the round allows 3 speaks; the 4th is not published ─────
		const baseline = memberA.allFrames().length;
		memberA.send({ id: "s4", type: "speak", content: "four" });
		const fourth = await memberA.waitFor((m) => m.type === "response" && m.command === "speak", 30_000, baseline);
		expect(fourth.success).toBe(true);
		expect((fourth.data as Record<string, unknown>).published).toBe(false);
		expect((fourth.data as Record<string, unknown>).hand_raised).toBe(true);

		// No 4th public_message is broadcast (give any wrong broadcast a chance).
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 800));

		// Negative assertions from the receivers' perspective: a buggy
		// implementation that broadcast/persisted the 4th speak would still
		// satisfy toContain('"sequence":4') (the 3rd published speak already
		// holds sequence 4), so the absence must be asserted explicitly.
		const characterMessagesA = memberA
			.allFrames()
			.filter(
				(m) => m.type === "public_message" && (m.sender as Record<string, unknown> | undefined)?.type === "character",
			);
		const characterMessagesB = memberB
			.allFrames()
			.filter(
				(m) => m.type === "public_message" && (m.sender as Record<string, unknown> | undefined)?.type === "character",
			);
		expect(characterMessagesA.some((m) => m.sequence === 5 || m.content === "four")).toBe(false);
		expect(characterMessagesB.some((m) => m.sequence === 5 || m.content === "four")).toBe(false);

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
