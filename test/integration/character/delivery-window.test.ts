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
 * #196 忙态投递窗口钉测（integration）：
 *
 * 契约变更（group-chat-input.md「输入模型」）：忙态消息到达后启动投递窗口
 * （默认 5s，可注入）；窗口到期仍未 settle → 主动拉取投递。投递统一走 steer
 * 通道（工具批后、下一 LLM 调用前可见），**投递延迟上界 = 窗口 + 一个工具间隙，
 * 不依赖 run 结束**。
 *
 * 红基线（修复前）：忙态消息只置 incrementPending 等 settle；长 run（连续工具链
 * 数十分钟不 settle）下消息零投递；watchdog 触发后投递还会被送进 followUp 队列
 * （只在「agent 无工具调用」时逐条消费）→ 积压。
 *
 * 本钉用可控时序覆盖：置 isAgentActive=true（模拟 run 活跃）→ 消息到达 → 断言在
 * 窗口 + 余量内 sendMessage 被调用，且 deliverAs 为 steer；对照组断言
 * 「窗口未到期 + 未 settle 时不投递」（证明窗口是投递触发点，而非提前投递）。
 */

const temporaryDirectories: string[] = [];
const creatorRuntimes: CreatorRuntime[] = [];

const TEST_DELIVERY_WINDOW_MS = 80;

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-dw-"));
	temporaryDirectories.push(directory);
	return directory;
}

function createMockPi(): ExtensionAPI {
	return { sendMessage: vi.fn(async () => undefined) } as unknown as ExtensionAPI;
}

async function startCreator(): Promise<{ creator: CreatorRuntime; character: CharacterCard }> {
	const root = await createTemporaryDirectory();
	const characterPath = join(root, "characters", "dev.md");
	const configPath = join(root, "tavern.json");
	await mkdir(join(root, "characters"), { recursive: true });
	await writeFile(characterPath, "---\nname: Dev\ndescription: Development\n---\nDev prompt");
	const character = await loadCharacterCard(characterPath, configPath);
	const creator = await CreatorRuntime.startNew(
		{ cwd: join(root, "project"), agentDir: join(root, "agent"), characters: [character] },
		{},
	);
	creatorRuntimes.push(creator);
	return { creator, character };
}

async function joinCharacter(
	creator: CreatorRuntime,
	character: CharacterCard,
	sessionId: string,
): Promise<{ runtime: CharacterRuntime; pi: ExtensionAPI }> {
	const root = await createTemporaryDirectory();
	const attempt = await JoinAttempt.connect(creator.activeDescriptor, sessionId, {
		cursorStorePath: join(root, "cursors", `${sessionId}.json`),
		triggerDebounceMs: 60,
		deliveryWindowMs: TEST_DELIVERY_WINDOW_MS,
	});
	const pi = createMockPi();
	const runtime = await attempt.claimCharacter(character.characterId, pi);
	return { runtime, pi };
}

function deliveryCalls(sendMessage: ReturnType<typeof vi.fn>): Array<{ deliverAs?: string }> {
	return sendMessage.mock.calls
		.filter((call) => (call[0] as { customType?: string }).customType === "pi-tavern.group-chat-input")
		.map((call) => call[1] as { deliverAs?: string });
}

