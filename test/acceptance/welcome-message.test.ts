import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type WebSocket from "ws";

import { PiProcess } from "./pi-process.js";
import { leaveAndReset, spawnCreator, startFreshGroup } from "./process-fixture.js";
import { joinCharacterWs } from "./ws-helper.js";

/**
 * #123 红钉（acceptance 进程级）：welcome system_message 替代历史推送。
 *
 * 验收锚点：acceptance.md WL1–WL6（QA 提供场景文本，2026-08-08 落文）。
 *
 * - WL1：ready 后新角色恰收 1 条 system_message（单播、非公共消息、不计轮次）；
 * - WL2：零 message_history 自动推送（旧 100 条行为取消）；
 * - WL3：get_message_history 主动分页仍完整可用（>10 条可全量拉取）；
 * - WL4：welcome_message 配置链——项目 .pi/tavern.json > 全局 tavern.json > 默认；
 * - WL6：system_message 走 #119 新信封（{jsonrpc:"2.0", method, params:{content}}，
 *   通知帧无 id），与 #97 source 扩展位互不干扰。
 *
 * 红测语义：当前实现（main 7fa5e2f）ready 后推送 message_history（100 窗口）
 * 且无 system_message——本文件在实现前为红。
 */
describe("acceptance: #123 welcome system_message (WL1/WL2/WL3/WL4/WL6)", () => {
	const roots: string[] = [];
	const extraProcesses: PiProcess[] = [];
	const sockets: WebSocket[] = [];

	let root: string;
	let agentDir: string;
	let projectDir: string;
	let creator: PiProcess;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-tavern-acc-welcome-"));
		roots.push(root);
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
		// 全局配置（agentDir/tavern.json）：welcome_message = 全局欢迎语。
		await writeFile(
			join(agentDir, "tavern.json"),
			JSON.stringify({
				characters: ["characters/architect.md", "characters/reviewer.md"],
				welcome_message: "全局欢迎语",
			}),
		);
		// 项目配置（projectDir/.pi/tavern.json）：welcome_message = 项目欢迎语。
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "tavern.json"), JSON.stringify({ welcome_message: "项目欢迎语" }));
		creator = spawnCreator({
			label: "creator",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator"),
			cwd: projectDir,
		});
		await creator.waitForTavernReady(60_000);
	});

	afterEach(async () => {
		for (const socket of sockets.splice(0)) {
			socket.terminate();
		}
		// 与 family 同构的兜底归位（leaveAndReset 幂等）。
		try {
			await leaveAndReset(creator, creator.checkpoint(), 10_000);
		} catch {
			await creator.kill("SIGKILL");
		}
		if (creator.exited) {
			creator = spawnCreator({
				label: "creator",
				agentDir,
				sessionDir: join(agentDir, "sessions", "creator"),
				cwd: projectDir,
			});
			await creator.waitForTavernReady(60_000);
		}
	});

	afterAll(async () => {
		for (const process_ of extraProcesses) {
			if (!process_.exited) {
				await process_.kill("SIGTERM");
			}
		}
		if (creator && !creator.exited) {
			await creator.kill("SIGTERM");
		}
		await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }).catch(() => undefined)));
	});

	async function publishMessage(label: string): Promise<void> {
		await creator.runCommand(`/tavern-test-message ${label}`);
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);
	}

	it("WL1/WL4/WL6: ready 后恰收 1 条 system_message（项目>全局）+ 信封 + 时序 + 单播", async () => {
		const { descriptor, checkpoint } = await startFreshGroup(creator, projectDir, agentDir);
		void checkpoint;
		let memberA: Awaited<ReturnType<typeof joinCharacterWs>> | undefined;
		let memberB: Awaited<ReturnType<typeof joinCharacterWs>> | undefined;
		try {
			await publishMessage("W1 hello");
			await publishMessage("W1 world");

			memberA = await joinCharacterWs(descriptor, "ws-welcome-a", "characters/architect.md");
			sockets.push(memberA.socket);
			// system_message 与 character_joined 在同一 setImmediate 内先后发送，
			// 逐帧 waitFor 等齐再快照（WS 帧解析异步，防止第二帧未达即快照）。
			const welcomeA = await memberA.waitFor((m) => m.method === "system_message");
			const joinedA = await memberA.waitFor((m) => m.method === "character_joined");
			const framesA = memberA.allFrames();
			expect(framesA.filter((m) => m.method === "system_message")).toHaveLength(1);

			// WL6 信封：jsonrpc 2.0 + method 判别 + params.content；通知帧无 id。
			expect(welcomeA.jsonrpc).toBe("2.0");
			expect(welcomeA.id).toBeUndefined();
			expect(welcomeA.params).toMatchObject({ content: "项目欢迎语" });

			// WL4：项目 .pi/tavern.json（"项目欢迎语"）覆盖全局 tavern.json（"全局欢迎语"）。
			expect((welcomeA.params as { content: string }).content).toBe("项目欢迎语");

			// WL1 语义：非公共消息（无 sequence/round/source），不计轮次。
			const params = welcomeA.params as Record<string, unknown>;
			expect(params.sequence).toBeUndefined();
			expect(params.round).toBeUndefined();
			expect(params.source).toBeUndefined();

			// 时序（Arch 定案）：ready 响应（id=3 result）先到 → setImmediate 内
			// system_message → character_joined。
			const readyIndex = framesA.findIndex((m) => m.id === "3" && "result" in m);
			const welcomeIndex = framesA.indexOf(welcomeA);
			const joinedIndex = framesA.indexOf(joinedA);
			expect(readyIndex).toBeGreaterThanOrEqual(0);
			expect(welcomeIndex).toBeGreaterThan(readyIndex);
			expect(joinedIndex).toBeGreaterThan(welcomeIndex);

			// WL2：零 message_history 自动推送。
			expect(framesA.some((m) => m.method === "message_history")).toBe(false);

			// 单播验证：第二位成员加入后 system_message 只发给新成员，
			// memberA 已在线不收第二条（Arch 定案：send 单播非 broadcast）。
			// 注意：角色唯一性（claim 占用检查）——memberB 须用不同角色。
			memberB = await joinCharacterWs(descriptor, "ws-welcome-b", "characters/reviewer.md");
			sockets.push(memberB.socket);
			// memberB 的 system_message 同为 setImmediate 发送，waitFor 等达再快照。
			await memberB.waitFor((m) => m.method === "system_message");
			const framesB = memberB.allFrames();
			expect(framesB.filter((m) => m.method === "system_message")).toHaveLength(1);
			expect(memberA.allFrames().filter((m) => m.method === "system_message")).toHaveLength(1);
		} finally {
			// socket 清理由 afterEach 统一 terminate（family 模式同构）。
			void memberA;
			void memberB;
		}
	});

	it("WL1 角色可见: 环境注入含欢迎文案（观察通道 system_messages= 携带原文）", async () => {
		const { descriptor, checkpoint } = await startFreshGroup(creator, projectDir, agentDir);
		void descriptor;
		void checkpoint;
		try {
			// 角色可见（PM 裁决口径 = 进环境注入）：真实角色进程 join 后，
			// 其注入批次含欢迎文案——经观察通道 [tavern-inject] system_messages=…
			// 断言（客户端 #123 扩展行，board_updates 同族模式；携带文案原文）。
			const charProcess = PiProcess.spawn({
				label: "char-welcome",
				agentDir,
				sessionDir: join(agentDir, "sessions", "char-welcome"),
				cwd: projectDir,
			});
			extraProcesses.push(charProcess);
			await charProcess.joinGroupChat(projectDir, agentDir, "Architect — Architecture");
			const injection = await charProcess.waitFor(
				(e) =>
					e.type === "extension_ui_request" &&
					e.method === "notify" &&
					typeof e.message === "string" &&
					e.message.includes("system_messages=") &&
					e.message.includes("项目欢迎语"),
				60_000,
			);
			expect(String(injection.message)).toContain("项目欢迎语");
		} finally {
			void descriptor;
		}
	});

	it("WL2/WL3: 零自动推送 + get_message_history 主动分页 >10 条完整拉取", async () => {
		const { descriptor, checkpoint } = await startFreshGroup(creator, projectDir, agentDir);
		void checkpoint;
		try {
			// 发布 12 条（> 分页 10）：覆盖 WL3 完整分页拉取。
			for (let i = 1; i <= 12; i += 1) {
				await publishMessage(`W3-${i}`);
			}

			const member = await joinCharacterWs(descriptor, "ws-welcome-c", "characters/architect.md");
			sockets.push(member.socket);

			// WL2：join 后零 message_history 推送（旧 100 条行为取消）。
			expect(member.allFrames().some((m) => m.method === "message_history")).toBe(false);

			// WL3：主动拉取第一页（最近 10 条）+ has_more/cursor；第二页续拉全量。
			member.send({ jsonrpc: "2.0", id: "h1", method: "get_message_history", params: {} });
			const page1 = await member.waitFor((m) => m.id === "h1" && "result" in m);
			const r1 = page1.result as {
				messages: unknown[];
				cursor: string | null;
				has_more: boolean;
				total_messages: number;
			};
			expect(r1.messages).toHaveLength(10);
			expect(r1.has_more).toBe(true);
			expect(r1.cursor).toBeTruthy();
			expect(r1.total_messages).toBe(12);

			member.send({
				jsonrpc: "2.0",
				id: "h2",
				method: "get_message_history",
				params: { cursor: r1.cursor },
			});
			const page2 = await member.waitFor((m) => m.id === "h2" && "result" in m);
			const r2 = page2.result as {
				messages: unknown[];
				cursor: string | null;
				has_more: boolean;
				total_messages: number;
			};
			expect(r2.messages).toHaveLength(2);
			expect(r2.has_more).toBe(false);
			expect(r2.total_messages).toBe(12);
		} finally {
			// 成员 socket 由 joinCharacterWs 返回，此处无额外清理（afterEach leave 兜底）。
		}
	});

	it("WL4/WL1: 全局配置覆盖默认档 + 默认文案存在且非空", async () => {
		// 全局档：agentDir 有全局 welcome_message、无项目配置 → 收到全局欢迎语。
		const root2 = await mkdtemp(join(tmpdir(), "pi-tavern-acc-welcome-global-"));
		roots.push(root2);
		const agentDir2 = join(root2, "agent");
		const projectDir2 = join(root2, "project");
		await mkdir(join(agentDir2, "characters"), { recursive: true });
		await mkdir(projectDir2, { recursive: true });
		await writeFile(
			join(agentDir2, "characters", "architect.md"),
			"---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt",
		);
		await writeFile(
			join(agentDir2, "tavern.json"),
			JSON.stringify({ characters: ["characters/architect.md"], welcome_message: "全局欢迎语" }),
		);
		const creator2 = spawnCreator({
			label: "creator2",
			agentDir: agentDir2,
			sessionDir: join(agentDir2, "sessions", "creator"),
			cwd: projectDir2,
		});
		extraProcesses.push(creator2);
		await creator2.waitForTavernReady(60_000);
		const { descriptor: descriptor2 } = await startFreshGroup(creator2, projectDir2, agentDir2);
		const memberGlobal = await joinCharacterWs(descriptor2, "ws-welcome-global", "characters/architect.md");
		sockets.push(memberGlobal.socket);
		const globalWelcome = await memberGlobal.waitFor((m) => m.method === "system_message");
		expect(memberGlobal.allFrames().filter((m) => m.method === "system_message")).toHaveLength(1);
		expect((globalWelcome.params as { content: string }).content).toBe("全局欢迎语");
		await leaveAndReset(creator2, creator2.checkpoint(), 10_000);
		await creator2.kill("SIGTERM");

		// 默认档：全局/项目均无 welcome_message → 默认文案存在且非空
		// （精确默认值由 unit 层钉，acceptance 断言"存在且非空"）。
		const root3 = await mkdtemp(join(tmpdir(), "pi-tavern-acc-welcome-default-"));
		roots.push(root3);
		const agentDir3 = join(root3, "agent");
		const projectDir3 = join(root3, "project");
		await mkdir(join(agentDir3, "characters"), { recursive: true });
		await mkdir(projectDir3, { recursive: true });
		await writeFile(
			join(agentDir3, "characters", "architect.md"),
			"---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt",
		);
		await writeFile(join(agentDir3, "tavern.json"), JSON.stringify({ characters: ["characters/architect.md"] }));
		const creator3 = spawnCreator({
			label: "creator3",
			agentDir: agentDir3,
			sessionDir: join(agentDir3, "sessions", "creator"),
			cwd: projectDir3,
		});
		extraProcesses.push(creator3);
		await creator3.waitForTavernReady(60_000);
		const { descriptor: descriptor3 } = await startFreshGroup(creator3, projectDir3, agentDir3);
		const memberDefault = await joinCharacterWs(descriptor3, "ws-welcome-default", "characters/architect.md");
		sockets.push(memberDefault.socket);
		const defaultWelcome = await memberDefault.waitFor((m) => m.method === "system_message");
		expect(memberDefault.allFrames().filter((m) => m.method === "system_message")).toHaveLength(1);
		expect((defaultWelcome.params as { content: string }).content.length).toBeGreaterThan(0);
		await leaveAndReset(creator3, creator3.checkpoint(), 10_000);
		await creator3.kill("SIGTERM");
	});
});
