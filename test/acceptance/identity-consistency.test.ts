import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import type { ActiveGroupChatDescriptor } from "../../src/data/discovery/active-descriptor.js";
import { PiProcess } from "./pi-process.js";
import { BufferedWsClient } from "./ws-helper.js";

/**
 * ISSUE-003 acceptance: identity consistency.
 *
 * Covers docs/acceptance.md「身份一致性（ISSUE-003 修复验收）」:
 *   2. 注册/注入一致：端到端断言注入 persona == creator 在线注册名，错配不得静默；
 *   3. speaker 一致：sender 与消息来源 session 的注入 persona 一致；
 *   4. 并发不串：同时 join 的 session 身份互不串扰。
 *
 * Observable layer without an LLM: real pi sessions render their own persona
 * via setStatus ("Tavern Character · <name>"), the creator renders the member
 * list via setWidget, and the WebSocket protocol rejects invalid claims.
 * The injected identity line (criterion 1) needs the ISSUE-003 fix and is
 * covered by the skipped contract test at the bottom.
 */
describe("acceptance: identity consistency (ISSUE-003)", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	let descriptor: ActiveGroupChatDescriptor;
	let creator: PiProcess;
	let architect: PiProcess;
	let reviewer: PiProcess;
	const processes: PiProcess[] = [];
	const sockets: WebSocket[] = [];

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-tavern-acc-identity-"));
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

		const creatorProcess = PiProcess.spawn({
			label: "creator",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator"),
			cwd: projectDir,
		});
		processes.push(creatorProcess);
		creator = creatorProcess;
		descriptor = await creator.startGroupChat(projectDir, agentDir);

		// Two real pi sessions join concurrently with different personas —
		// the ecd7e6a concurrent-join scenario, now with identity assertions.
		const architectProcess = PiProcess.spawn({
			label: "architect",
			agentDir,
			sessionDir: join(agentDir, "sessions", "architect"),
			cwd: projectDir,
		});
		processes.push(architectProcess);
		architect = architectProcess;
		const reviewerProcess = PiProcess.spawn({
			label: "reviewer",
			agentDir,
			sessionDir: join(agentDir, "sessions", "reviewer"),
			cwd: projectDir,
		});
		processes.push(reviewerProcess);
		reviewer = reviewerProcess;
		await Promise.all([
			architect.joinGroupChat(projectDir, agentDir, "Architect — Architecture"),
			reviewer.joinGroupChat(projectDir, agentDir, "Reviewer — Reviews designs"),
		]);
	});

	afterAll(async () => {
		for (const socket of sockets) {
			socket.terminate();
		}
		for (const process_ of processes) {
			await process_.kill("SIGTERM");
		}
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
	});

	it("concurrent real-pi sessions keep their own identity (registered name == persona, no cross-talk)", async () => {
		// Both sessions are admitted: creator rendered "3 人在线".
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[] | undefined)?.[0] === "3 人在线",
		);

		// Each session renders its own card's persona and nothing else:
		// per-session status events were captured at join time.
		const arch = await architect.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setStatus" &&
				typeof e.statusText === "string" &&
				e.statusText.includes("Tavern Character · Architect"),
		);
		expect(String(arch.statusText)).not.toContain("Reviewer");

		const rev = await reviewer.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setStatus" &&
				typeof e.statusText === "string" &&
				e.statusText.includes("Tavern Character · Reviewer"),
		);
		expect(String(rev.statusText)).not.toContain("Architect");
	});

	it("claiming an unknown character_id is rejected, not silently admitted", async () => {
		const client = new BufferedWsClient(
			new WebSocket(
				`ws://${descriptor.host}:${descriptor.port}/` +
					`${encodeURIComponent(descriptor.groupChatId)}/${encodeURIComponent(descriptor.instanceId)}`,
			),
		);
		sockets.push(client.socket);
		await new Promise<void>((resolveOpen, rejectOpen) => {
			client.socket.once("open", () => resolveOpen());
			client.socket.once("error", (error) => rejectOpen(error));
		});

		client.send({ id: "1", type: "join_group_chat", session_id: "ghost-session" });
		await client.waitFor((m) => m.type === "response" && m.command === "join_group_chat");

		// The card "characters/ghost.md" is not in tavern.json: the creator
		// must refuse the claim instead of admitting an unknown identity.
		client.send({ id: "2", type: "claim_character", character_id: "characters/ghost.md" });
		const claim = await client.waitFor((m) => m.type === "response" && m.command === "claim_character");
		expect(claim.success).toBe(false);
		expect(String(claim.error)).toContain("no longer available");

		// The ghost never became a member: creator still shows 3 人在线.
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[] | undefined)?.[0] === "3 人在线",
		);
	});

	/**
	 * CONTRACT (ISSUE-003 fix, owner: Dev, src/character/group-chat-input.ts;
	 * acceptance per docs/acceptance.md cab1fd7, three-field final format):
	 *
	 * 1. buildContent() must append an identity line after the
	 *    "PiTavern 群聊环境更新" header, exactly parseable as:
	 *
	 *        你的当前角色：<persona 名>（character_id=<characterId>，注册名=<name>）
	 *
	 *    - persona 名：本 session 注册的角色卡 name（如 Architect）
	 *    - characterId：相对 config 目录的卡片路径（如 characters/architect.md）
	 *    - 注册名：creator 在线注册名（当前与 persona 名同源，均取
	 *      runtime.character.name；契约保留显式三字段，见 cab1fd7）
	 *
	 * 2. When PITAVERN_TEST=1, expose the identity line for acceptance tests
	 *    via pi.ui.notify() with prefix "[tavern-test-injection] " (RPC mode
	 *    surfaces notify as an extension_ui_request event).
	 *
	 * Skip rationale: the notify observation channel is not implemented yet;
	 * per the agreed discipline (PM 2026-08-01) no red tests are introduced
	 * before the implementation lands. Unskip when Dev ships the channel.
	 */
	it("injected group-chat input carries the identity line (persona, character_id, registered name)", async () => {
		await creator.runCommand("/tavern-test-message Hello identity check");
		const injection = await architect.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				typeof e.message === "string" &&
				e.message.startsWith("[tavern-test-injection] "),
		);
		const line = String(injection.message).slice("[tavern-test-injection] ".length);
		const match = /你的当前角色：(.+?)（character_id=(.+?)，注册名=(.+?)）/.exec(line);
		expect(match).not.toBeNull();
		expect(match?.[1]).toBe("Architect");
		expect(match?.[2]).toBe("characters/architect.md");
		expect(match?.[3]).toBe("Architect");
	});

	/**
	 * ISSUE-007 observation channel: in RPC mode the LLM cannot invoke
	 * extension tools, so tavern-test-whoami re-emits runtime.character via
	 * pi.ui.notify (surfaces as extension_ui_request). The reported identity
	 * must match the creator-side registration exactly.
	 */
	it("tavern-test-whoami reports the registered character identity (ISSUE-007)", async () => {
		await architect.runCommand("/tavern-test-whoami");
		const whoami = await architect.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				typeof e.message === "string" &&
				e.message.startsWith("[tavern-test-whoami] "),
		);
		const report = String(whoami.message);
		expect(report).toContain("name=Architect");
		expect(report).toContain("character_id=characters/architect.md");
		expect(report).toContain("description=Architecture");

		// Same channel on the second session: identities never cross.
		await reviewer.runCommand("/tavern-test-whoami");
		const whoamiReviewer = await reviewer.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				typeof e.message === "string" &&
				e.message.startsWith("[tavern-test-whoami] "),
		);
		const reviewerReport = String(whoamiReviewer.message);
		expect(reviewerReport).toContain("name=Reviewer");
		expect(reviewerReport).toContain("character_id=characters/reviewer.md");
		expect(reviewerReport).toContain("description=Reviews designs");
	});
});
