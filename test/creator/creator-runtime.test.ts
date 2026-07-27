import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
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
		expect(runtime.groupSessionManager.getSessionId()).toBe(runtime.state.groupChat.groupChatId);
		expect(runtime.groupSessionManager.getSessionFile()).toBeDefined();
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

		// Verify the public message entry is present
		const publicEntry = lines
			.map((l) => JSON.parse(l))
			.find((e: Record<string, unknown>) => e.type === "custom_message");
		expect(publicEntry).toBeDefined();
		expect(publicEntry.customType).toBe("pi-tavern.public-message");
		expect(publicEntry.content).toContain("Hello from user persona");
		expect(publicEntry.display).toBe(true);
		expect(publicEntry.details.sender).toEqual({ type: "user_persona" });
		expect(publicEntry.details.content).toBe("Hello from user persona");
		expect(publicEntry.details.round).toEqual({ round_max_messages: 10, used_messages: 0, remaining_messages: 10 });
		expect(typeof publicEntry.details.sequence).toBe("number");
		expect(typeof publicEntry.details.timestamp).toBe("string");

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

		// Send a speak message
		client.send(JSON.stringify({ id: "4", type: "speak", content: "My public reply" }));
		const speakResponse = await waitForMessage(client, "response");

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
		expect(publicEntry.details.round).toEqual({ round_max_messages: 10, used_messages: 1, remaining_messages: 9 });
		expect(typeof publicEntry.details.sequence).toBe("number");
		expect(typeof publicEntry.details.timestamp).toBe("string");
		expect(publicEntry.details.content).toBe("My public reply");

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
