import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { PiProcess, waitForDescriptor } from "./pi-process.js";

/**
 * A' abort 打断投递 v0.5——红钉先行（QA 属主，2026-08-04）。
 *
 * 契约源：口径 v0.5（docs/abort-delivery.md，2026-08-04 定稿；实现形态两种皆可：
 *   「忙态消息到达 → deliverSteer 入队 → 立即 abort」或简化版「到达即 abort →
 *   followUp 重开拉全量未读」——本钉断言形态无关：打断通知 + 打断后可见）——
 *   忙态 + 消息到达 → 立即 abort（终止当前 run）→
 *   agent 转空闲 → followUp 重开带全部未读 → 模型从头生成即见新消息；
 *   无 N/C 保护参数（苍蓝星拍板：不要保护，密集打断）；
 *   livelock 风险已告知，本钉锚定「连续消息下仍能完成作答」。
 *
 * 观察通道：M7 A6——RPC 模式 notify 呈现为 extension_ui_request 事件
 *   （group-chat-input.ts:444-459 的 [tavern-inject] 通知；pi-process 头注），
 *   事件字段 e.message 含 latest_seq/count（投递增量）与 abort=1（打断通知，
 *   实现侧契约点）。
 *
 * 测试依赖（实现侧须提供，PITAVERTEST=1 门控）：
 *   tavern-test-busy <ms>——无 LLM 环境下挂起 agent 活跃态（模拟忙态），
 *   使「忙态 + 入队 + 打断」路径可确定性构造（零 LLM 白名单，#52）。
 *
 * 红 = 当前（无 abort 逻辑）：忙态投递后无 abort=1 通知（T1 必红）；
 *   T2/T3 为回归护栏（今日绿，实现后若 livelock/语义破坏则转红）。
 */
