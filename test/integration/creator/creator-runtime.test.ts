import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";
import { readActiveDescriptor } from "../../../src/data/discovery/active-descriptor.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-runtime-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CreatorRuntime", () => {
	it("starts a new empty group chat and publishes it only after listening", async () => {
		const root = await createTemporaryDirectory();
		const canonicalCwd = join(root, "project");
		const runtime = await CreatorRuntime.startNew({
			cwd: `${root}/nested/../project`,
			agentDir: join(root, "agent"),
		});

		expect(runtime.activeDescriptor.host).toBe("127.0.0.1");
		expect(runtime.activeDescriptor.port).toBeGreaterThan(0);
		expect(runtime.activeDescriptor.cwd).toBe(canonicalCwd);
		expect(runtime.state.groupChat.groupMaxMessages).toBe(20);
		expect(runtime.state.round).toBeNull();
		expect(await readActiveDescriptor(runtime.activeDescriptorPath)).toEqual(runtime.activeDescriptor);
		expect(runtime.state.groupChat.groupChatId).toBeTruthy();
		expect(await jsonlFilesUnder(join(root, "agent"))).toEqual([]);

		await runtime.close();
	});

	it("updates runtime-only metadata while the group chat is empty", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			configMaxMessages: 12,
		});

		expect(await runtime.setName("  Architecture\nReview  ")).toBe("Architecture Review");
		await runtime.setMaxMessages(18);

		expect(runtime.state.groupChat.name).toBe("Architecture Review");
		expect(runtime.state.groupChat.groupMaxMessages).toBe(18);
		expect((await readActiveDescriptor(runtime.activeDescriptorPath))?.name).toBe("Architecture Review");
		expect(await jsonlFilesUnder(join(root, "agent"))).toEqual([]);

		// First message inherits latest groupMaxMessages (18), not configMaxMessages (12)
		await runtime.submitUserPersonaMessage("Hello");
		expect(runtime.state.round?.roundMaxMessages).toBe(18);

		expect(await jsonlFilesUnder(join(root, "agent"))).toHaveLength(1);

		await runtime.close();
	});

	it("closes idempotently without creating an empty session file", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		await Promise.all([runtime.close(), runtime.close()]);

		expect(await readActiveDescriptor(runtime.activeDescriptorPath)).toBeNull();
		expect(runtime.webSocketServer.address()).toBeNull();
		expect(await jsonlFilesUnder(join(root, "agent"))).toEqual([]);
	});

	it("closes the listening server when descriptor publication fails", async () => {
		const root = await createTemporaryDirectory();
		let allocatedPort: number | undefined;

		await expect(
			CreatorRuntime.startNew(
				{
					cwd: join(root, "project"),
					agentDir: join(root, "agent"),
				},
				{
					publishDescriptor: async (_agentDir, descriptor) => {
						allocatedPort = descriptor.port;
						throw new Error("publication failed");
					},
				},
			),
		).rejects.toThrow("publication failed");

		expect(allocatedPort).toBeDefined();
		await expectConnectionRefused(allocatedPort as number);
		expect(await jsonlFilesUnder(join(root, "agent"))).toEqual([]);
	});

	it("persists a user persona message and creates the first round", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		await runtime.submitUserPersonaMessage("Hello from user persona");

		// Round created, inheriting groupMaxMessages
		expect(runtime.state.round).toEqual({
			roundMaxMessages: 20,
			usedMessages: 0,
		});

		// Message persisted to group chat JSONL
		const jsonlFiles = await jsonlFilesUnder(join(root, "agent"));
		expect(jsonlFiles).toHaveLength(1);

		const firstFile = jsonlFiles[0];
		expect(firstFile).toBeDefined();
		const sessionPath = join(root, "agent", firstFile as string);
		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(1);

		// First line is the session header
		const firstLine = lines[0];
		expect(firstLine).toBeDefined();
		const header = JSON.parse(firstLine as string);
		expect(header.type).toBe("session");
		expect(header.id).toBe(runtime.state.groupChat.groupChatId);
		expect(typeof header.timestamp).toBe("string");
		expect(header.timestamp).toBe(runtime.state.groupChat.createdAt);
		expect(header.version).toBe(3);
		expect(header.cwd).toBe(runtime.activeDescriptor.cwd);

		// Parse all entries for indexed lookup
		const allEntries = lines.map((l) => JSON.parse(l)) as Record<string, unknown>[];

		// Verify session_info entry (written when group has a name at first persist)
		const sessionInfoEntry = allEntries.find((e) => e.type === "session_info");
		expect(sessionInfoEntry).toBeUndefined(); // No name set, so no session_info

		// Verify group-settings entry
		const settingsEntry = allEntries.find((e) => e.type === "custom" && e.customType === "pi-tavern.group-settings");
		expect(settingsEntry).toBeDefined();
		if (!settingsEntry) return;
		expect(settingsEntry.type).toBe("custom");
		expect(settingsEntry.customType).toBe("pi-tavern.group-settings");
		expect(typeof settingsEntry.id).toBe("string");
		expect(typeof settingsEntry.timestamp).toBe("string");
		expect(settingsEntry.data).toEqual({ group_max_messages: 20 });

		// Verify the public message entry
		const publicEntry = allEntries.find((e) => e.type === "custom_message");
		expect(publicEntry).toBeDefined();
		if (!publicEntry) return;
		expect(publicEntry.customType).toBe("pi-tavern.public-message");
		expect(publicEntry.display).toBe(true);
		expect(typeof publicEntry.id).toBe("string");
		expect(typeof publicEntry.timestamp).toBe("string");
		// parentId chains to settings entry
		expect(publicEntry.parentId).toBe(settingsEntry.id);
		// Content follows formatEntryContent pattern
		expect(publicEntry.content).toBe("User Persona:\nHello from user persona\n");
		// Details
		const details = publicEntry.details as Record<string, unknown>;
		expect(details.sender).toEqual({ type: "user_persona" });
		expect(details.content).toBe("Hello from user persona");
		expect(details.sequence).toBe(1);
		// details must NOT carry a second timestamp — entry envelope is the single source of time (BC-19)
		expect(details.timestamp).toBeUndefined();
		expect(typeof publicEntry.timestamp).toBe("string");
		expect(details.round).toEqual({
			round_max_messages: 20,
			used_messages: 0,
			remaining_messages: 20,
		});

		await runtime.close();
	});

	it("persists session_info entry when group has a name at first persist", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		// Set name before first message
		await runtime.setName("My Tavern");

		await runtime.submitUserPersonaMessage("Hello");

		const jsonlFiles = await jsonlFilesUnder(join(root, "agent"));
		expect(jsonlFiles).toHaveLength(1);
		const sessionPath = join(root, "agent", jsonlFiles[0] as string);
		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");
		const allEntries = lines.map((l) => JSON.parse(l)) as Record<string, unknown>[];

		// session_info entry is present
		const sessionInfoEntry = allEntries.find((e) => e.type === "session_info");
		expect(sessionInfoEntry).toBeDefined();
		if (!sessionInfoEntry) return;
		expect(sessionInfoEntry.type).toBe("session_info");
		expect(sessionInfoEntry.name).toBe("My Tavern");
		expect(typeof sessionInfoEntry.id).toBe("string");
		expect(typeof sessionInfoEntry.timestamp).toBe("string");

		// settings entry parentId chains from session_info
		const settingsEntry = allEntries.find((e) => e.type === "custom" && e.customType === "pi-tavern.group-settings");
		expect(settingsEntry).toBeDefined();
		if (!settingsEntry) return;
		expect(settingsEntry.parentId).toBe(sessionInfoEntry.id);

		await runtime.close();
	});

	it("appends session_info after setName when group chat is started", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		// First message starts the group, persisting header + entries
		await runtime.submitUserPersonaMessage("First");

		// Change name after first persist → appended via SessionManager.appendSessionInfo
		await runtime.setName("Renamed Tavern");

		const jsonlFiles = await jsonlFilesUnder(join(root, "agent"));
		expect(jsonlFiles).toHaveLength(1);
		const sessionPath = join(root, "agent", jsonlFiles[0] as string);
		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");
		const allEntries = lines.map((l) => JSON.parse(l)) as Record<string, unknown>[];

		// Last entry should be the new session_info
		const lastEntry = allEntries[allEntries.length - 1];
		expect(lastEntry).toBeDefined();
		if (!lastEntry) return;
		expect(lastEntry.type).toBe("session_info");
		expect(lastEntry.name).toBe("Renamed Tavern");
		expect(typeof lastEntry.id).toBe("string");
		expect(typeof lastEntry.parentId).toBe("string");

		await runtime.close();
	});

	it("appends group-settings after setMaxMessages when group chat is started", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		// First message starts the group, persisting header + entries
		await runtime.submitUserPersonaMessage("First");

		// Change maxMessages after first persist → appended via SessionManager.appendCustomEntry
		await runtime.setMaxMessages(5);

		const jsonlFiles = await jsonlFilesUnder(join(root, "agent"));
		expect(jsonlFiles).toHaveLength(1);
		const sessionPath = join(root, "agent", jsonlFiles[0] as string);
		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");
		const allEntries = lines.map((l) => JSON.parse(l)) as Record<string, unknown>[];

		// Last entry should be the new group-settings
		const lastEntry = allEntries[allEntries.length - 1];
		expect(lastEntry).toBeDefined();
		if (!lastEntry) return;
		expect(lastEntry.type).toBe("custom");
		expect(lastEntry.customType).toBe("pi-tavern.group-settings");
		expect(lastEntry.data).toEqual({ group_max_messages: 5 });
		expect(typeof lastEntry.id).toBe("string");
		expect(typeof lastEntry.parentId).toBe("string");

		await runtime.close();
	});

	it("second user persona message creates a new round resetting usedMessages and handRaised", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// First message creates the initial round
		await runtime.submitUserPersonaMessage("First");
		expect(runtime.state.round?.roundMaxMessages).toBe(20);
		expect(runtime.state.round?.usedMessages).toBe(0);

		// Join a character and set handRaised
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.send(JSON.stringify({ id: "1", type: "join_group_chat", session_id: "s1" }));
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ id: "2", type: "claim_character", character_id: "dev" }));
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ id: "3", type: "character_ready" }));
		await waitForMessage(client, "response");

		// Simulate used messages and hand raised from previous round
		expect(runtime.state.round).toBeDefined();
		if (runtime.state.round) runtime.state.round.usedMessages = 3;
		for (const c of runtime.state.onlineCharacters.values()) {
			c.handRaised = true;
		}

		// Second message creates a fresh round, resetting usedMessages AND clearing handRaised
		await runtime.submitUserPersonaMessage("Second");
		expect(runtime.state.round?.roundMaxMessages).toBe(20);
		expect(runtime.state.round?.usedMessages).toBe(0);
		for (const c of runtime.state.onlineCharacters.values()) {
			expect(c.handRaised).toBe(false);
		}

		client.close();
		await runtime.close();
	});

	it("new round inherits updated groupMaxMessages after setMaxMessages", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		// Create first round with default groupMaxMessages=10
		await runtime.submitUserPersonaMessage("First");
		expect(runtime.state.round?.roundMaxMessages).toBe(20);

		// Change the limit and create a new round
		await runtime.setMaxMessages(5);
		// Current round is unaffected by setMaxMessages
		expect(runtime.state.round?.roundMaxMessages).toBe(20);

		await runtime.submitUserPersonaMessage("Second");
		expect(runtime.state.round?.roundMaxMessages).toBe(5);
		expect(runtime.state.round?.usedMessages).toBe(0);

		await runtime.close();
	});

	it("rejects invalid setMaxMessages before any persistence or state change (BC-18)", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		// First message establishes the file and a round
		await runtime.submitUserPersonaMessage("First");
		expect(runtime.state.round?.roundMaxMessages).toBe(20);
		const [sessionFile] = await jsonlFilesUnder(join(root, "agent"));
		expect(sessionFile).toBeDefined();
		if (!sessionFile) return;
		const sessionPath = join(root, "agent", sessionFile);
		const linesBefore = (await readFile(sessionPath, "utf8")).trim().split("\n");
		const persistedCountBefore = (runtime as unknown as { persistedCount: number }).persistedCount;

		// Invalid values must be rejected BEFORE any persistence or state mutation
		for (const invalid of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
			await expect(runtime.setMaxMessages(invalid)).rejects.toThrow("non-negative safe integer");
		}

		// No entry was appended, persistedCount unchanged, state unchanged
		const linesAfter = (await readFile(sessionPath, "utf8")).trim().split("\n");
		expect(linesAfter).toEqual(linesBefore);
		expect((runtime as unknown as { persistedCount: number }).persistedCount).toBe(persistedCountBefore);
		expect(runtime.state.groupChat.groupMaxMessages).toBe(20);

		// A subsequent legal operation still succeeds
		await runtime.setMaxMessages(5);
		expect(runtime.state.groupChat.groupMaxMessages).toBe(5);

		await runtime.close();
	});

	it("does not commit round state when first persist fails", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew(
			{
				cwd: join(root, "project"),
				agentDir: join(root, "agent"),
			},
			{
				writeFile: () => Promise.reject(new Error("disk full")),
			},
		);

		await expect(runtime.submitUserPersonaMessage("Hello")).rejects.toThrow("disk full");

		// State must not be committed after a failed persist
		expect(runtime.state.round).toBeNull();

		await runtime.close();
	});

	it("allows retry after first-persist partial failure is rolled back", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		// Simulate failure on the first appendCustomMessageEntry
		const sm = (runtime as unknown as { groupSessionManager: { appendCustomMessageEntry: typeof vi.fn } })
			.groupSessionManager;
		const spy = vi.spyOn(sm, "appendCustomMessageEntry");
		spy.mockImplementationOnce(() => {
			throw new Error("disk full during message append");
		});

		// First attempt fails
		await expect(runtime.submitUserPersonaMessage("First")).rejects.toThrow("disk full during message append");

		expect(runtime.state.round).toBeNull();
		expect((runtime as unknown as { persistedCount: number }).persistedCount).toBe(0);

		// Verify no JSONL file remains after rollback
		expect(await jsonlFilesUnder(join(root, "agent"))).toEqual([]);

		// Restore real append and retry
		spy.mockRestore();
		await runtime.submitUserPersonaMessage("First");

		// Second attempt succeeds
		expect(runtime.state.round).toEqual({ roundMaxMessages: 20, usedMessages: 0 });
		expect(await jsonlFilesUnder(join(root, "agent"))).toHaveLength(1);

		await runtime.close();
	});

	it("enters persistence-fatal when rollback rm fails (BC-2)", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew(
			{
				cwd: join(root, "project"),
				agentDir: join(root, "agent"),
			},
			{
				rm: () => Promise.reject(new Error("permission denied")),
			},
		);

		// Simulate failure on the first public message append → rollback tries to rm the half-initialized file
		const sm = (runtime as unknown as { groupSessionManager: { appendCustomMessageEntry: typeof vi.fn } })
			.groupSessionManager;
		vi.spyOn(sm, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("disk full during message append");
		});

		// rm fails → rollback reports the deletion failure
		await expect(runtime.submitUserPersonaMessage("First")).rejects.toThrow(
			/Failed to delete half-initialized session file/,
		);

		// Runtime is persistence-fatal: all subsequent writes are rejected
		await expect(runtime.submitUserPersonaMessage("Second")).rejects.toThrow(/persistence is broken/i);

		await runtime.close();
	});

	it("leaves no half-initialized JSONL when first persist fails and runtime closes (BC-2)", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		const sm = (runtime as unknown as { groupSessionManager: { appendCustomMessageEntry: typeof vi.fn } })
			.groupSessionManager;
		vi.spyOn(sm, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("disk full during message append");
		});

		// First persist fails and rolls back cleanly
		await expect(runtime.submitUserPersonaMessage("First")).rejects.toThrow("disk full during message append");
		expect(await jsonlFilesUnder(join(root, "agent"))).toEqual([]);

		// Closing right after the failed persist must not resurrect a partial file
		await runtime.close();
		expect(await jsonlFilesUnder(join(root, "agent"))).toEqual([]);
	});

	it("broadcasts the public message to online characters", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// Connect a WebSocket client and complete the join flow
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);

		// join_group_chat
		client.send(JSON.stringify({ id: "1", type: "join_group_chat", session_id: "session-1" }));
		await waitForMessage(client, "response");
		// claim_character
		client.send(JSON.stringify({ id: "2", type: "claim_character", character_id: "dev" }));
		await waitForMessage(client, "response");
		// character_ready
		client.send(JSON.stringify({ id: "3", type: "character_ready" }));
		const readyResponse = await waitForMessage(client, "response");
		expect(readyResponse.success).toBe(true);

		// Submit user persona message and wait for the broadcast event
		interface PublicMessage {
			type: string;
			content: string;
			sender: { type: string };
			round: { round_max_messages: number; used_messages: number; remaining_messages: number };
			event_id: string;
			preview_messages: PublicMessage[];
			latest_sequence: number;
			total_messages: number;
			sequence: number;
			timestamp: string;
		}
		const broadcastPromise = new Promise<PublicMessage>((resolve) => {
			const onMessage = (data: WebSocket.RawData) => {
				const message = JSON.parse(data.toString()) as PublicMessage;
				if (message.type === "group_chat_update") {
					client.off("message", onMessage);
					resolve(message);
				}
			};
			client.on("message", onMessage);
		});

		await runtime.submitUserPersonaMessage("Hello everyone");

		const publicMessage = await broadcastPromise;

		// M7 (ISSUE-012): broadcasts are group_chat_update notifications; the
		// preview carries the message content.
		const preview = publicMessage.preview_messages as PublicMessage[];
		expect(preview.at(-1)?.content).toBe("Hello everyone");
		expect(preview.at(-1)?.sender).toEqual({ type: "user_persona" });
		expect(preview.at(-1)?.round).toEqual({ round_max_messages: 20, used_messages: 0, remaining_messages: 20 });
		expect(typeof preview.at(-1)?.event_id).toBe("string");
		expect(typeof preview.at(-1)?.sequence).toBe("number");
		expect(typeof preview.at(-1)?.timestamp).toBe("string");
		expect(publicMessage.latest_sequence).toBeGreaterThan(0);
		expect(publicMessage.total_messages).toBeGreaterThan(0);

		// BC-3: broadcast timestamp must exactly match the JSONL entry envelope timestamp
		const [sessionFile] = await jsonlFilesUnder(join(root, "agent"));
		expect(sessionFile).toBeDefined();
		if (sessionFile) {
			const sessionPath = join(root, "agent", sessionFile);
			const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");
			const publicEntry = lines
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.find((entry) => entry.type === "custom_message");
			expect(publicEntry).toBeDefined();
			if (publicEntry) {
				expect(preview.at(-1)?.timestamp).toBe(publicEntry.timestamp);
				expect(preview.at(-1)?.event_id).toBe(publicEntry.id);
			}
		}

		client.close();
		await runtime.close();
	});

	it("broadcast still delivers to clients when onPublicMessage throws", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [{ characterId: "dev", name: "Dev", description: "", path: "/x.md", prompt: "" }],
		});

		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.send(JSON.stringify({ id: "1", type: "join_group_chat", session_id: "s1" }));
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ id: "2", type: "claim_character", character_id: "dev" }));
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ id: "3", type: "character_ready" }));
		await waitForMessage(client, "response");

		// Set a throwing onPublicMessage handler
		runtime.onPublicMessage = () => {
			throw new Error("TUI broken");
		};

		// Wait for broadcast
		const broadcastPromise = new Promise<boolean>((resolve) => {
			const onMsg = (data: WebSocket.RawData) => {
				const msg = JSON.parse(data.toString()) as { type: string };
				if (msg.type === "group_chat_update") {
					client.off("message", onMsg);
					resolve(true);
				}
			};
			client.on("message", onMsg);
		});

		// Should not throw — the onPublicMessage error is caught internally
		await runtime.submitUserPersonaMessage("Hello");

		// Broadcast still delivered despite onPublicMessage throwing
		await expect(broadcastPromise).resolves.toBe(true);

		client.close();
		await runtime.close();
	});

	it("onPublicMessage fires when broadcaster has no connected clients", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		let tuiMessage: unknown = null;
		runtime.onPublicMessage = (msg) => {
			tuiMessage = msg;
		};

		// No connected clients → broadcast iteration is a no-op
		await runtime.submitUserPersonaMessage("Solo message");

		expect(tuiMessage).not.toBeNull();
		expect((tuiMessage as { content: string }).content).toBe("Solo message");

		await runtime.close();
	});

	it("fires onPublicMessageError when onPublicMessage callback throws", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		runtime.onPublicMessage = () => {
			throw new Error("callback crash");
		};
		const errorCalls: Array<{ error: string; sequence: number; timestamp: string }> = [];
		runtime.onPublicMessageError = (error, sequence, timestamp) => {
			errorCalls.push({ error, sequence, timestamp });
		};

		await runtime.submitUserPersonaMessage("Hello");

		expect(errorCalls).toHaveLength(1);
		expect(errorCalls[0]?.error).toContain("TUI projection failed: callback crash");
		expect(errorCalls[0]?.sequence).toBe(1);
		expect(typeof errorCalls[0]?.timestamp).toBe("string");

		await runtime.close();
	});

	it("rejects speak when message exceeds 64 KiB", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// Join a character
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.send(JSON.stringify({ id: "1", type: "join_group_chat", session_id: "session-1" }));
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ id: "2", type: "claim_character", character_id: "dev" }));
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ id: "3", type: "character_ready" }));
		await waitForMessage(client, "response");

		// Create a round first
		await runtime.submitUserPersonaMessage("Start the round");

		// Send message exceeding 64 KiB
		const bigMessage = "x".repeat(64 * 1024 + 1);
		client.send(JSON.stringify({ id: "4", type: "speak", content: bigMessage }));
		const speakResponse = await waitForMessage(client, "response");

		expect(speakResponse.command).toBe("speak");
		expect(speakResponse.success).toBe(false);
		expect(speakResponse.error).toContain("exceeds 64 KiB");

		client.close();
		await runtime.close();
	});

	it("publishes a character speak message and increments round usage", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// Join a character
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.send(JSON.stringify({ id: "1", type: "join_group_chat", session_id: "session-1" }));
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ id: "2", type: "claim_character", character_id: "dev" }));
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ id: "3", type: "character_ready" }));
		await waitForMessage(client, "response");

		// Create a round first
		await runtime.submitUserPersonaMessage("Start the round");
		expect(runtime.state.round?.usedMessages).toBe(0);

		// Simulate hand raised from a previous quota-exhausted speak
		for (const c of runtime.state.onlineCharacters.values()) {
			c.handRaised = true;
		}

		// Capture all incoming messages on the sender's socket
		const receivedMessages: Record<string, unknown>[] = [];
		client.on("message", (data) => {
			receivedMessages.push(JSON.parse(data.toString()) as Record<string, unknown>);
		});

		// Send a speak message; also verify sender receives their own broadcast
		client.send(JSON.stringify({ id: "4", type: "speak", content: "My public reply" }));

		const speakResponse = await waitForMessage(client, "response");

		// Sender also receives the group_chat_update notification (broadcast
		// includes all online members; M7 preview carries the new message).
		const senderEcho = receivedMessages.find(
			(m) =>
				m.type === "group_chat_update" &&
				(m.preview_messages as Record<string, unknown>[]).some((p) => p.content === "My public reply"),
		);
		expect(senderEcho).toBeDefined();

		expect(speakResponse.command).toBe("speak");
		expect(speakResponse.success).toBe(true);
		expect(speakResponse.data).toEqual({
			published: true,
			event_id: expect.any(String) as string,
			sequence: expect.any(Number) as number,
			// ISSUE-013 B6: success carries latest_sequence (== published seq
			// on success) so the client advances past its own message.
			latest_sequence: expect.any(Number) as number,
			round: { round_max_messages: 20, used_messages: 1, remaining_messages: 19 },
		});

		// Round usage incremented
		expect(runtime.state.round?.usedMessages).toBe(1);
		// Own handRaised is cleared after successful speak
		for (const c of runtime.state.onlineCharacters.values()) {
			expect(c.handRaised).toBe(false);
		}

		// Message persisted to JSONL
		const jsonlFiles = await jsonlFilesUnder(join(root, "agent"));
		expect(jsonlFiles).toHaveLength(1);

		const firstFile = jsonlFiles[0];
		expect(firstFile).toBeDefined();
		const sessionPath = join(root, "agent", firstFile as string);
		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");

		// Verify the character public message entry is present
		const publicEntry = lines
			.map((l) => JSON.parse(l))
			.find(
				(e: Record<string, unknown>) =>
					e.type === "custom_message" &&
					e.customType === "pi-tavern.public-message" &&
					typeof e.content === "string" &&
					(e.content as string).includes("My public reply"),
			);
		expect(publicEntry).toBeDefined();
		expect(publicEntry.type).toBe("custom_message");
		expect(publicEntry.content).toContain("My public reply");
		expect(publicEntry.details.sender).toEqual({
			type: "character",
			character_id: "dev",
			name: "Developer",
		});

		// Broadcast timestamp matches the persisted entry timestamp (M7: the
		// preview carries the persisted message fields).
		const echoPreview = (senderEcho as Record<string, unknown>).preview_messages as Record<string, unknown>[];
		expect(echoPreview.at(-1)?.timestamp).toBe(publicEntry.timestamp);
		expect(publicEntry.details.round).toEqual({ round_max_messages: 20, used_messages: 1, remaining_messages: 19 });
		expect(typeof publicEntry.details.sequence).toBe("number");
		// details must NOT carry a second timestamp (BC-19)
		expect(publicEntry.details.timestamp).toBeUndefined();
		expect(publicEntry.details.content).toBe("My public reply");

		client.close();
		await runtime.close();
	});

	it("returns speak failure when persist throws and does not mutate state", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// Join a character
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.send(JSON.stringify({ id: "1", type: "join_group_chat", session_id: "session-1" }));
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ id: "2", type: "claim_character", character_id: "dev" }));
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ id: "3", type: "character_ready" }));
		await waitForMessage(client, "response");

		// Create a round first
		await runtime.submitUserPersonaMessage("Start the round");

		const roundBefore = { ...runtime.state.round };
		const handRaisedBefore = (() => {
			for (const c of runtime.state.onlineCharacters.values()) return c.handRaised;
			return undefined;
		})();

		// Spy on SessionManager to simulate persist failure
		const sessionManager = (runtime as unknown as { groupSessionManager: { appendCustomMessageEntry: typeof vi.fn } })
			.groupSessionManager;
		vi.spyOn(sessionManager, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("disk full");
		});

		client.send(JSON.stringify({ id: "4", type: "speak", content: "This should fail" }));
		const speakResponse = await waitForMessage(client, "response");

		// Response indicates failure
		expect(speakResponse.command).toBe("speak");
		expect(speakResponse.success).toBe(false);
		expect(speakResponse.error).toContain("disk full");

		// State must NOT be mutated after a failed persist
		expect(runtime.state.round?.usedMessages).toBe(roundBefore?.usedMessages ?? 0);

		// handRaised unchanged
		for (const c of runtime.state.onlineCharacters.values()) {
			expect(c.handRaised).toBe(handRaisedBefore ?? false);
		}

		client.close();
		await runtime.close();
	});

	it("recovers SessionManager leaf after append failure so next entry parentId is correct", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [{ characterId: "dev", name: "Dev", description: "", path: "/x.md", prompt: "" }],
		});

		// First message establishes the file
		await runtime.submitUserPersonaMessage("First");

		// Join a character for speak
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.send(JSON.stringify({ id: "1", type: "join_group_chat", session_id: "s1" }));
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ id: "2", type: "claim_character", character_id: "dev" }));
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ id: "3", type: "character_ready" }));
		await waitForMessage(client, "response");

		// Simulate append failure. The spy throws before SessionManager's
		// _appendEntry mutates in-memory state, so leaf is NOT truly polluted.
		// However the recovery code path (setSessionFile reload) is exercised
		// identically, and the parentId assertion below validates correctness.
		const sm = (runtime as unknown as { groupSessionManager: { appendCustomMessageEntry: typeof vi.fn } })
			.groupSessionManager;
		vi.spyOn(sm, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("disk full");
		});

		client.send(JSON.stringify({ id: "4", type: "speak", content: "Failing speak" }));
		const failResponse = await waitForMessage(client, "response");
		expect(failResponse.success).toBe(false);

		// Recovery: setSessionFile was called, leaf is clean.
		// A subsequent successful speak should chain parentId to the disk's real leaf,
		// not the failed (never-persisted) entry.
		client.send(JSON.stringify({ id: "5", type: "speak", content: "Recovered speak" }));
		const okResponse = await waitForMessage(client, "response");
		expect(okResponse.success).toBe(true);

		// Verify the successful message was persisted with correct parentId chain
		const jsonlFiles = await jsonlFilesUnder(join(root, "agent"));
		expect(jsonlFiles).toHaveLength(1);
		const sessionPath = join(root, "agent", jsonlFiles[0] as string);
		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");
		const entries = lines.map((l) => JSON.parse(l)) as Record<string, unknown>[];

		// Last entry should be the recovered speak
		const lastEntry = entries[entries.length - 1];
		expect(lastEntry?.type).toBe("custom_message");
		expect((lastEntry as Record<string, unknown>)?.content).toContain("Recovered speak");
		// Its parentId must point to a real disk entry, not the failed one
		const parentId = (lastEntry as Record<string, unknown>)?.parentId as string;
		expect(typeof parentId).toBe("string");
		const parentExists = entries.some((e) => e.id === parentId);
		expect(parentExists).toBe(true);

		client.close();
		await runtime.close();
	});

	it("recovers SessionManager leaf after setName append failure", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		await runtime.submitUserPersonaMessage("First");

		// Simulate append failure (exercises recovery path)
		const sm = (runtime as unknown as { groupSessionManager: { appendSessionInfo: typeof vi.fn } }).groupSessionManager;
		vi.spyOn(sm, "appendSessionInfo").mockImplementationOnce(() => {
			throw new Error("disk full");
		});

		await expect(runtime.setName("After Crash")).rejects.toThrow("disk full");

		// Recovery succeeded — next setName should chain to correct disk leaf
		await runtime.setName("Recovered Name");
		expect(runtime.state.groupChat.name).toBe("Recovered Name");

		// Verify the successful session_info was persisted
		const jsonlFiles = await jsonlFilesUnder(join(root, "agent"));
		const sessionPath = join(root, "agent", jsonlFiles[0] as string);
		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");
		const entries = lines.map((l) => JSON.parse(l)) as Record<string, unknown>[];
		const lastSessionInfo = entries.reverse().find((e) => e.type === "session_info");
		expect(lastSessionInfo).toBeDefined();
		expect((lastSessionInfo as Record<string, unknown>)?.name).toBe("Recovered Name");
		// parentId must point to a real disk entry
		const parentId = (lastSessionInfo as Record<string, unknown>)?.parentId as string;
		expect(typeof parentId).toBe("string");
		expect(entries.some((e) => e.id === parentId)).toBe(true);

		await runtime.close();
	});

	it("recovers SessionManager leaf after setMaxMessages append failure", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		await runtime.submitUserPersonaMessage("First");

		// Simulate append failure (exercises recovery path)
		const sm = (runtime as unknown as { groupSessionManager: { appendCustomEntry: typeof vi.fn } }).groupSessionManager;
		vi.spyOn(sm, "appendCustomEntry").mockImplementationOnce(() => {
			throw new Error("disk full");
		});

		await expect(runtime.setMaxMessages(7)).rejects.toThrow("disk full");

		// Recovery succeeded — next setMaxMessages should work
		await runtime.setMaxMessages(7);
		expect(runtime.state.groupChat.groupMaxMessages).toBe(7);

		// Verify the successful group-settings entry was persisted
		const jsonlFiles = await jsonlFilesUnder(join(root, "agent"));
		const sessionPath = join(root, "agent", jsonlFiles[0] as string);
		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");
		const entries = lines.map((l) => JSON.parse(l)) as Record<string, unknown>[];
		const lastSettings = entries
			.reverse()
			.find((e) => e.type === "custom" && e.customType === "pi-tavern.group-settings");
		expect(lastSettings).toBeDefined();
		expect((lastSettings as Record<string, unknown>)?.data).toEqual({ group_max_messages: 7 });
		const parentId = (lastSettings as Record<string, unknown>)?.parentId as string;
		expect(typeof parentId).toBe("string");
		expect(entries.some((e) => e.id === parentId)).toBe(true);

		await runtime.close();
	});

	it("rejects all writes after persistence recovery fails (fatal)", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [{ characterId: "dev", name: "Dev", description: "", path: "/x.md", prompt: "" }],
		});

		// First message establishes the file
		await runtime.submitUserPersonaMessage("First");
		const roundBefore = { ...runtime.state.round };

		// Simulate: append fails AND setSessionFile also fails → persistence fatal
		const sm = (
			runtime as unknown as {
				groupSessionManager: { appendCustomMessageEntry: typeof vi.fn; setSessionFile: typeof vi.fn };
			}
		).groupSessionManager;
		vi.spyOn(sm, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		vi.spyOn(sm, "setSessionFile").mockImplementationOnce(() => {
			throw new Error("cannot read file");
		});

		// First write fails with recovery error
		await expect(runtime.submitUserPersonaMessage("Second")).rejects.toThrow(/ersistence recovery failed/);

		// State unchanged after failed write
		expect(runtime.state.round?.usedMessages).toBe(roundBefore?.usedMessages);

		// Subsequent writes are rejected
		await expect(runtime.submitUserPersonaMessage("Third")).rejects.toThrow(/ersistence is broken/);
		await expect(runtime.setName("New Name")).rejects.toThrow(/ersistence is broken/);
		await expect(runtime.setMaxMessages(5)).rejects.toThrow(/ersistence is broken/);

		// No new JSONL files
		expect(await jsonlFilesUnder(join(root, "agent"))).toHaveLength(1);

		await runtime.close();
	});

	it("rejects speak after persistence fatal without mutating state", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [{ characterId: "dev", name: "Dev", description: "", path: "/x.md", prompt: "" }],
		});

		await runtime.submitUserPersonaMessage("First");

		// Join a character
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.send(JSON.stringify({ id: "1", type: "join_group_chat", session_id: "s1" }));
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ id: "2", type: "claim_character", character_id: "dev" }));
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ id: "3", type: "character_ready" }));
		await waitForMessage(client, "response");

		const roundBefore = { ...runtime.state.round };

		// Trigger fatal: append fails + setSessionFile fails
		const sm = (
			runtime as unknown as {
				groupSessionManager: { appendCustomMessageEntry: typeof vi.fn; setSessionFile: typeof vi.fn };
			}
		).groupSessionManager;
		vi.spyOn(sm, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		vi.spyOn(sm, "setSessionFile").mockImplementationOnce(() => {
			throw new Error("cannot read");
		});

		client.send(JSON.stringify({ id: "4", type: "speak", content: "Triggers fatal" }));
		const fatalResponse = await waitForMessage(client, "response");
		expect(fatalResponse.success).toBe(false);
		expect(fatalResponse.error).toContain("ersistence recovery failed");

		// State unchanged
		expect(runtime.state.round?.usedMessages).toBe(roundBefore?.usedMessages);

		// Subsequent speak also rejected (assertWritable in handleSpeak)
		client.send(JSON.stringify({ id: "5", type: "speak", content: "Should be rejected" }));
		const rejectedResponse = await waitForMessage(client, "response");
		expect(rejectedResponse.success).toBe(false);
		expect(rejectedResponse.error).toContain("ersistence is broken");

		client.close();
		await runtime.close();
	});

	it("rejects speak when round limit reached and sets hand raised", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			configMaxMessages: 1,
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// Join a character and create a round with max 1 message
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.send(JSON.stringify({ id: "1", type: "join_group_chat", session_id: "session-1" }));
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ id: "2", type: "claim_character", character_id: "dev" }));
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ id: "3", type: "character_ready" }));
		await waitForMessage(client, "response");

		await runtime.submitUserPersonaMessage("Start");

		// Exhaust the round
		client.send(JSON.stringify({ id: "4", type: "speak", content: "First and only" }));
		const firstResponse = await waitForMessage(client, "response");
		expect((firstResponse as { data: { published: boolean } }).data.published).toBe(true);
		expect(runtime.state.round?.usedMessages).toBe(1);

		// Next speak should be rejected
		client.send(JSON.stringify({ id: "5", type: "speak", content: "Too late" }));
		const secondResponse = await waitForMessage(client, "response");

		expect(secondResponse.command).toBe("speak");
		expect(secondResponse.success).toBe(true);
		expect(secondResponse.data).toEqual({
			published: false,
			reason: "round_limit_reached",
			hand_raised: true,
			round: { round_max_messages: 1, used_messages: 1, remaining_messages: 0 },
		});

		// Used messages unchanged
		expect(runtime.state.round?.usedMessages).toBe(1);

		client.close();
		await runtime.close();
	});

	it("sends recent public messages in message_history on join", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// Create two public messages before joining
		await runtime.submitUserPersonaMessage("First");
		await runtime.submitUserPersonaMessage("Second");

		// Join a character
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.send(JSON.stringify({ id: "1", type: "join_group_chat", session_id: "session-1" }));
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ id: "2", type: "claim_character", character_id: "dev" }));
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ id: "3", type: "character_ready" }));

		// Wait for the message_history
		const historyPromise = new Promise<Record<string, unknown>>((resolve) => {
			const onMessage = (data: WebSocket.RawData) => {
				const msg = JSON.parse(data.toString()) as Record<string, unknown>;
				if (msg.type === "message_history") {
					client.off("message", onMessage);
					resolve(msg);
				}
			};
			client.on("message", onMessage);
		});

		const history = await historyPromise;
		expect(history.messages).toHaveLength(2);
		expect((history.messages as Array<{ content: string }>)[0]?.content).toBe("First");
		expect((history.messages as Array<{ content: string }>)[1]?.content).toBe("Second");
		expect(history.total_messages).toBe(2);
		expect(history.has_more).toBe(false);
		expect(history.cursor).toBeNull();

		client.close();
		await runtime.close();
	});

	it("sends at most 100 recent messages in message_history on join (User 2026-08-01: 10→100)", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// 15 messages fit inside the 100-message snapshot window: the join
		// history carries them all, no paging advertised.
		for (let i = 1; i <= 15; i++) {
			await runtime.submitUserPersonaMessage(`Message ${i}`);
		}

		const { client, messageHistory } = await joinCharacter(runtime, "session-1", "dev");
		const messages = messageHistory.messages as Array<{ sequence: number }>;
		expect(messages).toHaveLength(15);
		expect(messages[0]?.sequence).toBe(1);
		expect(messages[14]?.sequence).toBe(15);
		expect(messageHistory.total_messages).toBe(15);
		expect(messageHistory.has_more).toBe(false);
		expect(messageHistory.cursor).toBeNull();

		client.close();
		await runtime.close();
	});

	it("pages beyond the 100-message snapshot window on join", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// 105 messages exceed the 100-message window: the snapshot is the
		// newest 100 (sequences 6..105), paging advertised for the rest.
		for (let i = 1; i <= 105; i++) {
			await runtime.submitUserPersonaMessage(`Message ${i}`);
		}

		const { client, messageHistory } = await joinCharacter(runtime, "session-2", "dev");
		const messages = messageHistory.messages as Array<{ sequence: number }>;
		expect(messages).toHaveLength(100);
		expect(messages[0]?.sequence).toBe(6);
		expect(messages[99]?.sequence).toBe(105);
		expect(messageHistory.total_messages).toBe(105);
		expect(messageHistory.has_more).toBe(true);
		expect(typeof messageHistory.cursor).toBe("string");

		client.close();
		await runtime.close();
	});

	it("pages older history with an opaque cursor and keeps cursor position stable", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// 105 messages exceed the 100-message join window: paging is
		// advertised and older history is reachable through the cursor.
		for (let i = 1; i <= 105; i++) {
			await runtime.submitUserPersonaMessage(`Message ${i}`);
		}

		const { client, messageHistory } = await joinCharacter(runtime, "session-1", "dev");
		expect(typeof messageHistory.cursor).toBe("string");

		// Request the page before the initial 100-message batch: sequences
		// 1..5 are older than the join window (6..105) and reachable via the
		// cursor, one 10-message page at a time.
		client.send(JSON.stringify({ id: "4", type: "get_message_history", cursor: messageHistory.cursor }));
		const firstPage = await waitForMessage(client, "response");
		expect(firstPage.command).toBe("get_message_history");
		expect(firstPage.success).toBe(true);
		const data = firstPage.data as Record<string, unknown>;
		const olderMessages = (data.messages as Array<{ sequence: number }>) ?? [];
		expect(olderMessages.map((m) => m.sequence)).toEqual([1, 2, 3, 4, 5]);
		expect(data.cursor).toBeNull();
		expect(data.has_more).toBe(false);
		expect(data.total_messages).toBe(105);

		// New messages after the cursor do not shift the page boundary
		await runtime.submitUserPersonaMessage("Message 106");
		client.send(JSON.stringify({ id: "5", type: "get_message_history", cursor: messageHistory.cursor }));
		const secondPage = await waitForMessage(client, "response");
		const secondData = secondPage.data as Record<string, unknown>;
		const secondMessages = (secondData.messages as Array<{ sequence: number }>) ?? [];
		expect(secondMessages.map((m) => m.sequence)).toEqual([1, 2, 3, 4, 5]);
		expect(secondData.total_messages).toBe(106);

		client.close();
		await runtime.close();
	});

	it("returns empty history for an empty group chat", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		const { client, messageHistory } = await joinCharacter(runtime, "session-1", "dev");
		expect(messageHistory.messages).toEqual([]);
		expect(messageHistory.cursor).toBeNull();
		expect(messageHistory.has_more).toBe(false);
		expect(messageHistory.total_messages).toBe(0);

		// Explicit history request on an empty group chat
		client.send(JSON.stringify({ id: "4", type: "get_message_history" }));
		const response = await waitForMessage(client, "response");
		expect(response.command).toBe("get_message_history");
		expect(response.success).toBe(true);
		const data = response.data as Record<string, unknown>;
		expect(data.messages).toEqual([]);
		expect(data.cursor).toBeNull();
		expect(data.has_more).toBe(false);
		expect(data.total_messages).toBe(0);

		client.close();
		await runtime.close();
	});

	it("returns only the current group chat file for get_chat_history_file", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		const { client } = await joinCharacter(runtime, "session-1", "dev");

		// Not started yet: no JSONL file exists, so the request must fail
		client.send(JSON.stringify({ id: "4", type: "get_chat_history_file" }));
		const emptyResponse = await waitForMessage(client, "response");
		expect(emptyResponse.command).toBe("get_chat_history_file");
		expect(emptyResponse.success).toBe(false);

		// Start the group chat and request the file path
		await runtime.submitUserPersonaMessage("First");
		client.send(JSON.stringify({ id: "5", type: "get_chat_history_file" }));
		const response = await waitForMessage(client, "response");
		expect(response.command).toBe("get_chat_history_file");
		expect(response.success).toBe(true);
		const data = response.data as { path: string };
		expect(data.path).toBeTruthy();
		expect(data.path.endsWith(`${runtime.state.groupChat.groupChatId}.jsonl`)).toBe(true);
		const fileExists = await readFile(data.path, "utf8").then(
			() => true,
			() => false,
		);
		expect(fileExists).toBe(true);

		// A connection that never completed character_ready is rejected
		const stranger = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(stranger);
		stranger.send(JSON.stringify({ id: "1", type: "join_group_chat", session_id: "session-9" }));
		await waitForMessage(stranger, "response");
		stranger.send(JSON.stringify({ id: "2", type: "get_chat_history_file" }));
		const rejected = await waitForMessage(stranger, "response");
		expect(rejected.success).toBe(false);

		stranger.close();
		client.close();
		await runtime.close();
	});

	it("resumes a group chat rebuilding name, settings, round, and sequence", async () => {
		const root = await createTemporaryDirectory();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const characters = [
			{
				characterId: "dev",
				name: "Developer",
				description: "Writes code",
				path: "/chars/dev.md",
				prompt: "You are a developer.",
			},
		];

		const original = await CreatorRuntime.startNew({ cwd, agentDir, characters });
		await original.setName("  Architecture\nReview  ");
		await original.setMaxMessages(5);
		await original.submitUserPersonaMessage("First");
		await original.submitUserPersonaMessage("Second");
		const { client } = await joinCharacter(original, "session-1", "dev");
		client.send(JSON.stringify({ id: "4", type: "speak", content: "My reply" }));
		await waitForMessage(client, "response");
		client.close();
		await original.close();

		const [sessionFile] = await jsonlFilesUnder(agentDir);
		expect(sessionFile).toBeDefined();
		if (!sessionFile) return;
		const sessionPath = join(agentDir, sessionFile);

		const resumed = await CreatorRuntime.resume({ cwd, agentDir, sessionPath, characters });
		expect(resumed.state.groupChat.groupChatId).toBe(original.state.groupChat.groupChatId);
		expect(resumed.state.groupChat.createdAt).toBe(original.state.groupChat.createdAt);
		expect(resumed.state.groupChat.name).toBe("Architecture Review");
		expect(resumed.state.groupChat.groupMaxMessages).toBe(5);
		expect(resumed.state.round).toEqual({ roundMaxMessages: 5, usedMessages: 1 });
		expect(resumed.state.nextSequence).toBe(3);
		expect(resumed.activeDescriptor.instanceId).not.toBe(original.activeDescriptor.instanceId);
		expect(resumed.activeDescriptor.port).not.toBe(original.activeDescriptor.port);
		expect(resumed.activeDescriptor.name).toBe("Architecture Review");
		// started_at reflects the resumed instance start, not the original creation time
		expect(resumed.activeDescriptor.startedAt).not.toBe(original.state.groupChat.createdAt);
		// Member connections are not restored
		expect(resumed.state.onlineCharacters.size).toBe(0);

		// The resumed runtime continues appending with the next sequence
		await resumed.submitUserPersonaMessage("Third");
		expect(resumed.state.nextSequence).toBe(4);
		expect(resumed.state.round?.roundMaxMessages).toBe(5);
		expect(resumed.state.round?.usedMessages).toBe(0);
		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");
		const lastEntry = JSON.parse(lines[lines.length - 1] as string) as { details: { sequence: number } };
		expect(lastEntry.details.sequence).toBe(4);

		// A new Character receives the disk-rebuilt history on join
		const joined = await joinCharacter(resumed, "session-2", "dev");
		const historyMessages = (joined.messageHistory.messages as Array<{ sequence: number; content: string }>) ?? [];
		expect(joined.messageHistory.total_messages).toBe(4);
		expect(historyMessages.map((m) => m.sequence)).toEqual([1, 2, 3, 4]);
		joined.client.close();

		await resumed.close();
	});

	it("rejects resuming an already active group chat", async () => {
		const root = await createTemporaryDirectory();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const original = await CreatorRuntime.startNew({ cwd, agentDir });
		await original.submitUserPersonaMessage("Hello");

		const [sessionFile] = await jsonlFilesUnder(agentDir);
		expect(sessionFile).toBeDefined();
		if (!sessionFile) return;
		const sessionPath = join(agentDir, sessionFile);

		await expect(CreatorRuntime.resume({ cwd, agentDir, sessionPath })).rejects.toThrow(
			/already active|active group chat/i,
		);

		await original.close();
	});

	it("rejects resuming a session file that does not exist", async () => {
		const root = await createTemporaryDirectory();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");

		await expect(
			CreatorRuntime.resume({ cwd, agentDir, sessionPath: join(agentDir, "chats", "missing.jsonl") }),
		).rejects.toThrow(/does not exist/i);
	});

	it("rejects resuming a zero-byte session file", async () => {
		const root = await createTemporaryDirectory();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const sessionDir = join(agentDir, "tavern", "chats");
		await mkdir(sessionDir, { recursive: true });
		const emptyPath = join(sessionDir, "empty.jsonl");
		await writeFile(emptyPath, "");

		// SessionManager.open() would mint a random new session id for an empty
		// file; the resume guard must reject it before any descriptor is published.
		await expect(CreatorRuntime.resume({ cwd, agentDir, sessionPath: emptyPath })).rejects.toThrow(/empty/i);
	});
});

