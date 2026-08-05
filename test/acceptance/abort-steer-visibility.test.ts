import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { PiProcess, waitForDescriptor } from "./pi-process.js";

/**
 * A' abort 打断投递 v0.5——红钉先行（QA 属主，2026-08-04）。
 *
 * 契约源：口径 v0.5（docs/abort-delivery.md，2026-08-05 评审修正）：
 *   「忙态消息到达 → 隐藏 steer 令牌 → 安全边界 abort → settle → followUp 重开拉全量未读」；
 *   忙态 + 消息到达 → 当前工具未结束时 abort=0 → 下一模型调用前 abort=1 →
 *   agent 转空闲 → followUp 重开带全部未读 → 模型从头生成即见新消息；
 *   无 N/C 保护参数（苍蓝星拍板：不要保护，密集打断）；
 *   livelock 风险已告知，本钉锚定「连续消息下仍能完成作答」。
 *
 * 观察通道：M7 A6——RPC 模式 notify 呈现为 extension_ui_request 事件
 *   （group-chat-input.ts:444-459 的 [tavern-inject] 通知；pi-process 头注），
 *   事件字段 e.message 含 latest_seq/count（投递增量）、abort=0（令牌排队）与
 *   abort=1 boundary=steer（安全边界打断）。
 *
 * 测试依赖（实现侧须提供，PITAVERTEST=1 门控）：
 *   tavern-test-busy <ms>——无 LLM 环境下模拟 Tavern runtime 的忙态与 settled，
 *   使「令牌排队 → context abort → settled 后拉取」的进程链路可确定性构造。
 *   真实工具仍执行时 abort=0、工具批完成后才消费令牌的上游时序，由
 *   integration/extension/abort-steer-tool-boundary.test.ts 使用真实 agent-loop 钉住；
 *   上游真实 RPC abort/队列保持由 J2 钉覆盖（零 LLM 白名单，#52）。
 *
 * T1 锚定精确时序；T2/T3 锚定连续消息收敛与游标语义。
 */
