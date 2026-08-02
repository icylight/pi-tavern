import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { PiProcess } from "./pi-process.js";

/**
 * #42 红测（acceptance 进程级）：resume 历史投影。
 *
 * 场景：创建群聊 → 发 3 条消息 → 终止进程 → 重新启动（同 agent 目录 +
 * pi 会话目录）→ /tavern-resume → TUI 历史消息可见。
 *
 * 断言（验收条目 A1/A2/A3-1/A4）：
 * - A1/A2：resume 后 entry_appended（pi-tavern.creator-display）按
 *   sequence 序出现历史 3 条，内容逐条一致；
 * - A3-1：重复 resume 不产生重复条目（锚定扫描跳过已投影段）；
 * - A4：resume 后新消息仍走增量投影（无重复无丢失）。
 *
 * 红测语义：当前实现 resume 路径零重放，本测试在实现前为红。
 */

describe("acceptance: #42 resume history projection (A1/A2/A3-1/A4)", () => {
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

	it("A1/A2/A3-1/A4: resume 后历史按 sequence 投影、重复 resume 无重复、新消息增量到达", async () => {
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

		// 阶段一：创建群聊并发布 3 条历史消息。
		const creator = await startCreator(agentDir, sessionDir, projectDir);
		await creator.startGroupChat(projectDir, agentDir);
		await publishMessage(creator, "R1 hello");
		await publishMessage(creator, "R2 world");
		await publishMessage(creator, "R3 final");
		await creator.kill("SIGTERM");

		// 阶段二：重启（同 agent 目录 + pi 会话目录）并 resume。
		const resumed = await startCreator(agentDir, sessionDir, projectDir);
		await resumed.waitForTavernReady();
		await resumeGroupChat(resumed);

		// A1/A2：历史 3 条按 sequence 序投影，内容逐条一致。
		const projected = creatorDisplayEvents(resumed);
		expect(projected.map((e) => e.sequence)).toEqual([1, 2, 3]);
		expect(projected.map((e) => e.content)).toEqual(["R1 hello", "R2 world", "R3 final"]);
		expect(projected.every((e) => e.event_id.length > 0)).toBe(true);

		// 阶段三：重复 resume——无重复投影（A3-1，锚定扫描跳过已投影段）。
		await resumed.kill("SIGTERM");
		const resumedAgain = await startCreator(agentDir, sessionDir, projectDir);
		await resumedAgain.waitForTavernReady();
		await resumeGroupChat(resumedAgain);
		// 等待潜在（错误）投影有足够时间出现，再断言无新增。
		await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
		expect(creatorDisplayEvents(resumedAgain)).toEqual([]);

		// A4：resume 后新消息仍增量到达（无重复无丢失）。
		await publishMessage(resumedAgain, "R4 after resume");
		expect(creatorDisplayEvents(resumedAgain).map((e) => e.sequence)).toEqual([4]);
		expect(creatorDisplayEvents(resumedAgain).map((e) => e.content)).toEqual(["R4 after resume"]);
	});
});
