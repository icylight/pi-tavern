import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { CreatorRuntime } from "../../src/creator/creator-runtime.js";
import { readActiveDescriptor } from "../../src/discovery/active-descriptor.js";

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
		expect(runtime.state.groupChat.groupMaxMessages).toBe(10);
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
			roundMaxMessages: 10,
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
		expect(settingsEntry.data).toEqual({ group_max_messages: 10 });

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
		expect(typeof details.timestamp).toBe("string");
		expect(typeof publicEntry.timestamp).toBe("string");
		expect(details.round).toEqual({
			round_max_messages: 10,
			used_messages: 0,
			remaining_messages: 10,
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
		expect(runtime.state.round?.roundMaxMessages).toBe(10);
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
		expect(runtime.state.round?.roundMaxMessages).toBe(10);
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
		expect(runtime.state.round?.roundMaxMessages).toBe(10);

		// Change the limit and create a new round
		await runtime.setMaxMessages(5);
		// Current round is unaffected by setMaxMessages
		expect(runtime.state.round?.roundMaxMessages).toBe(10);

		await runtime.submitUserPersonaMessage("Second");
		expect(runtime.state.round?.roundMaxMessages).toBe(5);
		expect(runtime.state.round?.usedMessages).toBe(0);

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
		expect(runtime.state.round).toEqual({ roundMaxMessages: 10, usedMessages: 0 });
		expect(await jsonlFilesUnder(join(root, "agent"))).toHaveLength(1);

		await runtime.close();
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
			sequence: number;
			timestamp: string;
		}
		const broadcastPromise = new Promise<PublicMessage>((resolve) => {
			const onMessage = (data: WebSocket.RawData) => {
				const message = JSON.parse(data.toString()) as PublicMessage;
				if (message.type === "public_message") {
					client.off("message", onMessage);
					resolve(message);
				}
			};
			client.on("message", onMessage);
		});

		await runtime.submitUserPersonaMessage("Hello everyone");

		const publicMessage = await broadcastPromise;

		// Verify the client received the public_message broadcast
		expect(publicMessage.content).toBe("Hello everyone");
		expect(publicMessage.sender).toEqual({ type: "user_persona" });
		expect(publicMessage.round).toEqual({ round_max_messages: 10, used_messages: 0, remaining_messages: 10 });
		expect(typeof publicMessage.event_id).toBe("string");
		expect(typeof publicMessage.sequence).toBe("number");
		expect(typeof publicMessage.timestamp).toBe("string");

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
				if (msg.type === "public_message") {
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

		// Sender also receives the public_message broadcast (broadcast includes all online members)
		const senderEcho = receivedMessages.find((m) => m.type === "public_message" && m.content === "My public reply");
		expect(senderEcho).toBeDefined();

		expect(speakResponse.command).toBe("speak");
		expect(speakResponse.success).toBe(true);
		expect(speakResponse.data).toEqual({
			published: true,
			event_id: expect.any(String) as string,
			sequence: expect.any(Number) as number,
			round: { round_max_messages: 10, used_messages: 1, remaining_messages: 9 },
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

		// Broadcast timestamp matches the persisted entry timestamp
		expect((senderEcho as Record<string, unknown>).timestamp).toBe(publicEntry.timestamp);
		expect(publicEntry.details.round).toEqual({ round_max_messages: 10, used_messages: 1, remaining_messages: 9 });
		expect(typeof publicEntry.details.sequence).toBe("number");
		expect(typeof publicEntry.details.timestamp).toBe("string");
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

		// Simulate append failure — leaf is now polluted
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
