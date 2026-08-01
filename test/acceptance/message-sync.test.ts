import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type WebSocket from "ws";

import { PiProcess } from "./pi-process.js";
import { joinCharacterWs } from "./ws-helper.js";

/**
 * ISSUE-013 acceptance: the server-side staleness contract (B2/B4/B6) and
 * the legacy path (no based_on_sequence). The character-side delivery
 * pipeline (A1/A2 settle refetch) is unit-covered — RPC-mode pi quits the
 * session after the join turn (same limitation as M7 A2/A6), so the
 * acceptance layer pins the creator contract: stale speaks are refused
 * with the missing range, consume no quota, raise no hand, and consecutive
 * speaks by the same character are never falsely rejected (B6).
 */
describe("acceptance: ISSUE-013 speak staleness contract", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	const processes: PiProcess[] = [];
	const sockets: WebSocket[] = [];

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-tavern-acc-sync-"));
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
				config_max_messages: 10,
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

	it("B2/B4/B6: stale speaks are refused (no quota, no hand); consecutive speaks pass", async () => {
		const creator = PiProcess.spawn({
			label: "creator",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator"),
			cwd: projectDir,
		});
		processes.push(creator);
		const descriptor = await creator.startGroupChat(projectDir, agentDir);

		// One User Persona message creates the round (seq 1).
		await creator.runCommand("/tavern-test-message one");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);

		const memberA = await joinCharacterWs(descriptor, "ws-sync-a", "characters/architect.md");
		sockets.push(memberA.socket);
		const memberB = await joinCharacterWs(descriptor, "ws-sync-b", "characters/reviewer.md");
		sockets.push(memberB.socket);
		// Both saw their join-time history (seq 1).
		await memberA.waitFor((m) => m.type === "message_history");
		await memberB.waitFor((m) => m.type === "message_history");

		// ── B2: a speak based on an older sequence is refused ──────────────
		// based_on_sequence 0 while the latest other-sender sequence is 1.
		const baselineA = memberA.allFrames().length;
		memberA.send({ id: "stale1", type: "speak", content: "stale reply", based_on_sequence: 0 });
		const stale = await memberA.waitFor(
			(m) => m.type === "response" && m.command === "speak" && m.id === "stale1",
			30_000,
			baselineA,
		);
		// Business refusal mirrors round_limit_reached: success:true.
		expect(stale.success).toBe(true);
		expect(stale.data).toMatchObject({
			published: false,
			reason: "stale",
			missing_sequences: { from: 1, to: 1 },
			round: { round_max_messages: 10, used_messages: 0, remaining_messages: 10 },
		});
		// B4: no hand raised by the staleness refusal (contrast: round-limit
		// refusals raise the hand — speak-order covers hand_raised:true).
		expect(stale.data).not.toHaveProperty("hand_raised");
		expect(stale.data).not.toHaveProperty("handRaised");

		// The stale message never hit the group chat: another member sees no
		// new notification and the total message count is unchanged.
		await new Promise((resolve) => setTimeout(resolve, 300));
		memberB.send({ id: "p1", type: "fetch_messages_since", since_sequence: 1 });
		const pulled = await memberB.waitFor(
			(m) => m.type === "response" && m.command === "fetch_messages_since" && m.id === "p1",
		);
		expect((pulled.data as Record<string, unknown>).total_messages).toBe(1);
		expect((pulled.data as Record<string, unknown>).latest_sequence).toBe(1);

		// ── B2: a current speak publishes ──────────────────────────────────
		memberA.send({ id: "ok1", type: "speak", content: "current reply", based_on_sequence: 1 });
		const ok1 = await memberA.waitFor((m) => m.type === "response" && m.command === "speak" && m.id === "ok1", 30_000);
		expect(ok1.data).toMatchObject({ published: true, sequence: 2 });

		// ── B6: the next speak by the same character is NOT self-rejected ──
		// The server excludes the requester's own messages (seq 2) from the
		// staleness check, so based=2 (or even 1) publishes.
		memberA.send({ id: "ok2", type: "speak", content: "second by A", based_on_sequence: 2 });
		const ok2 = await memberA.waitFor((m) => m.type === "response" && m.command === "speak" && m.id === "ok2", 30_000);
		expect(ok2.data).toMatchObject({ published: true, sequence: 3 });
		memberA.send({ id: "ok3", type: "speak", content: "third by A", based_on_sequence: 1 });
		const ok3 = await memberA.waitFor((m) => m.type === "response" && m.command === "speak" && m.id === "ok3", 30_000);
		// based=1 < latest other-sender sequence (1) is NOT stale (1 !< 1),
		// and own messages never count: published.
		expect(ok3.data).toMatchObject({ published: true, sequence: 4 });

		// ── Legacy path: omitting the field skips the check ───────────────
		memberB.send({ id: "leg1", type: "speak", content: "legacy reply" });
		const legacy = await memberB.waitFor(
			(m) => m.type === "response" && m.command === "speak" && m.id === "leg1",
			30_000,
		);
		expect(legacy.data).toMatchObject({ published: true, sequence: 5 });

		// ── B2 again: a stale speak after real traffic is still refused ───
		// memberB saw seq 1 at join; speaking with based=1 while the latest
		// other-sender sequence is 4 (memberA's ok3) is stale.
		memberB.send({ id: "stale2", type: "speak", content: "behind again", based_on_sequence: 1 });
		const stale2 = await memberB.waitFor(
			(m) => m.type === "response" && m.command === "speak" && m.id === "stale2",
			30_000,
		);
		expect(stale2.data).toMatchObject({
			published: false,
			reason: "stale",
			missing_sequences: { from: 2, to: 5 },
		});
		// B4: the refusal consumed no quota — used_messages still 3 (ok1,
		// ok2, ok3 by A; leg1 by B comes after — used counts only published
		// speaks of the round: A's three).
		expect(stale2.data).toMatchObject({
			round: { round_max_messages: 10, used_messages: 4, remaining_messages: 6 },
		});
	});
});
