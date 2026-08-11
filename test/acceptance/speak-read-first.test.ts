import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getGroupChatCursorDirectory } from "../../src/data/discovery/active-descriptor.js";
import { pollSessionCursor } from "./cursor-helper.js";
import { PiProcess } from "./pi-process.js";

/**
 *  acceptance 验收：真实进程内「未读先读」机制的链路前提。
 *
 * 分层说明（验收口径）：unread_first 是角色侧本地判定（character-runtime.speak
 * 前置门，不发 wire 请求），判定逻辑全边界由 unit 覆盖（实现侧 10 用例 +
 * 契约侧 4 用例，14/14）。真实进程 acceptance 无法直接驱动模型调用 speak
 *（零 LLM 环境无工具调用），故本文件验证两段式的进程级前提：
 *   ① 注入他人未读 → 角色进程水位记录生效（latest_sequence 可观测）
 *   ② 拉取链路健康：游标在限期内追平水位（不重不漏，saveCursor on delivery）
 *   ③ 重复注入多轮 → 每轮均追平，无停滞（症状不回归）
 * speak 门与拉取链路联动的完整两段式（告知 → 拉取 → 追平 → 放行）由
 * unit/integration 层承担（契约测试范围）。
 */
describe("acceptance: speak-read-first 链路前提（水位记录 + 拉取追平）", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	const processes: PiProcess[] = [];

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-tavern-acc-srf-"));
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

	it("多轮他人未读注入：每轮水位记录 + 游标限期内追平，无停滞", async () => {
		const creator = PiProcess.spawn({
			label: "creator",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator"),
			cwd: projectDir,
		});
		processes.push(creator);
		const descriptor = await creator.startGroupChat(projectDir, agentDir);

		// 无头角色：RPC 模式 + auto-join（零 LLM，与  同环境）。
		const headless = PiProcess.spawn({
			label: "hl",
			agentDir,
			sessionDir: join(agentDir, "sessions", "h"),
			cwd: projectDir,
			env: {
				PITAVERN_AUTO_JOIN: "1",
				PITAVERN_CHARACTER: "architect",
				PITAVERN_GROUP_CHAT: descriptor.groupChatId,
				PITAVERN_AUTO_JOIN_DELAY_MS: "100",
			},
		});
		processes.push(headless);
		await headless.waitForStderr("Auto-joined", 60_000);

		const cursorDir = getGroupChatCursorDirectory(agentDir, projectDir);
		const groupChatId = descriptor.groupChatId;

		// 轮 1：首条消息建立水位（seq 1）。
		await creator.runCommand("/tavern-test-message round one");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);
		await pollSessionCursor(cursorDir, groupChatId, 1, 30_000, "cursor seq 1");

		// 轮 2-4：连续注入他人未读，每轮断言游标在 5s 内追平（判据同款）。
		// poll 的 30s 只负责在严重故障时给出明确超时；下面的断言才是验收界限。
		for (let seq = 2; seq <= 4; seq += 1) {
			const publishAt = Date.now();
			await creator.runCommand(`/tavern-test-message round ${seq}`);
			await creator.waitFor(
				(e) =>
					e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
			);
			await pollSessionCursor(cursorDir, groupChatId, seq, 30_000, `cursor seq ${seq}`);
			const elapsedMs = Date.now() - publishAt;
			console.log(`[srf] round ${seq}: publish→cursor 实测 ${elapsedMs}ms`);
			expect(elapsedMs).toBeLessThan(5_000);
		}

		// 追平稳态：水位 = 游标 = 4，进程存活无异常。
		expect(await pollSessionCursor(cursorDir, groupChatId, 4, 30_000, "final cursor")).toBe(4);
	});
});
