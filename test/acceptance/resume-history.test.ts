import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { PiProcess } from "./pi-process.js";

/**
 * #42/#155 红测（acceptance 进程级）：resume 历史投影。
 *
 * 场景：创建群聊 → 发 12 条消息（> 旧 JOIN_HISTORY_LIMIT=10 窗口）→
 * 终止进程 → 重新启动（同 agent 目录 + pi 会话目录）→ /tavern-resume →
 * TUI 历史消息完整可见。
 *
 * 断言（验收条目 RH1/RH2/RH3/RH4 + 既有 A3-1/A4）：
 * - RH1（#155）：>10 条历史完整投影（12 条）、sequence 升序、内容逐条一致；
 * - RH2（#155）：活跃群聊二次 resume 零新增投影条目；
 * - RH3（#155）：公开消息完整恢复（断言存在且非空；创建者私信正文投影
 *   挂 #152 实现后补验，PM 裁决 2026-08-09 裁剪留痕）；
 * - RH4（#155）：活跃群聊排除、无可恢复提示、选择/删除流程行为不变；
 * - A3-1：重复 resume 不产生重复条目（锚定扫描跳过已投影段）；
 * - A4：resume 后新消息仍走增量投影（无重复无丢失）。
 *
 * 红测语义：旧实现（JOIN_HISTORY_LIMIT=10）下 12 条历史仅投影 10 条 →
 * 本测试在 #155 实现前为红。
 */