describe("CreatorRuntime lifecycle alignment (M5)", () => {
	it("keeps a persisted speak even when its response cannot be delivered (BC-10)", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{ characterId: "dev", name: "Dev", description: "", path: "/x.md", prompt: "" },
				{ characterId: "qa", name: "QA", description: "", path: "/y.md", prompt: "" },
			],
		});
		const { client: memberA } = await joinCharacter(runtime, "session-a", "dev");
		const { client: memberB } = await joinCharacter(runtime, "session-b", "qa");

		// Register the round-start listener before submitting so the frame is
		// consumed even if ws dispatches it a tick late.
		const roundStartPromise = waitForMessage(memberB, "group_chat_update");
		await runtime.submitUserPersonaMessage("Round start");
		const roundStartNotification = await roundStartPromise;
		expect((roundStartNotification.preview_messages as Record<string, unknown>[]).at(-1)?.content).toBe("Round start");

		// The failing member's socket can no longer deliver anything — including
		// the speak response (stand-in for a response send timeout).
		const failingSocket = runtime.connections.get("session-a");
		expect(failingSocket).toBeDefined();
		if (!failingSocket) return;
		vi.spyOn(failingSocket, "send").mockImplementation(() => {
			throw new Error("socket timeout");
		});

		const broadcastPromise = waitForMessage(memberB, "group_chat_update");
		memberA.send(JSON.stringify({ id: "s1", type: "speak", content: "committed anyway" }));

		// The committed message is broadcast to the healthy member…
		const broadcast = await broadcastPromise;
		const preview = broadcast.preview_messages as Record<string, unknown>[];
		expect(preview.at(-1)?.content).toBe("committed anyway");
		expect(preview.at(-1)?.sequence).toBe(2);
		// …and the session file keeps the persisted message (no rollback).
		const [sessionFile] = await jsonlFilesUnder(join(root, "agent"));
		expect(sessionFile).toBeDefined();
		if (sessionFile) {
			const contents = await readFile(join(root, "agent", sessionFile), "utf8");
			expect(contents).toContain("committed anyway");
		}

		await runtime.close();
	});

	it("drains in-flight operations before completing close (BC-7)", async () => {
		const root = await createTemporaryDirectory();
		let releaseAppend: () => void = () => undefined;
		let gate = Promise.resolve();
		let gated = false;
		const runtime = await CreatorRuntime.startNew(
			{ cwd: join(root, "project"), agentDir: join(root, "agent") },
			{
				writeFile: async (path, data) => {
					if (!gated) {
						gated = true;
						gate = new Promise<void>((resolve) => {
							releaseAppend = resolve;
						});
						await gate;
					}
					await writeFile(path, data);
				},
				drainTimeoutMs: 500,
			},
		);

		// The first persist is gated inside the runtime queue.
		const submitPromise = runtime.submitUserPersonaMessage("Hello");
		await vi.waitFor(() => expect(gated).toBe(true));

		let closeSettled = false;
		const closePromise = runtime.close().then((result) => {
			closeSettled = true;
			return result;
		});

		// close must wait for the in-flight task instead of interleaving with it.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(closeSettled).toBe(false);

		releaseAppend();
		const result = await closePromise;
		await submitPromise;
		expect(result.timedOut).toBe(false);

		// The message was persisted, and close still completed all local cleanup.
		expect(await jsonlFilesUnder(join(root, "agent"))).toHaveLength(1);
		expect(await readActiveDescriptor(runtime.activeDescriptorPath)).toBeNull();
		expect(runtime.webSocketServer.address()).toBeNull();
	});

	it("force-completes local cleanup when the queue never drains (BC-7)", async () => {
		const root = await createTemporaryDirectory();
		let gated = false;
		const runtime = await CreatorRuntime.startNew(
			{ cwd: join(root, "project"), agentDir: join(root, "agent") },
			{
				writeFile: async (path, data) => {
					if (!gated) {
						gated = true;
						await new Promise(() => undefined); // never resolves
					}
					await writeFile(path, data);
				},
				drainTimeoutMs: 50,
			},
		);

		void runtime.submitUserPersonaMessage("Hello");
		await vi.waitFor(() => expect(gated).toBe(true));

		const result = await runtime.close();
		expect(result.timedOut).toBe(true);

		// Local cleanup completes regardless: descriptor removed, server closed.
		expect(await readActiveDescriptor(runtime.activeDescriptorPath)).toBeNull();
		expect(runtime.webSocketServer.address()).toBeNull();
	});

	it("returns the same close result for concurrent close calls", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		const [first, second, third] = await Promise.all([runtime.close(), runtime.close(), runtime.close()]);
		expect(first).toBe(second);
		expect(second).toBe(third);
		expect(first.timedOut).toBe(false);
		expect(first.errors).toEqual([]);
	});

	it("keeps a responsive member online across heartbeat cycles", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew(
			{
				cwd: join(root, "project"),
				agentDir: join(root, "agent"),
				characters: [{ characterId: "dev", name: "Dev", description: "", path: "/x.md", prompt: "" }],
			},
			{ heartbeatIntervalMs: 30, heartbeatTimeoutMs: 120 },
		);
		await joinCharacter(runtime, "session-1", "dev");

		// Several ping/pong cycles with an auto-responding client.
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(runtime.state.onlineCharacters.has("session-1")).toBe(true);
		expect(runtime.connections.has("session-1")).toBe(true);
		await runtime.close();
	});

	it("cleans up a member that never responds to heartbeat pings", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew(
			{
				cwd: join(root, "project"),
				agentDir: join(root, "agent"),
				characters: [
					{ characterId: "dev", name: "Dev", description: "", path: "/x.md", prompt: "" },
					{ characterId: "qa", name: "QA", description: "", path: "/y.md", prompt: "" },
				],
			},
			{ heartbeatIntervalMs: 30, heartbeatTimeoutMs: 120 },
		);
		const { client: healthy } = await joinCharacter(runtime, "session-healthy", "dev");
		await joinCharacter(runtime, "session-dead", "qa", { autoPong: false });

		// The dead member is cleaned up via the unified disconnected path.
		const left = await waitForMessage(healthy, "character_left");
		expect(left.reason).toBe("disconnected");
		expect(runtime.state.onlineCharacters.has("session-dead")).toBe(false);
		expect(runtime.connections.has("session-dead")).toBe(false);
		expect(runtime.state.onlineCharacters.has("session-healthy")).toBe(true);
		await runtime.close();
	});

	it("cleans up a member whose socket send fails during broadcast (BC-6)", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew(
			{
				cwd: join(root, "project"),
				agentDir: join(root, "agent"),
				characters: [
					{ characterId: "dev", name: "Dev", description: "", path: "/x.md", prompt: "" },
					{ characterId: "qa", name: "QA", description: "", path: "/y.md", prompt: "" },
				],
			},
			{ heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 120_000 },
		);
		await joinCharacter(runtime, "session-a", "dev");
		const { client: memberB } = await joinCharacter(runtime, "session-b", "qa");

		const failingSocket = runtime.connections.get("session-a");
		expect(failingSocket).toBeDefined();
		if (!failingSocket) return;
		vi.spyOn(failingSocket, "send").mockImplementation(() => {
			throw new Error("socket failure");
		});

		const leftPromise = waitForMessage(memberB, "character_left");
		await runtime.submitUserPersonaMessage("Hello");
		// memberB still receives the broadcast…
		expect(await waitForMessage(memberB, "group_chat_update")).toBeDefined();
		// …and then the failed member's departure.
		const left = await leftPromise;
		expect(left.reason).toBe("disconnected");
		expect(runtime.connections.has("session-a")).toBe(false);
		expect(runtime.state.onlineCharacters.has("session-a")).toBe(false);
		expect(runtime.state.onlineCharacters.has("session-b")).toBe(true);
		await runtime.close();
	});

	it("detaches for reload, buffers window frames, and takes over cleanly (BC-8)", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{ characterId: "dev", name: "Dev", description: "", path: "/x.md", prompt: "" },
				{ characterId: "qa", name: "QA", description: "", path: "/y.md", prompt: "" },
			],
		});
		const { client: memberA } = await joinCharacter(runtime, "session-a", "dev");
		const { client: memberB } = await joinCharacter(runtime, "session-b", "qa");
		await runtime.submitUserPersonaMessage("Hello"); // starts the round

		// A connection that never completes character_ready.
		const pendingClient = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(pendingClient);
		pendingClient.send(JSON.stringify({ id: "1", type: "join_group_chat", session_id: "session-pending" }));
		await waitForMessage(pendingClient, "response");

		const handoff = await runtime.detachForReload("pi-session-1");
		expect(handoff.connections.size).toBe(2);
		expect(handoff.bufferedFrames.size).toBe(0);

		// The pending (not-yet-ready) connection is released and closed.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(pendingClient.readyState).toBe(WebSocket.CLOSED);
		// Stable members stay connected.
		expect(memberA.readyState).toBe(WebSocket.OPEN);
		expect(memberB.readyState).toBe(WebSocket.OPEN);
		expect(runtime.state.onlineCharacters.size).toBe(2);

		// A reload-window speak is buffered, not processed yet.
		memberA.send(JSON.stringify({ id: "r1", type: "speak", content: "During reload" }));
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(handoff.bufferedFrames.get("session-a")?.length).toBe(1);

		const taken = await CreatorRuntime.takeHandoff(handoff);
		expect(taken.activeDescriptor.port).toBe(runtime.activeDescriptor.port);
		expect(taken.state.groupChat.groupChatId).toBe(runtime.state.groupChat.groupChatId);
		expect(taken.state.onlineCharacters.has("session-a")).toBe(true);
		expect(taken.state.onlineCharacters.has("session-b")).toBe(true);

		// The buffered speak was replayed: memberB sees the notification and
		// its preview carries the message.
		// (User Persona messages do not consume round quota, so the speak is usedMessages 1.)
		const publicMessage = await waitForMessage(memberB, "group_chat_update");
		expect((publicMessage.preview_messages as Record<string, unknown>[]).at(-1)?.content).toBe("During reload");
		expect(taken.state.round?.usedMessages).toBe(1);

		// The taken runtime serves new frames and owns the descriptor.
		memberB.send(JSON.stringify({ id: "r2", type: "speak", content: "After reload" }));
		const afterReload = await waitForMessage(memberA, "group_chat_update");
		expect((afterReload.preview_messages as Record<string, unknown>[]).at(-1)?.content).toBe("After reload");

		await taken.close();
		expect(await readActiveDescriptor(taken.activeDescriptorPath)).toBeNull();
	});

	it("close after detach rejects: close and detach are mutually exclusive (A.2 guard)", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});
		const handoff = await runtime.detachForReload("pi-session-a2");

		// A.2（Arch）：close() 与 detachForReload() 是互斥路径——守卫读实时
		// lifecycle（readLifecycle getter），值拷贝会令守卫永不触发。
		await expect(runtime.close()).rejects.toThrow("has been detached for reload");
		// 幂等：再次 close 仍拒绝，不产生半关闭状态。
		await expect(runtime.close()).rejects.toThrow("has been detached for reload");

		// Handoff 不受影响，通过接管实例正常清理。
		const taken = await CreatorRuntime.takeHandoff(handoff);
		await taken.close();
	});
});

