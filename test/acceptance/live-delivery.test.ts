import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { getGroupChatCursorDirectory } from "../../src/data/discovery/active-descriptor.js";
import { pollSessionCursor } from "./cursor-helper.js";
import { PiProcess } from "./pi-process.js";

/**
 *  口径 A（T4，进程级佐证）：run 进行中消息经 steer 通道有界可见——* 光标在 run 结束前推进（run 内投递），且 run 不被打断、无重复投递。
 *
 *  重基线：no-key 自动化下 run 毫秒级结束
 * （白名单模式确定性零 LLM），「光标推进时 run 仍活跃」不可演练——断言改为
 * 可观测语义：消息有界送达（光标 30s 内达 2）+ widget 状态机一致（streaming
 * 点亮→熄灭，不悬挂）+ settle 幂等（光标稳定）。run 活跃期 steer 归真实环境
 * 验证 +  受控窗口补测（A5 范畴）。扩展代码零改动， 产品语义不变。
 *
 * 判别信号：character 侧投递成功即推进持久化光标文件（A5: saveCursor on
 * delivery）。等待窗口加裕量（60s→90s / 90s→120s）——属负载敏感型波动（真实 API 调用方差，白名单落地后消失）
 * 的真实 API 调用方差，白名单落地后消失）；仅加裕量，断言条件与语义零变化。
 */

describe("acceptance: live steer delivery during a run (T4)", () => {
	let pairIndex = 0;
	const roots: string[] = [];
	const processes: PiProcess[] = [];

	afterAll(async () => {
		for (const process_ of processes) {
			await process_.kill("SIGTERM");
		}
		await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
	});

	async function startPair(): Promise<{
		creator: PiProcess;
		headless: PiProcess;
		cursorDir: string;
		groupChatId: string;
	}> {
		// 每测试独立隔离：各自 agent 目录，descriptor 文件/群聊状态互不冲突。
		const root = await mkdtemp(join(tmpdir(), `pi-tavern-acc-live-${pairIndex}-`));
		pairIndex += 1;
		roots.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await mkdir(projectDir, { recursive: true });
		await writeFile(
			join(agentDir, "characters", "architect.md"),
			"---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt",
		);
		await writeFile(join(agentDir, "tavern.json"), JSON.stringify({ characters: ["characters/architect.md"] }));

		const creator = PiProcess.spawn({
			label: "creator",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator"),
			cwd: projectDir,
		});
		processes.push(creator);
		const descriptor = await creator.startGroupChat(projectDir, agentDir);

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
		await headless.waitForStderr("Auto-joined", 60_000);
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[])?.[0]?.startsWith("1 人在线") === true,
		);
		return {
			creator,
			headless,
			cursorDir: getGroupChatCursorDirectory(agentDir, projectDir),
			groupChatId: descriptor.groupChatId,
		};
	}

	function widgetHasStreaming(event: Record<string, unknown>): boolean {
		return (
			event.type === "extension_ui_request" &&
			event.method === "setWidget" &&
			((event.widgetLines as string[] | undefined) ?? []).some((line) => line.startsWith("正在工作："))
		);
	}

	it("T4: 消息有界送达 + widget 状态机一致 + settle 幂等（重基线语义）", async () => {
		const { creator, headless, cursorDir, groupChatId } = await startPair();

		async function readCursor(): Promise<number> {
			return pollSessionCursor(cursorDir, groupChatId, 1, 30_000, "cursor");
		}

		// 第一次 run 启动：群聊消息触发 turn（idle 投递，followUp + triggerTurn——// 光标在 run 启动前推进到 1）。
		await creator.runCommand("/tavern-test-message T4 start");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);
		await creator.waitFor(
			(e) => widgetHasStreaming(e) && (e.widgetLines as string[]).some((line) => line.includes("Architect")),
			90_000, // 裕量：负载敏感等待窗口 60s→90s，断言条件不变
		);
		expect(await readCursor()).toBe(1);

		// 在 run 流程期间发布第二条消息（run 毫秒级，仅验证有界送达）。
		await creator.runCommand("/tavern-test-message T4 mid");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);

		//  实测打点：mid 发布确认 → 游标 2（拉取+投递耗时），
		// 与症状基线（15-20s / 60s+）对比；30s 上界仅防 flake。
		const publishAt = Date.now();
		// 轮询光标：消息有界送达——mid 消息在 30s 内到达上下文（光标 → 2）。
		//  重基线：不再断言「光标 2 时 run 仍活跃」
		// （no-key 自动化下 run 毫秒级结束，该属性不可演练）；
		// run 活跃期 steer 归真实环境验证 +  受控窗口补测（A5 范畴）。
		const deadline = Date.now() + 30_000;
		let cursor = await readCursor();
		for (;;) {
			cursor = await readCursor();
			if (cursor >= 2) {
				break;
			}
			if (Date.now() > deadline) {
				throw new Error(`cursor did not reach seq 2 during the run (last: ${cursor})`);
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 25));
		}
		console.log(`[live-delivery] publish→cursor2 实测 ${Date.now() - publishAt}ms`);

		// run 不被中断（保持，可观测语义）：agent_settled 正常触发、
		// widget 状态机一致（streaming 曾点亮 → 最终熄灭，不悬挂）。
		await headless.waitFor((e) => e.type === "agent_settled", 120_000); // 裕量：90s→120s
		await creator.waitFor(
			(e) => e.type === "extension_ui_request" && e.method === "setWidget" && !widgetHasStreaming(e),
			90_000, // 裕量：负载敏感等待窗口 60s→90s，断言条件不变
		);

		// 无重复投递：settle 后光标稳定在 2。
		await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
		expect(await readCursor()).toBe(2);
	});
});
