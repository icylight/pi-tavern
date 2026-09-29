import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock } from "vitest";
import type { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { JoinAttempt } from "../../../src/character/join-attempt.js";
import { type CharacterCard, loadCharacterCard } from "../../../src/config/character-card.js";
import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";
import type { ServerMessage } from "../../../src/protocol/messages.js";
import { DIAG_PREFIX, setDiagnosticSink } from "../../../src/shared/diagnostic.js";
import { type ConsumableMockPi, createConsumableMockPi } from "../../helpers/consumable-pi.js";

/**
 * #202 诊断面构造与判别矩阵（QA 复验，integration 层）。
 *
 * 复验对象（owner 冻结验收面 ①/②）：A/B-1..4/C 构造 + 逐 hold 成对基线，
 * 证明「打得进去、分得出来」。签名口径 = `docs/development/diagnostics.md`
 * 矩阵 + Dev 接缝更正（hold@enter：`flush enqueue` 有、`flush enter` 无）。
 *
 * 成对法：每个 hold/丢弃用例在同一测试内先跑「未注入基线段」再跑「注入段」，
 * 断言注入段相对基线的**缺失段**（而非行数）。负向断言（缺段/未消费）全部
 * 在 hold/丢弃生效的确定性条件下观察，不是超时猜测。
 *
 * 矩阵覆盖：B1（基线全链）/ B2 hold@enter / B3 hold@before-state /
 * B4 hold@after-state / C1 服务端丢弃 / ④ 闸门早退 / ⑤ 同步抛错 /
 * ⑤′ 长忙未消费 / ⑥ 消费事件不可用（对偶基线 = B1 空闲消费）。
 */

const temporaryDirectories: string[] = [];
const creatorRuntimes: CreatorRuntime[] = [];

/** 注入短 idle 合并窗口（生产默认 1000ms）——与 #196/#201 提速同款。 */
const TEST_TRIGGER_DEBOUNCE_MS = 100;

// ---------------------------------------------------------------------------
// 诊断行捕获
// ---------------------------------------------------------------------------

interface DiagLine {
	tag: string;
	fields: Record<string, string>;
	raw: string;
}

let diagLines: DiagLine[] = [];

beforeEach(() => {
	process.env.PITAVERN_DIAG = "1";
	diagLines = [];
	setDiagnosticSink((line) => {
		const parsed = parseDiagLine(line);
		if (parsed !== null) diagLines.push(parsed);
	});
});

afterEach(async () => {
	delete process.env.PITAVERN_DIAG;
	setDiagnosticSink(undefined);
	await Promise.all(creatorRuntimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function parseDiagLine(line: string): DiagLine | null {
	if (!line.startsWith(DIAG_PREFIX)) return null;
	const rest = line.slice(DIAG_PREFIX.length).trim();
	const parts = rest.split(" ");
	const tag = parts[0] ?? "";
	const fields: Record<string, string> = {};
	for (const part of parts.slice(1)) {
		const separator = part.indexOf("=");
		if (separator > 0) fields[part.slice(0, separator)] = part.slice(separator + 1);
	}
	return { tag, fields, raw: line };
}

function linesSince(mark: number): DiagLine[] {
	return diagLines.slice(mark);
}

function findLine(
	lines: DiagLine[],
	tag: string,
	match: (fields: Record<string, string>) => boolean = () => true,
): DiagLine | undefined {
	return lines.find((line) => line.tag === tag && match(line.fields));
}

function hasLine(
	lines: DiagLine[],
	tag: string,
	match: (fields: Record<string, string>) => boolean = () => true,
): boolean {
	return findLine(lines, tag, match) !== undefined;
}

function formatLines(lines: DiagLine[]): string {
	return lines.map((line) => line.raw).join("\n");
}

/** 有序子序列断言（跳过无关行，不比行数）。 */
function orderedSubsequence(lines: DiagLine[], matchers: Array<(line: DiagLine) => boolean>, label: string): void {
	let index = 0;
	for (const line of lines) {
		if (index < matchers.length && matchers[index]?.(line) === true) index += 1;
	}
	if (index < matchers.length) {
		throw new Error(
			`${label}：缺少第 ${index + 1} 个签名（已匹配 ${index}/${matchers.length}）\n${formatLines(lines)}`,
		);
	}
}

async function waitForDiag(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error(`超时等待：${label}\n${formatLines(diagLines)}`);
		}
		await sleep(25);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function injectCall(lines: DiagLine[], latest: number): DiagLine | undefined {
	return findLine(lines, "inject", (fields) => fields.phase === "call" && fields.latest === String(latest));
}

function injectConsumed(lines: DiagLine[], latest: number): DiagLine | undefined {
	return findLine(lines, "inject", (fields) => fields.phase === "consumed" && fields.latest === String(latest));
}

// ---------------------------------------------------------------------------
// hold 控制器（注入 → 释放）
// ---------------------------------------------------------------------------

type FlushHoldPoint = "enter" | "before-state" | "after-state";

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function createDeferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

interface FlushHoldController {
	arm(point: FlushHoldPoint): Deferred;
	hook(point: FlushHoldPoint): Promise<void> | undefined;
}

function createFlushHold(): FlushHoldController {
	let current: { point: FlushHoldPoint; deferred: Deferred } | null = null;
	return {
		arm(point: FlushHoldPoint) {
			const deferred = createDeferred();
			current = { point, deferred };
			return deferred;
		},
		hook(point: FlushHoldPoint) {
			return current !== null && current.point === point ? current.deferred.promise : undefined;
		},
	};
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-202-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function startCreator(overrides?: {
	testDropBroadcast?: (sessionId: string | undefined, message: ServerMessage) => boolean;
}): Promise<{ creator: CreatorRuntime; character: CharacterCard }> {
	const root = await createTemporaryDirectory();
	const configPath = join(root, "tavern.json");
	await mkdir(join(root, "characters"), { recursive: true });
	await writeFile(join(root, "characters", "qa.md"), "---\nname: QA\ndescription: QA\n---\nQA prompt");
	const character = await loadCharacterCard(join(root, "characters", "qa.md"), configPath);
	const creator = await CreatorRuntime.startNew(
		{
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [character],
		},
		overrides?.testDropBroadcast !== undefined ? { testDropBroadcast: overrides.testDropBroadcast } : {},
	);
	creatorRuntimes.push(creator);
	// 与 #196/#201 夹具对齐：join 前先有一条可见消息（seq 1）——
	// 同时开启活跃轮次（speak 前置）与「join 批 = 1 条历史」的稳定起点。
	await creator.submitUserPersonaMessage("hello 1");
	return { creator, character };
}

async function joinCharacter(
	creator: CreatorRuntime,
	character: CharacterCard,
	sessionId: string,
	options?: {
		testFlushHold?: (point: FlushHoldPoint) => Promise<void> | undefined;
		testRequestHold?: (method: string) => Promise<void> | undefined;
	},
): Promise<{ runtime: CharacterRuntime; mock: ConsumableMockPi }> {
	const root = await createTemporaryDirectory();
	const cursorPath = join(root, "cursors", `${sessionId}.json`);
	const attempt = await JoinAttempt.connect(creator.activeDescriptor, sessionId, {
		cursorStorePath: cursorPath,
		triggerDebounceMs: TEST_TRIGGER_DEBOUNCE_MS,
		...(options?.testFlushHold !== undefined ? { testFlushHold: options.testFlushHold } : {}),
		...(options?.testRequestHold !== undefined ? { testRequestHold: options.testRequestHold } : {}),
	});
	const mock = createConsumableMockPi();
	const runtime = await attempt.claimCharacter(character.characterId, mock.pi);
	return { runtime, mock };
}

function sendMessageMock(mock: ConsumableMockPi): Mock {
	return mock.pi.sendMessage as unknown as Mock;
}

/** mock 录制批次的 sequence 并集（join 批 + 后续投递）。 */
function sentSequences(mock: ConsumableMockPi): number[] {
	return sendMessageMock(mock).mock.calls.flatMap((call) => {
		const message = (call as unknown[])[0] as { details?: { events?: unknown[] } };
		const events = message.details?.events ?? [];
		return events
			.map((event) => (event as { params?: { sequence?: number } }).params?.sequence)
			.filter((sequence): sequence is number => typeof sequence === "number");
	});
}

/** join 后稳定态：等 join 投递完成，游标钉到 seq 1，清录制。 */
async function settleJoin(runtime: CharacterRuntime, mock: ConsumableMockPi): Promise<void> {
	await waitForDiag(() => sendMessageMock(mock).mock.calls.length > 0, "join 投递");
	await sleep(200);
	runtime.saveCursor(1);
	sendMessageMock(mock).mockClear();
}

/** 基线段：发布 → 投递（call）→ 消费信号（consumed）。 */
async function publishAndConsume(
	creator: CreatorRuntime,
	mock: ConsumableMockPi,
	content: string,
	latest: number,
): Promise<void> {
	await creator.submitUserPersonaMessage(content);
	await waitForDiag(() => injectCall(diagLines, latest) !== undefined, `inject call latest=${latest}`);
	mock.emitConsumption();
	await waitForDiag(() => injectConsumed(diagLines, latest) !== undefined, `inject consumed latest=${latest}`);
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe("#202 诊断面构造与判别矩阵（QA 复验）", () => {
	it("B1/B2 成对：基线全链签名 + hold@enter（enqueue 有、enter 无）→ 释放补投", { timeout: 20_000 }, async () => {
		const { creator, character } = await startCreator();
		const hold = createFlushHold();
		const { runtime, mock } = await joinCharacter(creator, character, "qa-202-b2", { testFlushHold: hold.hook });
		await settleJoin(runtime, mock);

		// ---- 基线段（无 hold）：全链签名 ----
		const baseMark = diagLines.length;
		await publishAndConsume(creator, mock, "base-1", 2);
		const base = linesSince(baseMark);
		orderedSubsequence(
			base,
			[
				(line) => line.tag === "recv" && line.fields.seq === "2",
				(line) => line.tag === "flush" && line.fields.phase === "enqueue",
				(line) => line.tag === "flush" && line.fields.phase === "enter",
				(line) => line.tag === "state" && line.fields.phase === "start",
				(line) => line.tag === "state" && line.fields.phase === "end",
				(line) => line.tag === "inject" && line.fields.phase === "call" && line.fields.latest === "2",
				(line) => line.tag === "inject" && line.fields.phase === "consumed" && line.fields.latest === "2",
			],
			"B1 基线链",
		);
		expect(hasLine(base, "route")).toBe(true);
		expect(hasLine(base, "timer", (fields) => fields.event === "fire")).toBe(true);

		// ---- 注入段：hold@enter（enqueue 后、enter 前停住）----
		const held = hold.arm("enter");
		const heldMark = diagLines.length;
		await creator.submitUserPersonaMessage("hold-enter-1");
		await waitForDiag(
			() => hasLine(linesSince(heldMark), "flush", (fields) => fields.phase === "enqueue"),
			"hold 期 flush enqueue",
		);
		await sleep(250);
		const heldLines = linesSince(heldMark);
		expect(hasLine(heldLines, "flush", (fields) => fields.phase === "enter")).toBe(false);
		expect(hasLine(heldLines, "inject", (fields) => fields.phase === "call")).toBe(false);

		held.resolve();
		await waitForDiag(
			() => hasLine(linesSince(heldMark), "flush", (fields) => fields.phase === "enter"),
			"释放后 flush enter",
		);
		await waitForDiag(() => injectCall(linesSince(heldMark), 3) !== undefined, "释放后投递 m3");
		mock.emitConsumption();
		await waitForDiag(() => injectConsumed(linesSince(heldMark), 3) !== undefined, "释放后 m3 消费");
	});

	it(
		"B3 成对：hold@before-state（caller=flush 的 state 未发起）→ 释放后 state 起止 + 投递",
		{ timeout: 20_000 },
		async () => {
			const { creator, character } = await startCreator();
			const hold = createFlushHold();
			const { runtime, mock } = await joinCharacter(creator, character, "qa-202-b3", { testFlushHold: hold.hook });
			await settleJoin(runtime, mock);

			const baseMark = diagLines.length;
			await publishAndConsume(creator, mock, "base-1", 2);
			expect(hasLine(linesSince(baseMark), "state", (fields) => fields.phase === "start")).toBe(true);

			const held = hold.arm("before-state");
			const heldMark = diagLines.length;
			await creator.submitUserPersonaMessage("hold-before-state-1");
			await waitForDiag(
				() => hasLine(linesSince(heldMark), "flush", (fields) => fields.phase === "enter"),
				"hold 期 flush enter",
			);
			await sleep(250);
			const heldLines = linesSince(heldMark);
			// caller 标消歧：route 期 refresh 的 state 对是 caller=refresh 噪声；
			// 链内 state 调用未发起 = 无 caller=flush 的 start（refresh 对同时在窗内）。
			expect(hasLine(heldLines, "state", (fields) => fields.phase === "start" && fields.caller === "flush")).toBe(
				false,
			);
			expect(hasLine(heldLines, "state", (fields) => fields.caller === "refresh")).toBe(true);
			expect(hasLine(heldLines, "flush", (fields) => fields.phase === "empty" || fields.phase === "exit")).toBe(false);
			expect(hasLine(heldLines, "inject", (fields) => fields.phase === "call")).toBe(false);

			held.resolve();
			await waitForDiag(
				() => hasLine(linesSince(heldMark), "flush", (fields) => fields.phase === "exit"),
				"释放后 flush exit",
			);
			orderedSubsequence(
				linesSince(heldMark),
				[
					(line) => line.tag === "state" && line.fields.phase === "start" && line.fields.caller === "flush",
					(line) => line.tag === "state" && line.fields.phase === "end" && line.fields.caller === "flush",
					(line) => line.tag === "flush" && line.fields.phase === "exit",
					(line) => line.tag === "inject" && line.fields.phase === "call" && line.fields.latest === "3",
				],
				"B3 释放后链（caller=flush）",
			);
			mock.emitConsumption();
			await waitForDiag(() => injectConsumed(linesSince(heldMark), 3) !== undefined, "释放后 m3 消费");
		},
	);

	it("B4 成对：hold@after-state（state end 有、inject call 无）→ 释放后投递", { timeout: 20_000 }, async () => {
		const { creator, character } = await startCreator();
		const hold = createFlushHold();
		const { runtime, mock } = await joinCharacter(creator, character, "qa-202-b4", { testFlushHold: hold.hook });
		await settleJoin(runtime, mock);

		const baseMark = diagLines.length;
		await publishAndConsume(creator, mock, "base-1", 2);
		expect(hasLine(linesSince(baseMark), "inject", (fields) => fields.phase === "call" && fields.latest === "2")).toBe(
			true,
		);

		const held = hold.arm("after-state");
		const heldMark = diagLines.length;
		await creator.submitUserPersonaMessage("hold-after-state-1");
		await waitForDiag(
			() => hasLine(linesSince(heldMark), "state", (fields) => fields.phase === "end"),
			"hold 期 state end",
		);
		await sleep(250);
		const heldLines = linesSince(heldMark);
		expect(hasLine(heldLines, "inject", (fields) => fields.phase === "call")).toBe(false);

		held.resolve();
		await waitForDiag(() => injectCall(linesSince(heldMark), 3) !== undefined, "释放后投递 m3");
		mock.emitConsumption();
		await waitForDiag(() => injectConsumed(linesSince(heldMark), 3) !== undefined, "释放后 m3 消费");
	});

	it("C1 服务端丢弃成对：hub.send(dropped=true) 有、recv 无 → 下一机会补投", { timeout: 20_000 }, async () => {
		let dropping = false;
		const { creator, character } = await startCreator({
			// 旗标式丢弃：group_chat_update 帧的 preview_messages 含最近 3 条消息，
			// 内容匹配会误伤后续帧（DROP-ME 仍在预览里）——按帧类型 + 旗标判定。
			testDropBroadcast: (_sessionId, message) =>
				dropping && (message as { method?: string }).method === "group_chat_update",
		});
		const { runtime, mock } = await joinCharacter(creator, character, "qa-202-c1");
		await settleJoin(runtime, mock);

		// 基线帧：hub.send（现已带 seq）与 recv 双有
		const baseMark = diagLines.length;
		await publishAndConsume(creator, mock, "KEEP-1", 2);
		const base = linesSince(baseMark);
		expect(hasLine(base, "hub.send", (fields) => fields.seq === "2" && fields.dropped !== "true")).toBe(true);
		expect(hasLine(base, "recv", (fields) => fields.seq === "2")).toBe(true);

		// 丢弃帧：服务端 dropped=true（按 seq 直配）、客户端无 recv、无投递
		const dropMark = diagLines.length;
		dropping = true;
		await creator.submitUserPersonaMessage("DROP-ME");
		await waitForDiag(
			() => hasLine(linesSince(dropMark), "hub.send", (fields) => fields.seq === "3" && fields.dropped === "true"),
			"hub.send dropped seq=3",
		);
		await sleep(400);
		const dropLines = linesSince(dropMark);
		// 帧被丢弃 → 客户端不知道 seq 3（无 recv、无投递）
		expect(hasLine(dropLines, "recv", (fields) => fields.seq === "3")).toBe(false);
		expect(hasLine(dropLines, "inject", (fields) => fields.phase === "call")).toBe(false);

		// 下一帧触发拉取：被丢弃的 seq 3 与 seq 4 一并补投（#201 语义）
		dropping = false;
		await creator.submitUserPersonaMessage("KEEP-2");
		await waitForDiag(() => injectCall(linesSince(dropMark), 4) !== undefined, "补拉投递 latest=4");
		expect(sentSequences(mock)).toEqual(expect.arrayContaining([3, 4]));
		mock.emitConsumption();
		await waitForDiag(() => injectConsumed(linesSince(dropMark), 4) !== undefined, "补拉消费 latest=4");
	});

	it(
		"④ 闸门早退成对：flush 到达闸门时游标已过水位 → flush empty(filtered)、无 inject call",
		{ timeout: 20_000 },
		async () => {
			const { creator, character } = await startCreator();
			const hold = createFlushHold();
			const { runtime, mock } = await joinCharacter(creator, character, "qa-202-s4", { testFlushHold: hold.hook });
			await settleJoin(runtime, mock);

			// 基线段：正常投递一次（证明该窗口下 inject call 可达）
			const baseMark = diagLines.length;
			await publishAndConsume(creator, mock, "base-1", 2);
			expect(
				hasLine(linesSince(baseMark), "inject", (fields) => fields.phase === "call" && fields.latest === "2"),
			).toBe(true);

			// 构造：hold@enter 挡住 m3 的 flush（此时 pull 已完成，帧在批里）；
			// 数据侧把游标钉过水位（等价于该帧已被其他批次消费）→ 释放后命中
			// 「cursor 已过/窗口去重」闸门 → flush empty(filtered)、无注入。
			const held = hold.arm("enter");
			const mark = diagLines.length;
			await creator.submitUserPersonaMessage("stale-1");
			await waitForDiag(
				() => hasLine(linesSince(mark), "flush", (fields) => fields.phase === "enqueue"),
				"hold 期 flush enqueue",
			);
			runtime.saveCursor(3);
			held.resolve();
			await waitForDiag(() => hasLine(linesSince(mark), "flush", (fields) => fields.phase === "empty"), "flush 空退");
			const lines = linesSince(mark);
			const emptyLine = findLine(lines, "flush", (fields) => fields.phase === "empty");
			expect(emptyLine?.fields.reason).toBe("filtered");
			expect(emptyLine?.fields.cursor).toBe("3");
			// flush 带着事件到达闸门（enter events=1）而不是饥饿——空退由闸门造成
			expect(findLine(lines, "flush", (fields) => fields.phase === "enter")?.fields.events).toBe("1");
			await sleep(300);
			expect(hasLine(linesSince(mark), "inject", (fields) => fields.phase === "call")).toBe(false);
		},
	);

	it("⑤ 入队同步抛错成对：inject error 有、游标不推进 → 重投补上", { timeout: 20_000 }, async () => {
		const { creator, character } = await startCreator();
		const { runtime, mock } = await joinCharacter(creator, character, "qa-202-s5");
		await settleJoin(runtime, mock);

		const baseMark = diagLines.length;
		await publishAndConsume(creator, mock, "ok-1", 2);
		expect(hasLine(linesSince(baseMark), "inject", (fields) => fields.phase === "error")).toBe(false);
		expect(runtime.loadCursor()).toBe(2);

		// 注入段：下一次 sendMessage 同步抛错（pi 异步入队失败结构性不可观测，本批除外）
		const mark = diagLines.length;
		sendMessageMock(mock).mockImplementationOnce(() => {
			throw new Error("boom-sync");
		});
		await creator.submitUserPersonaMessage("boom-1");
		await waitForDiag(
			() => hasLine(linesSince(mark), "inject", (fields) => fields.phase === "error"),
			"inject error（同步面）",
		);
		expect(runtime.loadCursor()).toBe(2);

		// 重投（debounce 1000ms 后）：本次正常投递并消费
		await waitForDiag(() => injectCall(linesSince(mark), 3) !== undefined, "重投 m3");
		mock.emitConsumption();
		await waitForDiag(() => injectConsumed(linesSince(mark), 3) !== undefined, "m3 消费");
		expect(runtime.loadCursor()).toBe(3);
	});

	it("⑤′/⑥ 成对：长忙（run 活跃）vs 空闲——consumed 有无 + agentActive 字段互斥", { timeout: 20_000 }, async () => {
		const { creator, character } = await startCreator();
		const { runtime, mock } = await joinCharacter(creator, character, "qa-202-s5p");
		await settleJoin(runtime, mock);

		// 基线（空闲 + 消费）＝ ⑤′/⑥ 的共同反例格
		await publishAndConsume(creator, mock, "idle-1", 2);

		// ⑤′ 长忙：call 有、consumed 无、agentActive=true、游标不推进
		const busyMark = diagLines.length;
		runtime.isAgentActive = true;
		await creator.submitUserPersonaMessage("busy-1");
		await waitForDiag(() => injectCall(linesSince(busyMark), 3) !== undefined, "忙态投递 call");
		await sleep(400);
		const busyLines = linesSince(busyMark);
		expect(injectCall(busyLines, 3)?.fields.agentActive).toBe("true");
		expect(hasLine(busyLines, "inject", (fields) => fields.phase === "consumed")).toBe(false);
		expect(runtime.loadCursor()).toBe(2);

		// 释放（run 结束 + 消费信号到达）→ consumed + 游标推进
		runtime.isAgentActive = false;
		mock.emitConsumption();
		await waitForDiag(() => injectConsumed(linesSince(busyMark), 3) !== undefined, "释放后消费确认");
		expect(runtime.loadCursor()).toBe(3);

		// ⑥ 空闲 + 消费事件不可用（对偶：同一投递形态，agentActive=false、无消费信号）
		const lostMark = diagLines.length;
		await creator.submitUserPersonaMessage("lost-1");
		await waitForDiag(() => injectCall(linesSince(lostMark), 4) !== undefined, "空闲投递 call");
		await sleep(400);
		const lostLines = linesSince(lostMark);
		expect(injectCall(lostLines, 4)?.fields.agentActive).toBe("false");
		expect(hasLine(lostLines, "inject", (fields) => fields.phase === "consumed")).toBe(false);
	});
});
