import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PiProcess } from "./pi-process.js";

describe("acceptance: abnormal termination converges without manual intervention", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	const processes: PiProcess[] = [];

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-tavern-acc-crash-"));
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await mkdir(projectDir, { recursive: true });
		await writeFile(
			join(agentDir, "characters", "architect.md"),
			"---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt",
		);
		await writeFile(join(agentDir, "tavern.json"), JSON.stringify({ characters: ["characters/architect.md"] }));
	});

	afterAll(async () => {
		for (const process_ of processes) {
			await process_.kill("SIGKILL");
		}
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
	});

	it("converges when the character is killed: the creator drops the member", async () => {
		const creator = PiProcess.spawn({
			label: "creator",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator"),
			cwd: projectDir,
		});
		processes.push(creator);
		await creator.startGroupChat(projectDir, agentDir);

		const character = PiProcess.spawn({
			label: "character",
			agentDir,
			sessionDir: join(agentDir, "sessions", "character"),
			cwd: projectDir,
		});
		processes.push(character);
		await character.joinGroupChat(projectDir, agentDir);
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[])?.[0] === "2 人在线",
		);

		// kill -9：无 WebSocket 关闭帧、无离开消息。
		await character.kill("SIGKILL");

		// creator 经 socket 关闭/心跳收敛并移除该成员。
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[])?.[0] === "1 人在线",
			60_000,
		);
		// creator 仍在服务。
		expect(creator.exited).toBe(false);

		// 释放的槽位可复用：新角色可加入同一
		// 群聊而无需重启。
		const replacement = PiProcess.spawn({
			label: "replacement",
			agentDir,
			sessionDir: join(agentDir, "sessions", "replacement"),
			cwd: projectDir,
		});
		processes.push(replacement);
		await replacement.joinGroupChat(projectDir, agentDir);
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[])?.[0] === "2 人在线",
		);

		await creator.runCommand("/tavern-leave");
	}, 120_000);

	it("converges when the creator is killed: the character returns to idle", async () => {
		const creator = PiProcess.spawn({
			label: "creator-2",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator-2"),
			cwd: projectDir,
		});
		processes.push(creator);
		await creator.startGroupChat(projectDir, agentDir);

		const character = PiProcess.spawn({
			label: "character-2",
			agentDir,
			sessionDir: join(agentDir, "sessions", "character-2"),
			cwd: projectDir,
		});
		processes.push(character);
		await character.joinGroupChat(projectDir, agentDir);
		await character.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setStatus" &&
				typeof e.statusText === "string" &&
				e.statusText.includes("Tavern Character · Architect"),
		);

		// 杀死 creator，使其来不及广播 group_chat_closed。
		await creator.kill("SIGKILL");

		// 角色检测到死连接并回到空闲（其
		// pi-tavern 状态被清除），且不挂起。
		await character.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setStatus" &&
				e.statusKey === "pi-tavern" &&
				e.statusText === undefined,
			60_000,
		);
		expect(character.exited).toBe(false);

		// 过期描述符在下次运行时由发现流程清理：
		// 新 pi 加入时一无所获并报告无候选。
		const fresh = PiProcess.spawn({
			label: "fresh",
			agentDir,
			sessionDir: join(agentDir, "sessions", "fresh"),
			cwd: projectDir,
		});
		processes.push(fresh);
		await fresh.waitForTavernReady();
		await fresh.runCommand("/tavern-join");
		// 无候选时加入流程不显示选择对话框；以 notify
		// 说明没有可加入的群聊。
		await fresh.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				typeof e.message === "string" &&
				e.message.includes("No active group chat found for this project"),
			60_000,
		);
		// 过期描述符文件已被发现流程移除。
		const { readdir } = await import("node:fs/promises");
		const { getGroupChatProjectDirectory } = await import("../../src/data/discovery/active-descriptor.js");
		const activeDir = join(getGroupChatProjectDirectory(agentDir, projectDir), "active");
		expect(await readdir(activeDir).catch(() => [])).toEqual([]);
	}, 120_000);
});
