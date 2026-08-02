import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import {
	type ActiveGroupChatDescriptor,
	publishActiveDescriptor,
	readActiveDescriptor,
} from "../../../../src/data/discovery/active-descriptor.js";
import { discoverGroupChats } from "../../../../src/data/discovery/discover-group-chats.js";

const temporaryDirectories: string[] = [];
const servers: WebSocketServer[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-discovery-"));
	temporaryDirectories.push(directory);
	return directory;
}

function createDescriptor(cwd: string, overrides: Partial<ActiveGroupChatDescriptor> = {}): ActiveGroupChatDescriptor {
	return {
		instanceId: "instance-1",
		groupChatId: "group-1",
		name: null,
		cwd,
		pid: process.pid,
		host: "127.0.0.1",
		port: 54321,
		startedAt: "2026-07-27T00:00:00.000Z",
		...overrides,
	};
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		),
	);
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("discoverGroupChats", () => {
	it("filters by canonical cwd, removes dead instances, and verifies live candidates", async () => {
		const root = await createTemporaryDirectory();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const live = createDescriptor(cwd);
		const stale = createDescriptor(cwd, {
			groupChatId: "group-stale",
			instanceId: "instance-stale",
			pid: 999_999,
		});
		const livePath = await publishActiveDescriptor(agentDir, live);
		const stalePath = await publishActiveDescriptor(agentDir, stale);

		const verifyDescriptor = vi.fn(async () => true);
		const candidates = await discoverGroupChats(
			{ agentDir, cwd: `${cwd}/nested/..` },
			{
				isProcessAlive: (pid) => pid === process.pid,
				verifyDescriptor,
			},
		);

		expect(candidates).toEqual([live]);
		expect(verifyDescriptor).toHaveBeenCalledWith(live);
		expect(await readActiveDescriptor(livePath)).toEqual(live);
		expect(await readActiveDescriptor(stalePath)).toBeNull();
	});

	it("ignores descriptors whose embedded cwd does not match the project", async () => {
		const root = await createTemporaryDirectory();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const descriptor = createDescriptor(cwd);
		const path = await publishActiveDescriptor(agentDir, descriptor);
		const json = JSON.parse(await readFile(path, "utf8"));
		json.cwd = join(root, "other-project");
		await writeFile(path, JSON.stringify(json));
		const verifyDescriptor = vi.fn(async () => true);

		expect(await discoverGroupChats({ agentDir, cwd }, { isProcessAlive: () => true, verifyDescriptor })).toEqual([]);
		expect(verifyDescriptor).not.toHaveBeenCalled();
	});

	it("verifies the descriptor through its identity-bound WebSocket path", async () => {
		const root = await createTemporaryDirectory();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const descriptor = createDescriptor(cwd);
		const server = await listenForDescriptor(descriptor);
		descriptor.port = (server.address() as AddressInfo).port;
		await publishActiveDescriptor(agentDir, descriptor);

		await expect(discoverGroupChats({ agentDir, cwd })).resolves.toEqual([descriptor]);
	});

	it("removes a descriptor when WebSocket identity verification fails", async () => {
		const root = await createTemporaryDirectory();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const descriptor = createDescriptor(cwd);
		const server = await listen("/another-group/another-instance");
		descriptor.port = (server.address() as AddressInfo).port;
		const path = await publishActiveDescriptor(agentDir, descriptor);

		await expect(discoverGroupChats({ agentDir, cwd })).resolves.toEqual([]);
		expect(await readActiveDescriptor(path)).toBeNull();
	});
});

async function listenForDescriptor(descriptor: ActiveGroupChatDescriptor): Promise<WebSocketServer> {
	return listen(`/${descriptor.groupChatId}/${descriptor.instanceId}`);
}

async function listen(path: string): Promise<WebSocketServer> {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path });
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});
	return server;
}