describe("ISSUE-013 B2: speak staleness check", () => {
	it("rejects a stale speak with missing_sequences and no quota/hand side effects", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		const { client } = await joinCharacter(runtime, "session-stale", "dev");
		// Two user persona messages: latest sequence is 2.
		await runtime.submitUserPersonaMessage("one");
		await runtime.submitUserPersonaMessage("two");

		// Speak with a stale based_on_sequence (0 < latest 2).
		client.send(JSON.stringify({ id: "s1", type: "speak", content: "Stale reply", based_on_sequence: 0 }));
		const staleResponse = await waitForMessage(client, "response");

		expect(staleResponse.command).toBe("speak");
		expect(staleResponse.success).toBe(true);
		expect(staleResponse.data).toEqual({
			published: false,
			reason: "stale",
			missing_sequences: { from: 1, to: 2 },
			round: { round_max_messages: 20, used_messages: 0, remaining_messages: 20 },
		});
		// B4: no quota consumed by the stale speak.
		expect(runtime.state.round?.usedMessages).toBe(0);
		// stale does not raise the hand (distinct from round_limit_reached).
		expect(runtime.state.onlineCharacters.get("session-stale")?.handRaised).toBe(false);

		// The stale message was not published: next sequence is still 3.
		client.send(JSON.stringify({ id: "s2", type: "speak", content: "Fresh reply", based_on_sequence: 2 }));
		const freshResponse = await waitForMessage(client, "response");
		expect(freshResponse.data).toMatchObject({
			published: true,
			sequence: 3,
			// B6: the success response carries the new latest for the client to sync.
			latest_sequence: 3,
		});
		expect(runtime.state.round?.usedMessages).toBe(1);

		client.close();
		await runtime.close();
	});

	it("accepts speaks when based_on_sequence is current or omitted (legacy)", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		const { client } = await joinCharacter(runtime, "session-legacy", "dev");
		await runtime.submitUserPersonaMessage("one"); // latest = 1

		// Legacy client omits the field: staleness check skipped, published.
		client.send(JSON.stringify({ id: "l1", type: "speak", content: "Legacy reply" }));
		const legacyResponse = await waitForMessage(client, "response");
		expect(legacyResponse.data).toMatchObject({ published: true, sequence: 2 });

		// Current client sends based_on_sequence == latest: published.
		client.send(JSON.stringify({ id: "l2", type: "speak", content: "Current reply", based_on_sequence: 2 }));
		const currentResponse = await waitForMessage(client, "response");
		expect(currentResponse.data).toMatchObject({ published: true, sequence: 3 });

		// A new user message arrives (seq 4) — now a behind speak is stale
		// against another sender (the server excludes the requester's own
		// messages, so only other senders count toward staleness). The new
		// user message also opens a fresh round (used=0); the stale refusal
		// consumes no quota of it (B4).
		await runtime.submitUserPersonaMessage("two");

		// Boundary: based_on_sequence behind another sender's latest is stale.
		client.send(JSON.stringify({ id: "l3", type: "speak", content: "Behind reply", based_on_sequence: 2 }));
		const behindResponse = await waitForMessage(client, "response");
		expect(behindResponse.data).toEqual({
			published: false,
			reason: "stale",
			missing_sequences: { from: 3, to: 4 },
			round: { round_max_messages: 20, used_messages: 0, remaining_messages: 20 },
		});

		client.close();
		await runtime.close();
	});
});