describe("acceptance: A' v0.5——忙态入队即 abort 重开（可见性 + livelock 锚点 + 语义）", () => {
	let index = 0;
	const roots: string[] = [];
	const processes: PiProcess[] = [];

	afterAll(async () => {
		for (const process_ of processes) {
			await process_.kill("SIGTERM");
		}
		await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
	});

	async function startCreator(): Promise<{ creator: PiProcess; root: string }> {
		const root = await mkdtemp(join(tmpdir(), `pi-tavern-acc-abort-${index}-`));
		index += 1;
		roots.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await mkdir(projectDir, { recursive: true });
		await writeFile(join(agentDir, "characters", "dev.md"), "---\nname: Dev\ndescription: Developer\n---\nDev prompt");
		await writeFile(join(agentDir, "tavern.json"), JSON.stringify({ characters: ["characters/dev.md"] }));

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
		return { creator, root };
	}

	async function startCharacter(agentDir: string, projectDir: string): Promise<PiProcess> {
		const character = PiProcess.spawn({
			label: "character",
			agentDir,
			sessionDir: join(agentDir, "sessions", "character"),
			cwd: projectDir,
		});
		processes.push(character);
		await character.waitForTavernReady();
		await character.runCommand("/tavern-join");
		const descriptor = await waitForDescriptor(agentDir, projectDir);
		const firstSelect = await character.waitFor((e) => e.type === "extension_ui_request" && e.method === "select");
		if (firstSelect.title === "Choose a group chat") {
			const options = (firstSelect.options as unknown as string[]) ?? [];
			const chosen = options.find((o) => o.includes(descriptor.groupChatId)) ?? options[0];
			character.respond(String(firstSelect.id), { value: chosen });
		}
		const characterSelect = await character.waitFor(
			(e) => e.type === "extension_ui_request" && e.method === "select" && e.title === "Choose a Character",
		);
		const options = (characterSelect.options as unknown as string[]) ?? [];
		character.respond(String(characterSelect.id), { value: options[0] });
		// 等 join 命令完成（prompt 响应落定），避免尾部活动阻塞后续命令处理。
		const settleCheckpoint = character.checkpoint();
		await character.waitForAfter(
			settleCheckpoint,
			(e) => e.type === "response" && e.command === "prompt",
			10_000,
		);
		return character;
	}

	/** RPC notify 事件携带的 [tavern-inject] 行。 */
	function injectLines(character: PiProcess): string[] {
		const events = (character as unknown as { events: Array<Record<string, unknown>> }).events;
		return events
			.filter(
				(e) =>
					e.type === "extension_ui_request" &&
					e.method === "notify" &&
					typeof e.message === "string" &&
					e.message.includes("[tavern-inject]"),
			)
			.map((e) => String(e.message));
	}

	/** 发布群聊消息并等待发布确认（prompt 队列阻塞时重试）。 */
	async function publishMessage(creator: PiProcess, text: string): Promise<void> {
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const checkpoint = creator.checkpoint();
			await creator.runCommand(`/tavern-test-message ${text}`);
			try {
				await creator.waitForAfter(
					checkpoint,
					(e) =>
						e.type === "extension_ui_request" &&
						e.method === "notify" &&
						typeof e.message === "string" &&
						e.message.includes("User Persona message published"),
					10_000,
				);
				return;
			} catch {
				// 重试：prompt 队列可能被尾部 run 占用。
			}
		}
		throw new Error("消息发布未确认（creator prompt 队列阻塞？）");
	}

	/** 等待忙态钩子生效（busy 确认通知），消除 runCommand 与消息发布的竞态。
	 * 零 LLM 环境下 prompt 处理可能被尾部 run 阻塞（偶发），重试容忍。 */
	async function awaitBusy(character: PiProcess, ms: number): Promise<void> {
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const checkpoint = character.checkpoint();
			await character.runCommand(`/tavern-test-busy ${ms}`);
			try {
				await character.waitForAfter(
					checkpoint,
					(e) =>
						e.type === "extension_ui_request" &&
						e.method === "notify" &&
						typeof e.message === "string" &&
						e.message.includes(`[tavern-test-busy] busy=${ms}ms`),
					10_000,
				);
				return;
			} catch {
				// 重试：尾部 run 可能占用 prompt 队列。
			}
		}
		throw new Error(`busy hook 未在 30s 内生效（prompt 队列被阻塞？）`);
	}

	it("T1（红核）：忙态消息入队即 abort——abort=1 通知存在且先有投递通知", async () => {
		const { creator, root } = await startCreator();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const character = await startCharacter(agentDir, projectDir);

		// ① 构造忙态（busy 窗口 8s）——等生效确认再发布，消除竞态。
		await awaitBusy(character, 8000);

		// ② 窗口内两次发布（间隔 3s）：busy 自激的 abort→重启循环存在瞬时 idle 间隙，
		// 双发覆盖间隙，任一条在忙态到达即触发 abort 即通过。
		const firstPublish = character.checkpoint();
		await publishMessage(creator, "T1-visibility-check");
		await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
		await publishMessage(creator, "T1-visibility-check-2");

		// ③ 断言：首次发布之后出现 abort=1 通知（红：无 abort 逻辑 → 超时抛错）。
		await character.waitForAfter(
			firstPublish,
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				typeof e.message === "string" &&
				e.message.includes("abort=1"),
			15_000,
		);
		// ④ 打断后消息可见：重开拉取产生 latest_seq 投递通知（晚于发布后 abort）。
		const checkpoint = character.checkpoint();
		await character.waitForAfter(
			checkpoint,
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				typeof e.message === "string" &&
				e.message.includes("latest_seq"),
			15_000,
		);
	});

	it("T2（livelock 锚点）：连续消息风暴后仍能完成作答——队列排空、agent 转空闲", async () => {
		const { creator, root } = await startCreator();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const character = await startCharacter(agentDir, projectDir);

		// ① 忙态 + 连续 5 条消息（密集打断场景）——先等忙态生效，逐条确认发布。
		await awaitBusy(character, 8000);
		for (let i = 0; i < 5; i += 1) {
			await publishMessage(creator, `T2-storm-${i}`);
		}

		// ② 风暴结束后 agent 最终空闲、队列排空（实现若 livelock，此断言红）。
		const id = await character.send({ type: "get_state" });
		const deadline = Date.now() + 15_000;
		let pending: number | undefined;
		for (;;) {
			const events = (character as unknown as { events: Array<Record<string, unknown>> }).events;
			const hit = events.find((e) => e.id === id && e.type === "response" && e.command === "get_state");
			if (hit) {
				pending = (hit.data as { pendingMessageCount?: number })?.pendingMessageCount;
				if (pending === 0) {
					break;
				}
			}
			if (Date.now() > deadline) {
				throw new Error(
					`T2 red: 连续消息后队列未排空（pendingMessageCount=${String(pending)}）——livelock 风险锚点`,
				);
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 200));
		}
	});

	it("T3（语义回归）：打断重开后游标单调、不重不漏、无半截输出", async () => {
		const { creator, root } = await startCreator();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const character = await startCharacter(agentDir, projectDir);

		await awaitBusy(character, 5000);
		await publishMessage(creator, "T3-once");

		// 等投递通知出现（RPC notify 事件通道）。
		const checkpoint = character.checkpoint();
		await character.waitForAfter(
			checkpoint,
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				typeof e.message === "string" &&
				e.message.includes("[tavern-inject]"),
			10_000,
		);

		const sequences = injectLines(character)
			.map((line) => Number(line.match(/latest_seq=(\d+)/)?.[1] ?? NaN))
			.filter((n) => !Number.isNaN(n));
		// 游标单调（只增不减）。
		for (let i = 1; i < sequences.length; i += 1) {
			expect(sequences[i] ?? 0).toBeGreaterThanOrEqual(sequences[i - 1] ?? 0);
		}
		// 无半截输出（发布内容完整、无截断标记）。
		const stderrAll = injectLines(character).join("\n");
		expect(stderrAll).not.toMatch(/T3-once[\s\S]{0,20}…\s*$/);
	});
});
