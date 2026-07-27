import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	type ActiveGroupChatDescriptor,
	getActiveDescriptorPath,
	publishActiveDescriptor,
	readActiveDescriptor,
	removeOwnedActiveDescriptor,
	updateActiveDescriptorName,
} from "../../src/discovery/active-descriptor.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-descriptor-"));
	temporaryDirectories.push(directory);
	return directory;
}

function createDescriptor(cwd: string): ActiveGroupChatDescriptor {
	return {
		instanceId: "instance-1",
		groupChatId: "group-1",
		name: null,
		cwd,
		pid: 1234,
		host: "127.0.0.1",
		port: 54321,
		startedAt: "2026-07-27T00:00:00.000Z",
	};
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("active group chat descriptors", () => {
	it("publishes a complete snake_case descriptor and reads it back", async () => {
		const root = await createTemporaryDirectory();
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const descriptor = createDescriptor(cwd);

		const path = await publishActiveDescriptor(agentDir, descriptor);

		expect(path).toBe(getActiveDescriptorPath(agentDir, cwd, descriptor.groupChatId));
		expect(await readActiveDescriptor(path)).toEqual(descriptor);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			instance_id: "instance-1",
			group_chat_id: "group-1",
			name: null,
			cwd,
			pid: 1234,
			host: "127.0.0.1",
			port: 54321,
			started_at: "2026-07-27T00:00:00.000Z",
		});
	});

	it("uses exclusive publication for the same group chat", async () => {
		const root = await createTemporaryDirectory();
		const descriptor = createDescriptor(join(root, "project"));
		const agentDir = join(root, "agent");

		await publishActiveDescriptor(agentDir, descriptor);

		await expect(publishActiveDescriptor(agentDir, { ...descriptor, instanceId: "instance-2" })).rejects.toMatchObject({
			code: "EEXIST",
		});
		expect(
			(await readActiveDescriptor(getActiveDescriptorPath(agentDir, descriptor.cwd, descriptor.groupChatId)))
				?.instanceId,
		).toBe("instance-1");
	});

	it("updates and removes a descriptor only for its owning instance", async () => {
		const root = await createTemporaryDirectory();
		const descriptor = createDescriptor(join(root, "project"));
		const path = await publishActiveDescriptor(join(root, "agent"), descriptor);

		await expect(updateActiveDescriptorName(path, "instance-2", "Wrong owner")).rejects.toThrow("no longer owned");
		await updateActiveDescriptorName(path, descriptor.instanceId, "Architecture");
		expect((await readActiveDescriptor(path))?.name).toBe("Architecture");

		expect(await removeOwnedActiveDescriptor(path, "instance-2")).toBe(false);
		expect(await removeOwnedActiveDescriptor(path, descriptor.instanceId)).toBe(true);
		expect(await readActiveDescriptor(path)).toBeNull();
	});

	it("treats malformed descriptors as invalid", async () => {
		const root = await createTemporaryDirectory();
		const path = getActiveDescriptorPath(join(root, "agent"), join(root, "project"), "group-1");
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify({ group_chat_id: "group-1" }));

		expect(await readActiveDescriptor(path)).toBeNull();
	});
});