describe("acceptance: A'——steer 安全边界 abort 重开（可见性 + 收敛 + 语义）", () => {
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
		await character.waitForAfter(settleCheckpoint, (e) => e.type === "response" && e.command === "prompt", 10_000);
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

	async function readState(character: PiProcess): Promise<{ pendingMessageCount?: number; isStreaming?: boolean }> {
		const id = await character.send({ type: "get_state" });
		const response = await character.waitFor(
			(e) => e.id === id && e.type === "response" && e.command === "get_state",
			10_000,
		);
		return (response.data as { pendingMessageCount?: number; isStreaming?: boolean }) ?? {};
	}

	it("T1：通知到达先排令牌，context abort 后 settled 拉取消息", async () => {
		const { creator, root } = await startCreator();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const character = await startCharacter(agentDir, projectDir);

		// ① 构造忙态（busy 窗口 8s）——等生效确认再发布，消除竞态。
		await awaitBusy(character, 8000);

		// ② 忙态窗口内发布；检查点必须早于发布，避免错过快速的 abort/投递通知。
		const firstPublish = character.checkpoint();
		await publishMessage(creator, "T1-visibility-check");

		// ③ 通知到达只排隐藏令牌；真实工具未结束时 abort=0 由 integration 钉覆盖。
		const queued = await character.waitForAfter(
			firstPublish,
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				typeof e.message === "string" &&
				e.message.includes("abort=0") &&
				e.message.includes("token=queued"),
			15_000,
		);
		// ④ 隐藏令牌触发的 context 边界请求 abort。
		const boundary = await character.waitForAfter(
			firstPublish,
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				typeof e.message === "string" &&
				e.message.includes("abort=1") &&
				e.message.includes("boundary=steer"),
			15_000,
		);
		const events = (character as unknown as { events: Array<Record<string, unknown>> }).events;
		expect(events.indexOf(queued)).toBeLessThan(events.indexOf(boundary));
		// ⑤ 打断并 settled 后消息可见。
		await character.waitForAfter(
			firstPublish,
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
		const checkpoint = character.checkpoint();
		for (let i = 0; i < 5; i += 1) {
			await publishMessage(creator, `T2-storm-${i}`);
		}

		// 连续消息至少经过一次安全边界打断，且不会超过通知数；同一边界内的
		// N→1 精确合并由 unit 钉测，RPC 发布确认会让通知跨越多个 run。
		await vi.waitFor(
			() => expect(injectLines(character).filter((line) => line.includes("token=queued")).length).toBeGreaterThan(0),
			{
				timeout: 15_000,
			},
		);
		await vi.waitFor(
			() => expect(injectLines(character).filter((line) => line.includes("abort=1")).length).toBeGreaterThan(0),
			{
				timeout: 15_000,
			},
		);
		expect(injectLines(character).filter((line) => line.includes("token=queued")).length).toBeLessThanOrEqual(5);
		expect(injectLines(character).filter((line) => line.includes("abort=1")).length).toBeLessThanOrEqual(5);
		const deliveredBatch = await character.waitForAfter(
			checkpoint,
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				typeof e.message === "string" &&
				e.message.includes("latest_seq=5") &&
				e.message.includes("count=5"),
			15_000,
		);
		expect(deliveredBatch).toBeDefined();

		const messagesId = await character.send({ type: "get_messages" });
		const messagesResponse = await character.waitFor(
			(e) => e.id === messagesId && e.type === "response" && e.command === "get_messages",
			10_000,
		);
		const sessionMessages =
			(messagesResponse.data as { messages?: Array<Record<string, unknown>> } | undefined)?.messages ?? [];
		const deliveredContents = sessionMessages.flatMap((message) => {
			if (message.customType !== "pi-tavern.group-chat-input") return [];
			const details = message.details as { events?: Array<{ type?: string; content?: string }> } | undefined;
			return (details?.events ?? []).filter((event) => event.type === "public_message").map((event) => event.content);
		});
		for (let i = 0; i < 5; i += 1) {
			expect(deliveredContents.filter((content) => content === `T2-storm-${i}`)).toHaveLength(1);
		}

		// 风暴内容已全部进入上下文后，再验证 agent 最终空闲、队列排空。
		const deadline = Date.now() + 15_000;
		let pending: number | undefined;
		let isStreaming: boolean | undefined;
		for (;;) {
			const state = await readState(character);
			pending = state.pendingMessageCount;
			isStreaming = state.isStreaming;
			if (pending === 0 && isStreaming === false) {
				break;
			}
			if (Date.now() > deadline) {
				throw new Error(
					`T2 red: 连续消息后未收敛（pendingMessageCount=${String(pending)}, isStreaming=${String(isStreaming)}）——livelock 风险锚点`,
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
		const checkpoint = character.checkpoint();
		await publishMessage(creator, "T3-once");

		// 等投递通知出现（RPC notify 事件通道）。
		await character.waitForAfter(
			checkpoint,
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				typeof e.message === "string" &&
				e.message.includes("[tavern-inject]") &&
				e.message.includes("latest_seq"),
			10_000,
		);

		const sequences = injectLines(character)
			.map((line) => Number(line.match(/latest_seq=(\d+)/)?.[1] ?? NaN))
			.filter((n) => !Number.isNaN(n));
		expect(sequences.length).toBeGreaterThan(0);
		// 游标单调（只增不减），且本场景唯一消息只投递一次。
		for (let i = 1; i < sequences.length; i += 1) {
			expect(sequences[i] ?? 0).toBeGreaterThanOrEqual(sequences[i - 1] ?? 0);
		}
		const injected = injectLines(character).filter((line) => line.includes("latest_seq"));
		expect(injected).toHaveLength(1);
		expect(injected[0]).toContain("count=1");

		// 读取真实 pi session 上下文，确认公共消息正文完整进入一次 custom message。
		const id = await character.send({ type: "get_messages" });
		const response = await character.waitFor(
			(e) => e.id === id && e.type === "response" && e.command === "get_messages",
			10_000,
		);
		const messages = ((response.data as { messages?: Array<Record<string, unknown>> })?.messages ?? []).filter(
			(message) => message.customType === "pi-tavern.group-chat-input",
		);
		const delivered = messages.flatMap((message) => {
			const details = message.details as { events?: Array<{ type?: string; content?: string }> } | undefined;
			return details?.events ?? [];
		});
		expect(delivered.filter((event) => event.type === "public_message" && event.content === "T3-once")).toHaveLength(1);
	});
});
