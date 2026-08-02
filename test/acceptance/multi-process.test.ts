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

		// The descriptor lives under agentDir/tavern/<project-key>/active.
		const descriptorPath = join(
			getGroupChatProjectDirectory(agentDir, projectDir),
			"active",
			`${descriptor.groupChatId}.json`,
		);
		expect(await readFile(descriptorPath, "utf8")).toContain(descriptor.groupChatId);

		// ── Characters 1 & 2 (two real pi processes, concurrent join) ────────
		// Both discover the same descriptor and claim their persona at the
		// same time: the creator must serialize the joins and admit both.
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

		// The characters are officially online: creator rendered "3 人在线".
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[] | undefined)?.[0] === "3 人在线",
		);
		// Both characters rendered their persona status.
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

		// The group chat history file only appears after the first public
		// message (design: empty group chats leave no JSONL behind).
		const chatsDir = getGroupChatSessionDirectory(agentDir, projectDir);
		const files = await (await import("node:fs/promises")).readdir(chatsDir).catch(() => []);
		expect(files).toEqual([]);

		// ── Clean leave ────────────────────────────────────────────────────
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
