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
 *  环境文本时间要素钉测（QA 属主，integration 层）：
 *
 * 契约（定案，A1-A3）：buildContent 生成的环境更新文本必须包含
 * ① 头部「当前时间：YYYY-MM-DD HH:MM:SS」（注入时点）；② 每条 public_message
 * 行带发言时间（YYYY-MM-DD HH:MM）+ 距当前间隔（「x 分钟前」/「x 秒前」）。
 * 协议/持久化零改动（timestamp 已存在于 wire，纯消费端渲染）。
 *
 * 断言策略：存在性匹配（regex 断言格式存在，不钉死具体时刻）防脆测。
 * - T1：头部当前时间（格式 + 与注入时点同一分钟级窗口）
 * - T2：消息行发言时间 + 间隔存在（格式 regex）
 * - T3：既有内容不回归（身份行/消息正文仍完整）
 */

const temporaryDirectories: string[] = [];
const creatorRuntimes: CreatorRuntime[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-e104-"));
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
	const root = await createTemporaryDirectory();
	const cursorPath = join(root, "cursors", `${sessionId}.json`);
	const attempt = await JoinAttempt.connect(creator.activeDescriptor, sessionId, { cursorStorePath: cursorPath });
	const pi = createMockPi();
	const runtime = await attempt.claimCharacter(character.characterId, pi);
	return { runtime, pi };
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

describe("env time", () => {
	it("T1: 头部含当前时间（格式 + 与注入时点同一分钟级窗口）", { timeout: 15_000 }, async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1");
		const { pi } = await joinCharacter(creator, character, "env-time-t1");
		const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
		await waitFor(() => sendMessage.mock.calls.length > 0, 5_000);
		const content = sendMessage.mock.calls[0]?.[0]?.content as string;
		expect(content).toContain("PiTavern 群聊环境更新");

		// A3：头部当前时间，格式 YYYY-MM-DD HH:MM:SS
		const headerTime = /当前时间：(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(content);
		expect(headerTime).not.toBeNull();
		if (headerTime?.[1]) {
			const injected = new Date(headerTime[1].replace(" ", "T"));
			const now = new Date();
			// 分钟级窗口：注入时点与断言时点差值 < 2 分钟（防测试执行开销误判）
			expect(Math.abs(now.getTime() - injected.getTime())).toBeLessThan(120_000);
		}

		// T3：身份行不回归
		expect(content).toContain("你的当前角色：QA（character_id=characters/qa.md，注册名=QA）");

		//  S2 红测先行：注入含显式来源声明「来源：群聊」，与身份行同批（当前实现
		// 无此声明行 → 红；Green 后 buildContent 头部与身份行同批注入）。
		expect(content).toContain("来源：群聊");
	});

	it("T2: 消息行含发言时间 + 距当前间隔", { timeout: 15_000 }, async () => {
		const { creator, character } = await startCreator();
		const { pi } = await joinCharacter(creator, character, "env-time-t2");
		// ready 不再推 message_history——存量历史不自动注入；submit 新消息触发
		// group_chat_update 水位 → fetchMessagesSince 拉取路径，消息行进入注入。
		await creator.submitUserPersonaMessage("hello 1");
		const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
		await waitFor(() => {
			return sendMessage.mock.calls.some((call) => {
				const content = call[0]?.content as string | undefined;
				return typeof content === "string" && content.includes("hello 1");
			});
		}, 5_000);
		const content = sendMessage.mock.calls.find((call) => (call[0]?.content as string).includes("hello 1"))?.[0]
			?.content as string;

		// A1/A2：消息行含发言时间（YYYY-MM-DD HH:MM）+ 间隔（x 分钟前/x 秒前）
		// Dev 实现格式：发送者（YYYY-MM-DD HH:MM（x 分钟前/x 秒前））: 内容
		const messageLine = /User Persona（(\d{4}-\d{2}-\d{2} \d{2}:\d{2})（(\d+ (?:秒|分钟)前)））:/.exec(content);
		expect(messageLine).not.toBeNull();

		// T3：消息正文仍完整
		expect(content).toContain("hello 1");
	});
});
