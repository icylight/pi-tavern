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
		runtime.setMaxMessages(18);

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

		// Subsequent line is the public message entry
		const lastEntry = lines[lines.length - 1];
		expect(lastEntry).toBeDefined();
		const lastLine = JSON.parse(lastEntry as string);
		expect(lastLine.type).toBe("custom_message");
		expect(lastLine.customType).toBe("pi-tavern.public-message");
		expect(lastLine.content).toBe("Hello from user persona");
		expect(lastLine.display).toBe(true);
		expect(lastLine.details.sender).toEqual({ type: "user_persona" });
		expect(lastLine.details.round).toEqual({ roundMaxMessages: 10, usedMessages: 0 });

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
		const receivedMessages: unknown[] = [];
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.on("message", (data) => {
			receivedMessages.push(JSON.parse(data.toString()));
		});

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

		// Clear received messages to isolate the public_message broadcast
		receivedMessages.length = 0;

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
