import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { PiProcess, waitForDescriptor } from "./pi-process.js";

/**
 *  W1-c 端到端点亮钉：真实 pi 下触发 run →
 * creator 收到 character 的 update_character_state(true)（点亮事件存在）。
 *
 * 背景：「run 活跃即亮」验收缺「真实 run 下点亮时刻」端到端断言（登记
 * 测试缺口）；代码面已排除 agent_start 不发路径（pi
 * agent-loop 每次 run/continue 必发）——本钉 = 回归钉：triggerTurn 触发 run
 * 后点亮事件必须端到端到达 creator（白名单 run 毫秒级，断言「至少收到过
 * true」即可，不依赖 run 时长）。
 *
 * 绿 = 点亮链路正常；红基线 = 点亮事件未达 creator（链路断，升级上游候选）。
 */
describe("acceptance: W1-c 端到端点亮点亮", () => {
	let index = 0;
	const roots: string[] = [];
	const processes: PiProcess[] = [];

	afterAll(async () => {
		for (const process_ of processes) {
			await process_.kill("SIGTERM");
		}
		await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
	});

	async function startPair(): Promise<{ creator: PiProcess; headless: PiProcess; root: string }> {
		const root = await mkdtemp(join(tmpdir(), `pi-tavern-acc-w1c-${index}-`));
		index += 1;
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
		await creator.waitForTavernReady();
		await creator.runCommand("/tavern-new");
		await waitForDescriptor(agentDir, projectDir);

		const headless = PiProcess.spawn({
			label: "hl",
			agentDir,
			sessionDir: join(agentDir, "sessions", "h"),
			cwd: projectDir,
			env: {
				PITAVERN_AUTO_JOIN: "1",
				PITAVERN_CHARACTER: "architect",
				PITAVERN_GROUP_CHAT: (await waitForDescriptor(agentDir, projectDir)).groupChatId,
			},
		});
		processes.push(headless);
		await headless.waitForStderr("Auto-joined", 60_000);
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[] | undefined)?.[0]?.startsWith("1 人在线") === true,
		);
		return { creator, headless, root };
	}

	it("W1-c: triggerTurn 触发 run → 点亮事件端到端到达 creator", async () => {
		const { creator } = await startPair();

		// 触发 run（群聊消息 → idle 投递 → triggerTurn）。
		await creator.runCommand("/tavern-test-message W1C light probe");

		// ① 消息发布确认（notify，与 T4 同时序）——排除命令未生效的假红。
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
			30_000,
		);

		// ② 端到端点亮点亮：creator widget 出现「正在工作：」行（语义，
		// run 活跃即亮；T4 同信号已证可达）。白名单 run 毫秒级：行可能在
		// 事件流早期出现（全历史重放），等待即可。
		const seen = await creator
			.waitFor(
				(e) =>
					(e.type === "extension_ui_request" &&
						e.method === "setWidget" &&
						(e.widgetLines as string[] | undefined)?.some((line) => line.startsWith("正在工作："))) ??
					false,
				90_000,
			)
			.catch(() => undefined);
		expect(seen).toBeDefined();
	});
});