afterEach(async () => {
	await Promise.all(creatorRuntimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("#196 忙态投递窗口", () => {
	it("长 run（不 settle）下消息在窗口 + 余量内投递，且走 steer 通道", async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1");
		const { runtime, pi } = await joinCharacter(creator, character, "session-dw-1");
		const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
		// 等待 join 稳定（闲态窗口 + 拉取），再清计数。
		await new Promise((resolve) => setTimeout(resolve, 300));
		sendMessage.mockClear();

		// 模拟 run 活跃：此后不再有任何 settle（长工具链场景）。
		runtime.isAgentActive = true;

		// 他人消息到达（忙态）。
		await creator.submitUserPersonaMessage("busy 1");

		// 窗口（80ms）+ 拉取余量内必须投递——不依赖 settle。
		await new Promise((resolve) => setTimeout(resolve, 400));

		const deliveries = deliveryCalls(sendMessage);
		expect(deliveries.length).toBeGreaterThanOrEqual(1);
		expect(deliveries.map((d) => d.deliverAs)).toContain("steer");
		expect(deliveries.map((d) => d.deliverAs)).not.toContain("followUp");
	});

	it("窗口内的多条消息合并为一批投递（N → 1）", async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1");
		const { runtime, pi } = await joinCharacter(creator, character, "session-dw-2");
		const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
		await new Promise((resolve) => setTimeout(resolve, 300));
		sendMessage.mockClear();

		runtime.isAgentActive = true;
		await creator.submitUserPersonaMessage("batch 1");
		await creator.submitUserPersonaMessage("batch 2");
		await creator.submitUserPersonaMessage("batch 3");

		await new Promise((resolve) => setTimeout(resolve, 400));

		expect(deliveryCalls(sendMessage)).toHaveLength(1);
	});

	it("对照组：窗口未到期且未 settle → 不投递（窗口即触发点）", async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1");
		const { runtime, pi } = await joinCharacter(creator, character, "session-dw-3");
		const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
		await new Promise((resolve) => setTimeout(resolve, 300));
		sendMessage.mockClear();

		runtime.isAgentActive = true;
		await creator.submitUserPersonaMessage("early 1");

		// 窗口（80ms）内：投递尚未发生（abort 令牌不算投递）。
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(deliveryCalls(sendMessage)).toHaveLength(0);
	});

	it("settle 先到：窗口空转，不重复投递", async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1");
		const { runtime, pi } = await joinCharacter(creator, character, "session-dw-4");
		const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
		await new Promise((resolve) => setTimeout(resolve, 300));
		sendMessage.mockClear();

		runtime.isAgentActive = true;
		await creator.submitUserPersonaMessage("settled 1");
		// settle：置 false 并触发 onAgentSettled 路径（等同 agent_settled 事件）。
		runtime.isAgentActive = false;
		runtime.settleRun();
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(deliveryCalls(sendMessage)).toHaveLength(1); // settle 投递恰好一次
		// 再等过窗口时长：不得出现第二批。
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(deliveryCalls(sendMessage)).toHaveLength(1);
	});

	it("长 run 持续收消息：窗口循环触发，每批都投递（不只在首批）", async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1");
		const { runtime, pi } = await joinCharacter(creator, character, "session-dw-6");
		const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
		await new Promise((resolve) => setTimeout(resolve, 300));
		sendMessage.mockClear();

		runtime.isAgentActive = true;
		await creator.submitUserPersonaMessage("round 1");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(deliveryCalls(sendMessage)).toHaveLength(1);

		// run 仍未 settle：第二批消息必须再启动一个窗口并投递。
		await creator.submitUserPersonaMessage("round 2");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(deliveryCalls(sendMessage)).toHaveLength(2);
		expect(deliveryCalls(sendMessage).every((call) => call.deliverAs === "steer")).toBe(true);
	});

	it("abort 令牌卡住（长 run 不重置）不影响投递", async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1");
		const { runtime, pi } = await joinCharacter(creator, character, "session-dw-7");
		const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
		await new Promise((resolve) => setTimeout(resolve, 300));
		sendMessage.mockClear();

		// 第一条忙态消息：排隐藏令牌（abortTokenQueued=true）。
		runtime.isAgentActive = true;
		await creator.submitUserPersonaMessage("first");
		// 在窗口到期前消费令牌：模拟「令牌在工具批后触发 abort，但 run 未结束」
		// 的形态——此后 abortRequested=true，后续消息不再排新令牌。
		const input = runtime.groupChatInput;
		expect(input).toBeDefined();
		// 令牌经帧到达后排入（异步），轮询到「可消费」再消费。
		let consumed = false;
		for (let i = 0; i < 40 && !consumed; i += 1) {
			consumed = input?.consumeAbortControlToken(() => undefined) ?? false;
			if (!consumed) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}
		expect(consumed).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 300));
		const afterFirst = deliveryCalls(sendMessage).length;
		expect(afterFirst).toBeGreaterThanOrEqual(1);

		// 第二条忙态消息：令牌链已停（不再打断），但投递仍必须到达。
		await creator.submitUserPersonaMessage("second");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(deliveryCalls(sendMessage).length).toBeGreaterThan(afterFirst);
	});

	it("投递同步抛错 → 游标不推进，重投仍到达", async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1");
		const { runtime, pi } = await joinCharacter(creator, character, "session-dw-5");
		const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
		await new Promise((resolve) => setTimeout(resolve, 300));
		sendMessage.mockClear();
		const cursorBefore = runtime.loadCursor();

		runtime.isAgentActive = true;
		// 只让「投递类」第一次调用抛错（abort 令牌走同 mock，不能被误伤）——
		// 模拟 sendMessage 同步抛错（入队拒绝）。
		let deliveryRejected = false;
		sendMessage.mockImplementation((message: unknown) => {
			const customType = (message as { customType?: string }).customType;
			if (customType === "pi-tavern.group-chat-input" && !deliveryRejected) {
				deliveryRejected = true;
				throw new Error("injection rejected");
			}
			return Promise.resolve(undefined);
		});
		await creator.submitUserPersonaMessage("retry me");
		// 重投走 resetJoinDebounce（JOIN_BATCH_DEBOUNCE_MS = 1000ms）+ 余量。
		await new Promise((resolve) => setTimeout(resolve, 1_400));

		// 首次抛错不推进游标；retryBatch 重投成功（≥2 次投递调用：失败 1 + 成功 1+）。
		expect(runtime.loadCursor()).toBeGreaterThan(cursorBefore ?? 0);
		expect(deliveryCalls(sendMessage).length).toBeGreaterThanOrEqual(2);
	});
});
