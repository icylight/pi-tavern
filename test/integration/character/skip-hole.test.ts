import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { JoinAttempt } from "../../../src/character/join-attempt.js";
import { type CharacterCard, loadCharacterCard } from "../../../src/config/character-card.js";
import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";

/**
 * #201「跳过洞」红钉（QA 草稿，integration 层；设计冻结后定稿落 `fix/skip-hole`）。
 *
 * 待钉行为面（与修法形态解耦，水位合一/分离/护栏皆可判）：
 * 入队 ≠ 已消费——批次进入 pi 队列（sendMessage 后乐观推游标）后，
 * 若队列被静默清空（interactive abort → clearAllQueues，无返还无事件）
 * 或异步失败永不投递，下一投递机会必须补拉该区间（可重复、不可跳过）。
 *
 * 现状（main 3100ca5）：游标在入队时已过 → [2..4] 永久跳过 → R2/R7 红。
 * 正向对照组（consume 信号到达）修前修后均绿：消费后不重投、不重复注入。
 *
 * 替身基建：mock pi 增加 `on` 注册 + 可控「消费/清队」模拟——现有替身仅
 * sendMessage 录制（self-echo 等各文件本地点）。消费信号载荷 = 事件
 * `{ type: "message_start"|"message_end", message }`（钉版 pi：agent-session.ts:1078-1100
 * 转发）；实现只以 `customType` 判别，替身回传原始发送对象即可（Dev 校准口径）。
 */

const temporaryDirectories: string[] = [];
const creatorRuntimes: CreatorRuntime[] = [];

/** 注入短 idle 合并窗口（生产默认 1000ms）——与 #196 提速同款。 */
const TEST_TRIGGER_DEBOUNCE_MS = 100;

/** 目标区间：外部消息 seq 2..4（join 后手动把游标钉在 1）。 */
const GAP_SEQUENCES = [2, 3, 4] as const;
const NEXT_SEQUENCE = 5;

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-201-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function startCreator(): Promise<{ creator: CreatorRuntime; character: CharacterCard }> {
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
		{},
	);
	creatorRuntimes.push(creator);
	return { creator, character };
}

interface MockPi {
	pi: ExtensionAPI;
	/** 清空录制（含已消费指针），用于场景起点。 */
	clear(): void;
	/** 录制到的 sendMessage 调用数（含无 sequence 的 join 历史批）。 */
	callCount(): number;
	/** 全部录制批次的 sequence 并集（含 join 期投递，未清则包含）。 */
	deliveredSequences(): number[];
	/** 模拟 pi 真实消费：对未处置批次逐条 fire message_start/message_end。 */
	emitConsumption(): void;
	/** 模拟 clearAllQueues：静默丢弃未处置批次（无返还、无事件）。 */
	dropQueued(): void;
}

function createMockPi(): MockPi {
	const handlers = new Map<string, Array<(event: unknown) => void>>();
	/** [0, handledIndex) = 已消费或已丢弃的调用下标。 */
	let handledIndex = 0;
	const sendMessage = vi.fn(async () => undefined);
	const pi = {
		sendMessage,
		on: (event: string, handler: (payload: unknown) => void) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				handlers.set(
					event,
					(handlers.get(event) ?? []).filter((entry) => entry !== handler),
				);
			};
		},
	} as unknown as ExtensionAPI;
	const sequencesOfBatch = (message: unknown): number[] => {
		const events = (message as { details?: { events?: unknown[] } }).details?.events ?? [];
		return events
			.map((event) => (event as { params?: { sequence?: number } }).params?.sequence)
			.filter((sequence): sequence is number => typeof sequence === "number");
	};
	return {
		pi,
		clear: () => {
			sendMessage.mockClear();
			handledIndex = 0;
		},
		callCount: () => sendMessage.mock.calls.length,
		deliveredSequences: () => sendMessage.mock.calls.flatMap((call) => sequencesOfBatch((call as unknown[])[0])),
		emitConsumption: () => {
			for (let index = handledIndex; index < sendMessage.mock.calls.length; index += 1) {
				const message = (sendMessage.mock.calls[index] as unknown[])[0];
				for (const handler of handlers.get("message_start") ?? []) handler({ type: "message_start", message });
				for (const handler of handlers.get("message_end") ?? []) handler({ type: "message_end", message });
			}
			handledIndex = sendMessage.mock.calls.length;
		},
		dropQueued: () => {
			handledIndex = sendMessage.mock.calls.length;
		},
	};
}

async function joinCharacter(
	creator: CreatorRuntime,
	character: CharacterCard,
	sessionId: string,
): Promise<{ runtime: CharacterRuntime; mock: MockPi }> {
	const root = await createTemporaryDirectory();
	const cursorPath = join(root, "cursors", `${sessionId}.json`);
	const attempt = await JoinAttempt.connect(creator.activeDescriptor, sessionId, {
		cursorStorePath: cursorPath,
		triggerDebounceMs: TEST_TRIGGER_DEBOUNCE_MS,
	});
	const mock = createMockPi();
	const runtime = await attempt.claimCharacter(character.characterId, mock.pi);
	return { runtime, mock };
}

