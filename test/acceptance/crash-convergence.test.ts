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

		// Kill -9: no WebSocket close frame, no leave message.
		await character.kill("SIGKILL");

		// The creator converges via socket close / heartbeat and drops the member.
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[])?.[0] === "1 人在线",
			60_000,
		);
		// The creator is still serving.
		expect(creator.exited).toBe(false);

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

		// Kill the creator with no chance to broadcast group_chat_closed.
		await creator.kill("SIGKILL");

		// The character detects the dead connection and returns to idle (its
		// pi-tavern status is cleared), without hanging.
		await character.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setStatus" &&
				e.statusKey === "pi-tavern" &&
				e.statusText === undefined,
			60_000,
		);
		expect(character.exited).toBe(false);

		// The stale descriptor is cleaned up by the discovery flow on the next
		// run: a fresh pi that joins finds nothing and reports no candidates.
		const fresh = PiProcess.spawn({
			label: "fresh",
			agentDir,
			sessionDir: join(agentDir, "sessions", "fresh"),
			cwd: projectDir,
		});
		processes.push(fresh);
		await fresh.waitForTavernReady();
		await fresh.runCommand("/tavern-join");
		// With no candidates the join flow shows no select dialog; a notify
		// explains there is nothing to join.
		await fresh.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				typeof e.message === "string" &&
				e.message.includes("No active group chat found for this project"),
			60_000,
		);
		// The stale descriptor file was removed by the discovery flow.
		const { readdir } = await import("node:fs/promises");
		const { getGroupChatProjectDirectory } = await import("../../src/discovery/active-descriptor.js");
		const activeDir = join(getGroupChatProjectDirectory(agentDir, projectDir), "active");
		expect(await readdir(activeDir).catch(() => [])).toEqual([]);
	}, 120_000);
});
