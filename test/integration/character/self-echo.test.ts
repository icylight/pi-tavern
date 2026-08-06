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
 * #68 回声钉测（QA 属主，integration 层）：
 *
 * 契约（#64 pull 模型 + #38 steer 修订）：自己 speak 成功后，服务端广播
 * group_chat_update（发送者也收，websocket-protocol §广播语义）→ 拉取结果
 * 在 group_chat_update 水位门闸直接过滤；回声不产生任何投递、不触发新 run、
 * 不推进游标（B6：游标停在
 * 己消息前由后续投递推进）。
 *
 * 钉测面（A1/A2/A4）：
 * - E1：闲态回声广播 → 零 sendMessage、无新 run（isAgentActive 不变）
 * - E2：忙态回声广播 → 零 steer 注入、run 不打断
 * - E3：回声+他人消息混合窗口 → 仅他人消息投递（isOwnEcho 过滤不误伤）
 * - E4：游标行为——全回声窗口不 saveCursor；含他人消息投递后推进
 */

const temporaryDirectories: string[] = [];
const creatorRuntimes: CreatorRuntime[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-e68-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function startCreator(
	characterCount = 1,
): Promise<{ creator: CreatorRuntime; character: CharacterCard; characters: CharacterCard[] }> {
	const root = await createTemporaryDirectory();
	const configPath = join(root, "tavern.json");
	await mkdir(join(root, "characters"), { recursive: true });
	const cards = ["Architect", "Developer", "QA", "PM"]
		.slice(0, characterCount)
		.map((name) => ({ name, description: name }));
	for (const card of cards) {
		await writeFile(
			join(root, "characters", `${card.name.toLowerCase()}.md`),
			`---\nname: ${card.name}\ndescription: ${card.description}\n---\n${card.name} prompt`,
		);
	}
	const characters = await Promise.all(
		cards.map((card) => loadCharacterCard(join(root, "characters", `${card.name.toLowerCase()}.md`), configPath)),
	);
	const creator = await CreatorRuntime.startNew(
		{
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters,
		},
		{},
	);
	creatorRuntimes.push(creator);
	return { creator, character: characters[0] as CharacterCard, characters };
}

/** 真实 pi 上下文替身：GroupChatInput 仅在 pi 存在时挂载（activate 条件）。 */
function createMockPi(): ExtensionAPI {
	return {
		sendMessage: vi.fn(async () => undefined),
	} as unknown as ExtensionAPI;
}

async function joinCharacter(
	creator: CreatorRuntime,
	character: CharacterCard,
	sessionId: string,
): Promise<{ runtime: CharacterRuntime; pi: ExtensionAPI }> {
	// cursorStorePath 必需：saveCursor 仅在有存储路径时推进内存游标（B6 同款）。
	const root = await createTemporaryDirectory();
	const cursorPath = join(root, "cursors", `${sessionId}.json`);
	const attempt = await JoinAttempt.connect(creator.activeDescriptor, sessionId, { cursorStorePath: cursorPath });
	const pi = createMockPi();
	const runtime = await attempt.claimCharacter(character.characterId, pi);
	return { runtime, pi };
}

/**
 * join 后稳定态：等待 join 历史投递完成（debounce 1s 窗口），再手动推进游标
 * 到 seq 1（message_history 投递 flush 不带 latestSequence 不推进游标，B6
 * 同款 saveCursor），随后清空 sendMessage 计数——保证后续断言只反映回声。
 */
async function settleJoin(runtime: CharacterRuntime, pi: ExtensionAPI): Promise<void> {
	const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
	await waitFor(() => sendMessage.mock.calls.length > 0, 5_000);
	// join 后环境批次仍有 1s 合并窗口：等待稳定后再清计数，
	// 避免迟到投递污染回声断言。
	await new Promise((resolve) => setTimeout(resolve, 1_500));
	runtime.saveCursor(1);
	sendMessage.mockClear();
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

afterEach(async () => {
	await Promise.all(creatorRuntimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("#68 self-echo", () => {
	it("E1: idle echo broadcast → zero delivery, no new run", { timeout: 15_000 }, async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1"); // 序号 1，轮次已创建
		const { runtime, pi } = await joinCharacter(creator, character, "session-e1");
		await settleJoin(runtime, pi);
		const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
		expect(runtime.isAgentActive).toBe(false);

		// speak 成功 → 服务端广播回声（发送者也收）。
		const result = await runtime.speak("my message");
		expect(result.published).toBe(true);
		expect(result.sequence).toBe(2);

		// 回声广播到达后：闲态走 armIdleWindow → 1s 窗口到期拉取 → isOwnEcho 过滤
		// → 空结果短路 → 零投递、零新 run。窗口 1s + 拉取余量，等待 2s 验证。
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		expect(sendMessage).not.toHaveBeenCalled();
		expect(runtime.isAgentActive).toBe(false);
	});

	it("E2: busy echo broadcast → no steer injection, run not interrupted", { timeout: 15_000 }, async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1");
		const { runtime, pi } = await joinCharacter(creator, character, "session-e2");
		await settleJoin(runtime, pi);
		const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;

		// 忙态：run 活跃（isAgentActive=true，模拟 agent_start 后）。
		runtime.isAgentActive = true;
		const result = await runtime.speak("busy message");
		expect(result.published).toBe(true);

		// 忙态回声在水位门闸直接过滤：零令牌、零拉取、run 保持活跃。
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		expect(sendMessage).not.toHaveBeenCalled();
		expect(runtime.isAgentActive).toBe(true);
	});

	it("E3: mixed window (echo + other) delivers only other messages", { timeout: 15_000 }, async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1");
		const { runtime, pi } = await joinCharacter(creator, character, "session-e3");
		await settleJoin(runtime, pi);
		const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;

		// 自己 speak（seq 2）后，他人（User Persona）再发消息（seq 3）：
		// 拉取窗口含 [自己的 seq2, 他人 seq3] → isOwnEcho 过滤 seq2 → 只投递 seq3。
		const mine = await runtime.speak("mine");
		expect(mine.published).toBe(true);
		await creator.submitUserPersonaMessage("from user");

		await waitFor(() => sendMessage.mock.calls.length > 0);
		const delivered = sendMessage.mock.calls[0]?.[0] as { details?: { events?: Array<{ sequence?: number }> } };
		const sequences = delivered?.details?.events?.map((e) => (e as { params?: { sequence?: number } }).params?.sequence) ?? [];
		expect(sequences).toContain(3);
		expect(sequences).not.toContain(2);
	});

	it("E4: cursor — all-echo window does not advance; delivery window advances", { timeout: 15_000 }, async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1");
		const { runtime, pi } = await joinCharacter(creator, character, "session-e4");
		await settleJoin(runtime, pi);

		// 基线：join 投递后游标 = 1（settleJoin saveCursor）。
		const mine = await runtime.speak("mine");
		expect(mine.published).toBe(true);

		// 全回声窗口：游标不因回声推进（B6）——等待窗口+拉取完成。
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect(runtime.loadCursor()).toBe(1);

		// 他人消息到达（seq 3）→ 投递链推进游标到 3。
		await creator.submitUserPersonaMessage("from user");
		await waitFor(() => (runtime.loadCursor() ?? 0) >= 3);
	});
});
