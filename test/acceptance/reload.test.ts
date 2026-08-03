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
		// 记住监听端口：reload 必须保持同一服务器。
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

		// 一个裸 WebSocket 成员在 reload 期间保持已确认连接：
		// 其 socket 保持打开并持续接收广播。
		const member = await joinCharacterWs(descriptor, "ws-session-reload", "characters/reviewer.md");
		// ISSUE-014/#14 (方案 A): the join itself broadcasts a
		// group_chat_update——下方谓词按内容匹配 reload 后的
		// 通知，而非加入时的通知。
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[])?.[0] === "3 人在线",
		);

		// 经仅测试可用的命令在 creator 上触发真实 pi reload
		//（RPC 模式经 commandContextActions 暴露 ctx.reload()）。
		await creator.runCommand("/tavern-test-reload");

		// 同一 pi 进程在 reload 后存活并重新接管交接：
		// widget 仍显示两个成员，且端口不变。
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[])?.[0] === "3 人在线",
			60_000,
		);
		expect(creator.exited).toBe(false);
		expect(descriptor.port).toBe(originalPort);

		// 角色从未被告知离开：未发出 character_left。
		// reload 后新消息仍能到达成员。
		await creator.runCommand("/tavern-test-message Hello after reload");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);
		// 裸成员在其原始连接上收到 reload 后的广播：
		// reload 后的 creator 服务同一批 socket。M7
		//（ISSUE-012）：广播即 group_chat_update 通知；
		// 预览携带新消息。
		const delivered = await member.waitFor(
			(m) =>
				m.type === "group_chat_update" &&
				((m.preview_messages as Record<string, unknown>[] | undefined) ?? []).some(
					(p) => p.content === "Hello after reload",
				),
			30_000,
		);
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

		// 原始角色卡的基线身份。
		await character.runCommand("/tavern-test-whoami");
		const before = await character.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				typeof e.message === "string" &&
				e.message.startsWith("[tavern-test-whoami] "),
		);
		expect(String(before.message)).toContain("description=Architecture");

		// 在角色已加入时编辑角色卡，然后 reload
		// 角色进程：persona 必须从磁盘刷新。
		await writeFile(
			join(agentDir, "characters", "architect.md"),
			"---\nname: Architect\ndescription: Architecture v2\n---\nArchitect prompt v2",
		);
		await character.runCommand("/tavern-test-reload");

		// reload 是异步的且 waitFor 会重放历史事件，因此轮询
		// 观察通道直到 reload 后的身份（v2）出现。
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
				// reload 尚未完成；重试
			}
		}
		expect(after).not.toBeNull();
		expect(String(after?.message)).toContain("description=Architecture v2");

		await character.runCommand("/tavern-leave");
		await creator.runCommand("/tavern-leave");
	}, 180_000);
});
