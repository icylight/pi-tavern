import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import type { ActiveGroupChatDescriptor } from "../../src/data/discovery/active-descriptor.js";
import { PiProcess } from "./pi-process.js";
import { BufferedWsClient } from "./ws-helper.js";

/**
 *  验收：身份一致性。
 *
 * Covers docs/acceptance.md「身份一致性（修复验收）」:
 *   2. 注册/注入一致：端到端断言注入 persona == creator 在线注册名，错配不得静默；
 *   3. speaker 一致：sender 与消息来源 session 的注入 persona 一致；
 *   4. 并发不串：同时 join 的 session 身份互不串扰。
 *
 * 无 LLM 的可观测层：真实 pi 会话经 setStatus 渲染自己的 persona
 *（"Tavern Character · <名称>"），creator 经 setWidget 渲染成员
 * 列表，且 WebSocket 协议拒绝非法认领。
 * 注入的身份行（判据 1）依赖  修复，且由
 * 文件末尾被跳过的契约测试覆盖。
 */
describe("acceptance: identity consistency", () => {
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

		// 两个真实 pi 会话以不同 persona 并发加入——// 即 ecd7e6a 并发加入场景，现在带身份断言。
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
		// 两个会话都被接纳：creator 渲染出「3 人在线」。
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[] | undefined)?.[0] === "3 人在线",
		);

		// 每个会话只渲染自己角色卡的 persona：
		// 加入时已捕获各会话的状态事件。
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

		client.send({ jsonrpc: "2.0", id: "1", method: "join_group_chat", params: { session_id: "ghost-session" } });
		await client.waitFor((m) => m.id === "1" && "result" in m);

		// 角色卡 "characters/ghost.md" 不在 tavern.json 中：creator
		// 必须拒绝该认领，而非接纳未知身份。
		client.send({
			jsonrpc: "2.0",
			id: "2",
			method: "claim_character",
			params: { character_id: "characters/ghost.md" },
		});
		const claim = await client.waitFor((m) => m.id === "2" && "error" in m);
		expect((claim.error as { message: string }).message).toContain("no longer available");

		// 幽灵卡从未成为成员：creator 仍显示 3 人在线。
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[] | undefined)?.[0] === "3 人在线",
		);
	});

	/**
	 * 契约（修复，src/character/group-chat-input.ts；
	 * 验收依据 docs/acceptance.md cab1fd7 三字段最终格式）：
	 *
	 * 1. buildContent() 必须在「新消息：」段之后追加身份行；
	 *    "PiTavern 群聊环境更新" header, exactly parseable as:
	 *
	 *        你的当前角色：<persona 名>（character_id=<characterId>，注册名=<name>）
	 *
	 *    - persona 名：本 session 注册的角色卡 name（如 Architect）
	 *    - characterId：相对 config 目录的卡片路径（如 characters/architect.md）
	 *    - 注册名：creator 在线注册名（当前与 persona 名同源，均取
	 *      runtime.character.name；契约保留显式三字段，见 cab1fd7）
	 *
	 * 2. 当 PITAVERN_TEST=1 时，为验收测试暴露身份行
	 *    经 pi.ui.notify() 并以 "[tavern-test-injection] " 为前缀（RPC 模式
	 *    将 notify 呈现为 extension_ui_request 事件）。
	 *
	 * 跳过理由：notify 观察通道尚未实现；
	 * 依约定纪律：实现落地前不引入红灯测试；
	 * 通道交付后取消跳过。
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

		//  来源显式化（S2，acceptance 钉测）：观察通道同批携带显式来源
		// 声明，与身份行同一 notify（同批）；身份行保持可解析（回归不破）。
		// 契约文案「来源：群聊」（全角冒号，与身份行风格一致，S2 落文同源）。
		// 红钉： 实现前此断言失败（通道仅重发身份行，无来源声明）。
		expect(line).toContain("来源：群聊");
	});

	/**
	 *  观察通道：RPC 模式下 LLM 无法调用
	 * 扩展工具，因此 tavern-test-whoami 经
	 * pi.ui.notify 重新发出 runtime.character（呈现为 extension_ui_request）。
	 * 上报的身份必须与 creator 侧注册完全一致。
	 */
	it("tavern-test-whoami reports the registered character identity", async () => {
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

		// 第二个会话使用同一通道：身份永不错乱。
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
