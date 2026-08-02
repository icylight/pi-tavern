import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { getGroupChatCursorDirectory } from "../../src/discovery/active-descriptor.js";
import { PiProcess } from "./pi-process.js";

/**
 * #38 口径 A（T4，进程级佐证）：run 进行中消息经 steer 通道有界可见——
 * 光标在 run 结束前推进（run 内投递），且 run 不被打断、无重复投递。
 *
 * 判别信号：character 侧投递成功即推进持久化光标文件（A5: saveCursor on
 * delivery）。旧行为（A2 defer）在 agent_settled 之后才推进光标；新行为
 * （steer）在 run 活跃期即推进——断言「光标达到 seq2 的时刻，creator
 * widget 仍显示「正在发言」」即证明消息在 run 内已进入上下文。
 *
 * 配套断言：run 正常结束（agent_settled + widget 熄灭）→ M7 A5「不打断
 * run」保持；settle 后光标稳定（无重复投递）。
 */

describe("acceptance: #38 live steer delivery during a run (T4)", () => {
	let pairIndex = 0;
	const roots: string[] = [];
	const processes: PiProcess[] = [];

	afterAll(async () => {
		for (const process_ of processes) {
			await process_.kill("SIGTERM");
		}
		await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
	});

	async function startPair(): Promise<{ creator: PiProcess; headless: PiProcess; cursorPath: string }> {
		// Per-test isolation: each pair gets its own agent dir so descriptor
		// files / group chat state never collide across tests.
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
			cursorPath: join(getGroupChatCursorDirectory(agentDir, projectDir), `${descriptor.groupChatId}.json`),
		};
	}

	function widgetHasStreaming(event: Record<string, unknown>): boolean {
		return (
			event.type === "extension_ui_request" &&
			event.method === "setWidget" &&
			((event.widgetLines as string[] | undefined) ?? []).some((line) => line.startsWith("正在发言："))
		);
	}

	it("T4: a message published mid-run is visible before the run settles (steer, no interrupt, no duplicate)", async () => {
		const { creator, headless, cursorPath } = await startPair();

		async function readCursor(): Promise<number> {
			try {
				const raw = await readFile(cursorPath, "utf8");
				return (JSON.parse(raw) as { last_sequence: number }).last_sequence;
			} catch {
				return 0; // Cursor file not written yet.
			}
		}

		// Run 1 starts: a group-chat message triggers the turn (idle delivery,
		// followUp + triggerTurn — cursor advances to 1 before the run starts).
		await creator.runCommand("/tavern-test-message T4 start");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);
		await creator.waitFor(
			(e) => widgetHasStreaming(e) && (e.widgetLines as string[]).some((line) => line.includes("Architect")),
			60_000,
		);
		expect(await readCursor()).toBe(1);

		// Publish a second message while the run is still active.
		await creator.runCommand("/tavern-test-message T4 mid");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);

		// Poll the cursor: with steer the mid-run message reaches the context
		// (cursor → 2) while the run is still streaming…
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

		// …and the creator widget must still show「正在发言」at that moment:
		// the run is still active, so the delivery cannot have been deferred
		// to the settle hook (the old A2 behaviour only advances the cursor
		// after the settle flush, which follows the streaming-off broadcast).
		const widgetEvents = creator
			.dumpEvents()
			.filter((e) => e.type === "extension_ui_request" && e.method === "setWidget");
		const lastWidget = widgetEvents[widgetEvents.length - 1];
		expect(lastWidget).toBeDefined();
		const lines = (lastWidget as { widgetLines?: string[] }).widgetLines ?? [];
		expect(lines.some((line) => line.startsWith("正在发言："))).toBe(true);

		// The run is not interrupted: agent_settled fires and the widget
		// extinguishes normally (M7 A5 preserved).
		await headless.waitFor((e) => e.type === "agent_settled", 90_000);
		await creator.waitFor(
			(e) => e.type === "extension_ui_request" && e.method === "setWidget" && !widgetHasStreaming(e),
			60_000,
		);

		// No duplicate delivery: the cursor stays at 2 after settle.
		await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
		expect(await readCursor()).toBe(2);
	});
});
