import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	getGroupChatProjectDirectory,
	getGroupChatSessionDirectory,
} from "../../src/data/discovery/active-descriptor.js";
import { PiProcess } from "./pi-process.js";

describe("acceptance: multiple real pi processes discover and join the same group chat", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	const processes: PiProcess[] = [];

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-tavern-acc-"));
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
			JSON.stringify({ characters: ["characters/architect.md", "characters/reviewer.md"] }),
		);
	});

	afterAll(async () => {
		for (const process_ of processes) {
			await process_.kill("SIGTERM");
		}
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
	});

	it("lets a second real pi discover and join the creator's group chat", async () => {
		// ── Creator ────────────────────────────────────────────────────────
		const creator = PiProcess.spawn({
			label: "creator",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator"),
			cwd: projectDir,
		});
		processes.push(creator);

		const descriptor = await creator.startGroupChat(projectDir, agentDir);
		expect(descriptor.host).toBe("127.0.0.1");
		expect(descriptor.port).toBeGreaterThan(0);
		expect(descriptor.cwd).toBe(resolve(projectDir));

		// 描述符位于 agentDir/tavern/<项目键>/active 下。
		const descriptorPath = join(
			getGroupChatProjectDirectory(agentDir, projectDir),
			"active",
			`${descriptor.groupChatId}.json`,
		);
		expect(await readFile(descriptorPath, "utf8")).toContain(descriptor.groupChatId);

		// ── 角色 1 与 2（两个真实 pi 进程，并发加入）────────
		// 两者发现同一描述符并同时认领各自 persona：
		// creator 必须串行化加入并同时接纳两者。
		const character = PiProcess.spawn({
			label: "character-1",
			agentDir,
			sessionDir: join(agentDir, "sessions", "character-1"),
			cwd: projectDir,
		});
		processes.push(character);
		const second = PiProcess.spawn({
			label: "character-2",
			agentDir,
			sessionDir: join(agentDir, "sessions", "character-2"),
			cwd: projectDir,
		});
		processes.push(second);
		await Promise.all([
			character.joinGroupChat(projectDir, agentDir),
			second.joinGroupChat(projectDir, agentDir, "Reviewer — Reviews designs"),
		]);

		// 角色已正式在线：creator 渲染出「3 人在线」。
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[] | undefined)?.[0] === "3 人在线",
		);
		// 两个角色都已渲染其 persona 状态。
		await character.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setStatus" &&
				typeof e.statusText === "string" &&
				e.statusText.includes("Tavern Character · Architect"),
		);
		await second.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setStatus" &&
				typeof e.statusText === "string" &&
				e.statusText.includes("Tavern Character · Reviewer"),
		);

		// 群聊历史文件仅在第一条公开消息后出现
		//（设计：空群聊不留下 JSONL）。
		const chatsDir = getGroupChatSessionDirectory(agentDir, projectDir);
		const files = await (await import("node:fs/promises")).readdir(chatsDir).catch(() => []);
		expect(files).toEqual([]);

		// ── 干净离开 ────────────────────────────────────────────────────
		await second.runCommand("/tavern-leave");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[] | undefined)?.[0] === "2 人在线",
		);
		await character.runCommand("/tavern-leave");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[] | undefined)?.[0] === "1 人在线",
		);
		await creator.runCommand("/tavern-leave");
	}, 120_000);
});
