import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import type { ActiveGroupChatDescriptor } from "../../src/discovery/active-descriptor.js";
import { PiProcess } from "./pi-process.js";

/**
 * Raw WebSocket client that buffers every frame it receives (ws drops frames
 * that arrive before a listener is attached, so join-time frames must be
 * captured from the very first message).
 */
class BufferedWsClient {
	private readonly frames: Record<string, unknown>[] = [];
	private readonly frameWaiters: Array<() => void> = [];

	constructor(readonly socket: WebSocket) {
		socket.on("message", (data) => {
			const message = JSON.parse(data.toString()) as Record<string, unknown>;
			this.frames.push(message);
			for (const waiter of [...this.frameWaiters]) waiter();
		});
	}

	allFrames(): Record<string, unknown>[] {
		return [...this.frames];
	}

	async waitFor(
		predicate: (message: Record<string, unknown>) => boolean,
		timeoutMs = 30_000,
		fromIndex = 0,
	): Promise<Record<string, unknown>> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const existing = this.frames.slice(fromIndex).find(predicate);
			if (existing) {
				return existing;
			}
			if (Date.now() > deadline) {
				throw new Error("timeout waiting for WebSocket message");
			}
			await new Promise<void>((resolveWait) => {
				const waiter = (): void => {
					const index = this.frameWaiters.indexOf(waiter);
					if (index !== -1) this.frameWaiters.splice(index, 1);
					resolveWait();
				};
				this.frameWaiters.push(waiter);
			});
		}
	}

	async collect(
		predicate: (message: Record<string, unknown>) => boolean,
		count: number,
		timeoutMs = 30_000,
	): Promise<Record<string, unknown>[]> {
		const collected: Record<string, unknown>[] = [];
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const matched = this.frames.filter((m) => !collected.includes(m) && predicate(m));
			collected.push(...matched);
			if (collected.length >= count) {
				return collected.slice(0, count);
			}
			if (Date.now() > deadline) {
				throw new Error("timeout collecting WebSocket messages");
			}
			await new Promise<void>((resolveWait) => {
				const waiter = (): void => {
					const index = this.frameWaiters.indexOf(waiter);
					if (index !== -1) this.frameWaiters.splice(index, 1);
					resolveWait();
				};
				this.frameWaiters.push(waiter);
			});
		}
	}

	send(message: Record<string, unknown>): void {
		this.socket.send(JSON.stringify(message));
	}

	terminate(): void {
		this.socket.terminate();
	}
}

/** Connect a raw WebSocket client and complete the join flow. */
async function joinCharacterWs(
	descriptor: ActiveGroupChatDescriptor,
	sessionId: string,
	characterId: string,
): Promise<BufferedWsClient> {
	const client = new BufferedWsClient(
		new WebSocket(
			`ws://${descriptor.host}:${descriptor.port}/` +
				`${encodeURIComponent(descriptor.groupChatId)}/${encodeURIComponent(descriptor.instanceId)}`,
		),
	);
	await new Promise<void>((resolveOpen, rejectOpen) => {
		client.socket.once("open", () => resolveOpen());
		client.socket.once("error", (error) => rejectOpen(error));
	});
	client.send({ id: "1", type: "join_group_chat", session_id: sessionId });
	await client.waitFor((m) => m.type === "response" && m.command === "join_group_chat");
	client.send({ id: "2", type: "claim_character", character_id: characterId });
	await client.waitFor((m) => m.type === "response" && m.command === "claim_character");
	client.send({ id: "3", type: "character_ready" });
	await client.waitFor((m) => m.type === "response" && m.command === "character_ready");
	return client;
}

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
