import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	type ActiveGroupChatDescriptor,
	getActiveDescriptorDirectory,
	publishActiveDescriptor,
} from "../../../../src/data/discovery/active-descriptor.js";
import { discoverGroupChats } from "../../../../src/data/discovery/discover-group-chats.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-discovery-unit-"));
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

const allAliveDependencies = {
	isProcessAlive: (): boolean => true,
	verifyDescriptor: async (): Promise<boolean> => true,
};

afterEach(async () => {
	while (temporaryDirectories.length > 0) {
		const directory = temporaryDirectories.pop();
		if (directory) await rm(directory, { recursive: true, force: true });
	}
});

describe("discoverGroupChats", () => {
	it("active 目录不存在或为空时返回空列表（ENOENT 分支）", async () => {
		const agentDir = await createTemporaryDirectory();
		const result = await discoverGroupChats({ agentDir, cwd: join(agentDir, "nonexistent") }, allAliveDependencies);
		expect(result).toEqual([]);
	});

	it("返回存活且校验通过的描述符（按文件名排序），跳过非 json 与其他 cwd 的描述符", async () => {
		const agentDir = await createTemporaryDirectory();
		const cwd = join(agentDir, "project");
		await publishActiveDescriptor(agentDir, createDescriptor(cwd, { groupChatId: "beta", instanceId: "inst-b" }));
		await publishActiveDescriptor(agentDir, createDescriptor(cwd, { groupChatId: "alpha", instanceId: "inst-a" }));
		await publishActiveDescriptor(
			agentDir,
			createDescriptor(join(agentDir, "other"), { groupChatId: "gamma", instanceId: "inst-g" }),
		);
		const activeDirectory = getActiveDescriptorDirectory(agentDir, cwd);
		await writeFile(join(activeDirectory, "ignored.txt"), "not a descriptor");

		const result = await discoverGroupChats({ agentDir, cwd }, allAliveDependencies);

		expect(result.map((descriptor) => descriptor.groupChatId)).toEqual(["alpha", "beta"]);
	});

	it("进程已死或校验失败的描述符被清理且不进候选", async () => {
		const agentDir = await createTemporaryDirectory();
		const cwd = join(agentDir, "project");
		await publishActiveDescriptor(agentDir, createDescriptor(cwd, { groupChatId: "dead", instanceId: "inst-dead" }));
		await publishActiveDescriptor(agentDir, createDescriptor(cwd, { groupChatId: "rejected", instanceId: "inst-rej" }));
		await publishActiveDescriptor(
			agentDir,
			createDescriptor(cwd, { groupChatId: "live", instanceId: "inst-live", pid: 1234567 }),
		);

		const result = await discoverGroupChats(
			{ agentDir, cwd },
			{
				isProcessAlive: (pid: number): boolean => pid !== process.pid,
				verifyDescriptor: async (descriptor: ActiveGroupChatDescriptor): Promise<boolean> =>
					descriptor.groupChatId !== "rejected",
			},
		);

		expect(result.map((descriptor) => descriptor.groupChatId)).toEqual(["live"]);
		const remainingFiles = await readdir(getActiveDescriptorDirectory(agentDir, cwd));
		expect(remainingFiles.sort()).toEqual(["live.json"]);
	});
});
