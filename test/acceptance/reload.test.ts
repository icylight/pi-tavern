import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PiProcess, type RpcEvent } from "./pi-process.js";
import { joinCharacterWs } from "./ws-helper.js";

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

		// A raw WebSocket member holds a confirmed connection across the
		// reload: its socket stays open and keeps receiving broadcasts.
		const member = await joinCharacterWs(descriptor, "ws-session-reload", "characters/reviewer.md");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[])?.[0] === "3 人在线",
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
				(e.widgetLines as string[])?.[0] === "3 人在线",
			60_000,
		);
		expect(creator.exited).toBe(false);
		expect(descriptor.port).toBe(originalPort);

		// The character was never told to leave: no character_left was emitted.
		// A fresh message still reaches the members after the reload.
		await creator.runCommand("/tavern-test-message Hello after reload");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);
		// The raw member received the post-reload broadcast on its original
		// connection: the reloaded creator serves the same sockets. M7
		// (ISSUE-012): broadcasts are group_chat_update notifications; the
		// preview carries the new message.
		const delivered = await member.waitFor((m) => m.type === "group_chat_update", 30_000);
		expect((delivered.latest_sequence as number) ?? 0).toBeGreaterThan(0);
		const preview = delivered.preview_messages as Record<string, unknown>[];
		expect(preview.some((m) => m.content === "Hello after reload")).toBe(true);
		expect(member.allFrames().some((m) => m.type === "character_left" || m.type === "group_chat_closed")).toBe(false);

		await character.runCommand("/tavern-leave");
		member.terminate();
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[])?.[0] === "1 人在线",
			60_000,
		);
		await creator.runCommand("/tavern-leave");
	}, 180_000);

	it("character reload re-reads an edited card (ISSUE-005)", async () => {
		const creator = PiProcess.spawn({
			label: "creator-issue5",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator-issue5"),
			cwd: projectDir,
		});
		processes.push(creator);
		await creator.startGroupChat(projectDir, agentDir);

		const character = PiProcess.spawn({
			label: "character-issue5",
			agentDir,
			sessionDir: join(agentDir, "sessions", "character-issue5"),
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

		// Baseline identity from the original card.
		await character.runCommand("/tavern-test-whoami");
		const before = await character.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				typeof e.message === "string" &&
				e.message.startsWith("[tavern-test-whoami] "),
		);
		expect(String(before.message)).toContain("description=Architecture");

		// Edit the card while the character is joined, then reload the
		// character process: the persona must refresh from disk.
		await writeFile(
			join(agentDir, "characters", "architect.md"),
			"---\nname: Architect\ndescription: Architecture v2\n---\nArchitect prompt v2",
		);
		await character.runCommand("/tavern-test-reload");

		// The reload is async and waitFor replays past events, so poll the
		// observation channel until the post-reload identity (v2) shows up.
		const deadline = Date.now() + 60_000;
		let after: RpcEvent | null = null;
		while (Date.now() < deadline) {
			await character.runCommand("/tavern-test-whoami");
			try {
				after = await character.waitFor(
					(e) =>
						e.type === "extension_ui_request" &&
						e.method === "notify" &&
						typeof e.message === "string" &&
						e.message.startsWith("[tavern-test-whoami] ") &&
						e.message.includes("Architecture v2"),
					2_000,
				);
				break;
			} catch {
				// reload not finished yet; try again
			}
		}
		expect(after).not.toBeNull();
		expect(String(after?.message)).toContain("description=Architecture v2");

		await character.runCommand("/tavern-leave");
		await creator.runCommand("/tavern-leave");
	}, 180_000);
});