/** join 后稳定态：等 join 投递完成，游标钉到 seq 1，清录制——场景起点。 */
async function settleJoin(runtime: CharacterRuntime, mock: MockPi): Promise<void> {
	await waitFor(() => mock.callCount() > 0, 5_000);
	await new Promise((resolve) => setTimeout(resolve, 200));
	runtime.saveCursor(1);
	mock.clear();
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("timeout waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** 发布外部 [2..4] 并等待其入队（sendMessage 录制）。 */
async function publishGapAndWaitEnqueue(creator: CreatorRuntime, mock: MockPi): Promise<void> {
	for (const text of ["m2", "m3", "m4"]) {
		await creator.submitUserPersonaMessage(text);
	}
	await waitFor(() => GAP_SEQUENCES.every((seq) => mock.deliveredSequences().includes(seq)), 5_000);
}

afterEach(async () => {
	await Promise.all(creatorRuntimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("#201 跳过洞（红钉草稿）", () => {
	it("R2: 入队未消费 + 清队静默丢弃 → gap 必须可重拉（现状红）", { timeout: 20_000 }, async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1");
		const { runtime, mock } = await joinCharacter(creator, character, "session-r2");
		await settleJoin(runtime, mock);

		await publishGapAndWaitEnqueue(creator, mock);
		// 水位观测（消费确认语义）：未确认不得推进——现状（入队乐观）此处 = 4 → 红。
		expect(runtime.loadCursor()).toBe(1);
		// 未消费（替身不发 message_start）：模拟 clearAllQueues 静默丢弃。
		// 清录制：此后只观察「清队之后的新投递」——首次入队记录不作为重投证据。
		mock.dropQueued();
		mock.clear();

		// 下一投递机会：seq 5 到达 → 拉取链应补上 [2..4]。
		await creator.submitUserPersonaMessage("m5");
		await waitFor(() => mock.deliveredSequences().includes(NEXT_SEQUENCE), 5_000);
		await new Promise((resolve) => setTimeout(resolve, 400));

		// 目标行为：清队后 [2..4] 必须被（重）投递——可重复、不可跳过。现状红。
		const delivered = new Set(mock.deliveredSequences());
		expect([...delivered]).toEqual(expect.arrayContaining([...GAP_SEQUENCES, NEXT_SEQUENCE]));
	});

	it("R7: 入队后异步失败永不投递 → 不得静默跳过（现状红）", { timeout: 20_000 }, async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1");
		const { runtime, mock } = await joinCharacter(creator, character, "session-r7");
		await settleJoin(runtime, mock);

		await publishGapAndWaitEnqueue(creator, mock);
		// 水位观测：未确认不得推进。
		expect(runtime.loadCursor()).toBe(1);
		// 未消费形态之二：idle run 启动异步失败——对扩展不可见（fire-and-forget），
		// 行为面等价于「已入队但永不投递」（校准口径：dropQueued 即签名）。
		mock.dropQueued();
		mock.clear();

		await creator.submitUserPersonaMessage("m5");
		await waitFor(() => mock.deliveredSequences().includes(NEXT_SEQUENCE), 5_000);
		await new Promise((resolve) => setTimeout(resolve, 400));

		const delivered = new Set(mock.deliveredSequences());
		expect([...delivered]).toEqual(expect.arrayContaining([...GAP_SEQUENCES, NEXT_SEQUENCE]));
	});

	it("R5 对照: 消费信号到达 → 不重投不重复（修前修后均绿）", { timeout: 20_000 }, async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1");
		const { runtime, mock } = await joinCharacter(creator, character, "session-r5");
		await settleJoin(runtime, mock);

		await publishGapAndWaitEnqueue(creator, mock);
		// 正常消费：message_start（message_end 同点连发，实现只订 start）到达。
		mock.emitConsumption();
		// 水位观测：消费确认后推进到批次 latest_sequence。
		await waitFor(() => (runtime.loadCursor() ?? 0) >= GAP_SEQUENCES[2], 3_000);
		// 清录制：此后只观察「消费之后的新投递」——消费前记录不作为重投证据。
		mock.clear();

		// 对照组：消费后的批次不得重投（无重复注入），且新消息正常投递。
		await creator.submitUserPersonaMessage("m5");
		await waitFor(() => mock.deliveredSequences().includes(NEXT_SEQUENCE), 5_000);
		await new Promise((resolve) => setTimeout(resolve, 400));

		const delivered = mock.deliveredSequences();
		expect(delivered).toContain(NEXT_SEQUENCE);
		expect(delivered).not.toContain(GAP_SEQUENCES[0]);
		expect(delivered).not.toContain(GAP_SEQUENCES[1]);
		expect(delivered).not.toContain(GAP_SEQUENCES[2]);
	});
});