async function jsonlFilesUnder(root: string): Promise<string[]> {
	try {
		const entries = await readdir(root, { recursive: true });
		return entries.filter((entry) => entry.endsWith(".jsonl"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

async function expectConnectionRefused(port: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const socket = connect({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			reject(new Error(`Unexpectedly connected to closed port ${port}`));
		});
		socket.once("error", () => resolve());
	});
}

function waitForOpen(socket: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.once("open", () => resolve());
		socket.once("error", (error) => reject(error));
	});
}

function waitForMessage(socket: WebSocket, expectedType: string): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expectedType}`)), 5000);
		const onMessage = (data: WebSocket.RawData) => {
			const message = JSON.parse(data.toString()) as Record<string, unknown>;
			if (message.type === expectedType) {
				clearTimeout(timeout);
				socket.off("message", onMessage);
				resolve(message);
			}
		};
		socket.on("message", onMessage);
	});
}

async function joinCharacter(
	runtime: CreatorRuntime,
	sessionId: string,
	characterId: string,
	options: { autoPong?: boolean } = {},
): Promise<{ client: WebSocket; messageHistory: Record<string, unknown> }> {
	const client = new WebSocket(
		`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		{ autoPong: options.autoPong ?? true },
	);
	await waitForOpen(client);
	client.send(JSON.stringify({ id: "1", type: "join_group_chat", session_id: sessionId }));
	await waitForMessage(client, "response");
	client.send(JSON.stringify({ id: "2", type: "claim_character", character_id: characterId }));
	await waitForMessage(client, "response");
	client.send(JSON.stringify({ id: "3", type: "character_ready" }));
	// Register the message_history listener BEFORE awaiting the response: the
	// response and message_history arrive back-to-back, and a listener added
	// after the response resolves would miss the history frame.
	const historyPromise = waitForMessage(client, "message_history");
	await waitForMessage(client, "response");
	const messageHistory = await historyPromise;
	return { client, messageHistory };
}