describe("acceptance: #42/#155 resume history projection (RH1-RH4 + A3-1/A4)", () => {
	let pairIndex = 0;
	const roots: string[] = [];
	const processes: PiProcess[] = [];

	afterAll(async () => {
		for (const process_ of processes) {
			await process_.kill("SIGTERM");
		}
		await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
	});

	async function startCreator(agentDir: string, sessionDir: string, projectDir: string): Promise<PiProcess> {
		const process_ = PiProcess.spawn({
			label: "creator",
			agentDir,
			sessionDir,
			cwd: projectDir,
		});
		processes.push(process_);
		return process_;
	}

	async function setupRoot(): Promise<{ agentDir: string; sessionDir: string; projectDir: string }> {
		const root = await mkdtemp(join(tmpdir(), `pi-tavern-acc-resume-${pairIndex}-`));
		pairIndex += 1;
		roots.push(root);
		const agentDir = join(root, "agent");
		const sessionDir = join(agentDir, "sessions", "creator");
		const projectDir = join(root, "project");
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await mkdir(projectDir, { recursive: true });
		await writeFile(
			join(agentDir, "characters", "architect.md"),
			"---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt",
		);
		await writeFile(join(agentDir, "tavern.json"), JSON.stringify({ characters: ["characters/architect.md"] }));
		return { agentDir, sessionDir, projectDir };
	}

	async function publishMessage(creator: PiProcess, label: string): Promise<void> {
		await creator.runCommand(`/tavern-test-message ${label}`);
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);
	}

	async function resumeGroupChat(creator: PiProcess): Promise<void> {
		await creator.runCommand("/tavern-resume");
		const select = await creator.waitFor((e) => e.type === "extension_ui_request" && e.method === "select");
		const options = (select.options as unknown as string[]) ?? [];
		const chosen = options.find((o) => !o.startsWith("Delete")) ?? options[0];
		if (chosen === undefined) {
			throw new Error("[creator] no resumable session options available");
		}
		creator.respond(String(select.id), { value: chosen });
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				typeof e.message === "string" &&
				e.message.startsWith("Resumed group chat"),
			60_000,
		);
	}

	async function resumeExpectNoResumable(creator: PiProcess): Promise<void> {
		await creator.runCommand("/tavern-resume");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				e.message === "No resumable group chat found for this project",
		);
	}

	function creatorDisplayEvents(process_: PiProcess): Array<{
		sequence: number;
		content: string;
		event_id: string;
	}> {
		return process_
			.dumpEvents()
			.filter((e) => {
				if (e.type !== "entry_appended") {
					return false;
				}
				const entry = (e as { entry?: { customType?: unknown } }).entry;
				return entry?.customType === "pi-tavern.creator-display";
			})
			.map((e) => {
				const entry = (e as { entry?: { data?: { event?: { sequence: number; content: string; event_id: string } } } })
					.entry;
				const data = entry?.data ?? {};
				return {
					sequence: data.event?.sequence ?? 0,
					content: data.event?.content ?? "",
					event_id: data.event?.event_id ?? "",
				};
			})
			.sort((a, b) => a.sequence - b.sequence);
	}

	it("RH1/RH3: 12 条历史完整投影、sequence 升序、内容逐条一致", async () => {
		const { agentDir, sessionDir, projectDir } = await setupRoot();

		// 阶段一：创建群聊并发布 12 条历史消息（> 旧 JOIN_HISTORY_LIMIT=10 窗口）。
		const creator = await startCreator(agentDir, sessionDir, projectDir);
		await creator.startGroupChat(projectDir, agentDir);
		for (let i = 1; i <= 12; i += 1) {
			await publishMessage(creator, `R${i} message ${i}`);
		}
		await creator.kill("SIGTERM");

		// 阶段二：重启（同 agent 目录 + pi 会话目录）并 resume。
		const resumed = await startCreator(agentDir, sessionDir, projectDir);
		await resumed.waitForTavernReady();
		await resumeGroupChat(resumed);

		// RH1：历史 12 条完整投影（无 10 条截断）、sequence 1..12 升序、内容逐条一致。
		const expected = Array.from({ length: 12 }, (_, i) => i + 1);
		const projected = creatorDisplayEvents(resumed);
		expect(projected.map((e) => e.sequence)).toEqual(expected);
		expect(projected.map((e) => e.content)).toEqual(expected.map((s) => `R${s} message ${s}`));
		// RH3（公开部分）：投影条目存在且非空（事件标识完整）；创建者私信
		// 正文投影挂 #152 实现后补验（PM 裁决 2026-08-09）。
		expect(projected.length).toBeGreaterThan(0);
		expect(projected.every((e) => e.event_id.length > 0)).toBe(true);
	});

	it("RH2/RH4: 活跃群聊二次 resume 零新增、fresh 重投影、resume 后增量到达", async () => {
		const { agentDir, sessionDir, projectDir } = await setupRoot();

		// 阶段一：创建群聊并发布 12 条消息（RH2 在 >10 条下重验）。
		const creator = await startCreator(agentDir, sessionDir, projectDir);
		await creator.startGroupChat(projectDir, agentDir);
		for (let i = 1; i <= 12; i += 1) {
			await publishMessage(creator, `R${i} message ${i}`);
		}
		await creator.kill("SIGTERM");

		// 阶段二：重启（同 agent 目录 + pi 会话目录）并 resume。
		const resumed = await startCreator(agentDir, sessionDir, projectDir);
		await resumed.waitForTavernReady();
		await resumeGroupChat(resumed);
		const expected = Array.from({ length: 12 }, (_, i) => i + 1);
		expect(creatorDisplayEvents(resumed).map((e) => e.sequence)).toEqual(expected);

		// RH2：同一进程内第二次 /tavern-resume——群聊已活跃（active descriptor
		// 存在）→ 从选择列表排除 → 无可恢复提示（RH4 活跃排除），零新增投影。
		const before = creatorDisplayEvents(resumed).length;
		await resumeExpectNoResumable(resumed);
		expect(creatorDisplayEvents(resumed).length).toBe(before);
		// 注：同会话（continued）重复 resume 锚定幂等在 RPC 环境跨进程不可
		// 复现（pi 会话不落盘，每次重启 fresh、锚定=0 → 全量重投影是方案 B
		// 期望语义），由 unit 层 computeSessionProjectionAnchor 用例钉死
		// （interactive --continue 场景防御，persistence.md 已注记）。

		// 阶段三：fresh 会话再次 resume——重投影 [1..12]（方案 B 扫描语义：
		// RPC 每次重启都是 fresh 会话，扫描锚定 = 0 → 全量重投影，保证
		// TUI 历史可见——修复 #42 原症状的期望行为，非缺陷）。
		await resumed.kill("SIGTERM");
		const resumedAgain = await startCreator(agentDir, sessionDir, projectDir);
		await resumedAgain.waitForTavernReady();
		await resumeGroupChat(resumedAgain);
		expect(creatorDisplayEvents(resumedAgain).map((e) => e.sequence)).toEqual(expected);

		// A4：resume 后新消息仍增量到达（投影 12 条 + 增量 1 条 = [1..13]）。
		await publishMessage(resumedAgain, "R13 after resume");
		expect(creatorDisplayEvents(resumedAgain).map((e) => e.sequence)).toEqual([...expected, 13]);
		expect(creatorDisplayEvents(resumedAgain).map((e) => e.content)).toEqual([
			...expected.map((s) => `R${s} message ${s}`),
			"R13 after resume",
		]);
	});
});
