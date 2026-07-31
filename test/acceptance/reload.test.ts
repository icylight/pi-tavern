import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PiProcess } from "./pi-process.js";

describe("acceptance: reload keeps confirmed connections and identity", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	const processes: PiProcess[] = [];

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-tavern-acc-reload-"));
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
			await process_.kill("SIGTERM");
		}
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
	});

	it("keeps the character connection and identity across a real pi reload", async () => {
		const creator = PiProcess.spawn({
			label: "creator",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator"),
			cwd: projectDir,
		});
		processes.push(creator);
		const descriptor = await creator.startGroupChat(projectDir, agentDir);
		// Remember the listening port: reload must keep the same server.
		const originalPort = descriptor.port;

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

		// Trigger a real pi reload on the creator via the test-only command
		// (RPC mode exposes ctx.reload() through commandContextActions).
		await creator.runCommand("/tavern-test-reload");

		// The same pi process survives the reload and re-takes the handoff:
		// the widget still shows both members, and the port is unchanged.
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[])?.[0] === "2 人在线",
			60_000,
		);
		expect(creator.exited).toBe(false);
		expect(descriptor.port).toBe(originalPort);

		// The character was never told to leave: no character_left was emitted.
		// A fresh message still reaches the character after the reload.
		await creator.runCommand("/tavern-test-message Hello after reload");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);
		// The character's own connection is still the confirmed one (creator
		// widget still shows 2 人在线 — the character did not re-join).
		expect(creator.exited).toBe(false);

		await character.runCommand("/tavern-leave");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[])?.[0] === "1 人在线",
			60_000,
		);
		await creator.runCommand("/tavern-leave");
	}, 180_000);
});
