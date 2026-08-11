import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getGroupChatCursorDirectory } from "../../src/data/discovery/active-descriptor.js";
import { pollSessionCursor } from "./cursor-helper.js";
import { PiProcess } from "./pi-process.js";

/**
 *  acceptance: headless RPC character mode (CPU 根治).
 *
 * 以 PITAVERN_AUTO_JOIN=1 启动的角色 pi 以编程方式加入活动群聊
 *（无对话框、无 TUI）。验收断言全链路：
 * auto-join 出现在 creator 的在线列表、群聊
 * 输入到达无头会话（游标文件推进——RPC 无
 * session_start 故 PITAVERTEST 通知通道不可用），且
 * 进程空闲时 CPU 可忽略（RPC 模式无 TUI 渲染管线）。
 */
describe("acceptance: headless RPC character auto-join", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	const processes: PiProcess[] = [];

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-tavern-acc-headless-"));
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

	it("auto-joins on startup, appears online, receives input, idles at ~0% CPU", async () => {
		const creator = PiProcess.spawn({
			label: "creator",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator"),
			cwd: projectDir,
		});
		processes.push(creator);
		const descriptor = await creator.startGroupChat(projectDir, agentDir);

		// 一条用户 Persona 消息创建轮次。
		await creator.runCommand("/tavern-test-message hello");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);

		// ── 无头角色：RPC 模式 + auto-join 环境 ───────────────────
		const headless = PiProcess.spawn({
			label: "hl",
			agentDir,
			sessionDir: join(agentDir, "sessions", "h"),
			cwd: projectDir,
			env: {
				PITAVERN_AUTO_JOIN: "1",
				PITAVERN_CHARACTER: "architect",
				PITAVERN_GROUP_CHAT: descriptor.groupChatId,
				//  验证：短 auto-join 延迟（默认 3000，测试用短值 ≥50ms）。
				PITAVERN_AUTO_JOIN_DELAY_MS: "100",
			},
		});
		processes.push(headless);

		// 无头进程在 stderr 报告编程式加入
		//（无头 notify 走 stderr 以保持 RPC JSONL 流干净）。
		// 加入惰性完成：进程启动 + 3 秒定时延迟 + 认领。
		const joinStarted = Date.now();
		await headless.waitForStderr("Auto-joined", 60_000);
		console.log(`[headless] auto-join completed in ${Date.now() - joinStarted}ms`);

		// creator 看到无头角色在线（2 人）。
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[])?.[0]?.startsWith("2 人在线") === true,
		);

		// ── 群聊输入到达无头会话 ─────────────────
		// 投递管线在成功增量时推进持久化游标文件
		//（RPC 无 session_start，故 PITAVERTEST
		// [tavern-inject] 通知未接线；游标文件是
		// 消息已被拉取并投递的确定性证据）。
		// PR  后游标 = cursors/<groupId>/<sessionId>.json（sessionId 进程生成不可预知）：
		// 轮询目录内全部游标文件（会话无关）。
		const cursorDir = getGroupChatCursorDirectory(agentDir, projectDir);
		const groupChatId = descriptor.groupChatId;
		await creator.runCommand("/tavern-test-message second message");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);
		//  实测打点：发布确认 → 游标推进（拉取+投递耗时），与症状基线
		//（15-20s / 60s+）对比；断言 30s 上界仅防 flake，不替代延迟证据。
		const publishAt = Date.now();
		await pollSessionCursor(cursorDir, groupChatId, 2, 30_000, "cursor file");
		console.log(`[headless] publish→cursor 实测 ${Date.now() - publishAt}ms`);

		// ──  核心：空闲 CPU 可忽略（无 TUI 管线）──
		const cpu = await headless.sampleCpuPercent(3_000);
		expect(cpu).toBeLessThanOrEqual(2);
	});
});
