import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { JoinAttempt } from "../../../src/character/join-attempt.js";
import { type CharacterCard, loadCharacterCard } from "../../../src/config/character-card.js";
import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";
import { createConsumableMockPi } from "../../helpers/consumable-pi.js";

/**
 * #183 私信目标解析（Dev 钉面，integration 层）：真实 WS 双角色在线，
 * 解析数据源 = `get_group_chat_state` 的在线成员表。
 *
 * 钉面：
 * - N1 注册名唯一命中 → resolved（wire 侧仍发精确 id，投递成功）
 * - N2 精确 character_id 零回归（路径形态 id）
 * - N3 双在线同名 → ambiguous（附候选 id），不投递
 * - N4 离线（配置存在但未在线）/ 不存在 → not-found（名册不含，附清单）
 * - N5 不占额回归：未命中与歧义路径不产生 wire 请求 → 轮次用量不变
 */

const temporaryDirectories: string[] = [];
const creatorRuntimes: CreatorRuntime[] = [];

/** 注入短 idle 合并窗口（生产默认 1000ms），本文件断言面与窗口长度无关。 */
const TEST_TRIGGER_DEBOUNCE_MS = 100;

const CARD_NAMES = ["Dev", "QA", "Dup", "Dup", "Offline"] as const;

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-183-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function startCreator(): Promise<{ creator: CreatorRuntime; cards: CharacterCard[] }> {
	const root = await createTemporaryDirectory();
	const configPath = join(root, "tavern.json");
	await mkdir(join(root, "characters"), { recursive: true });
	const fileNames = ["dev", "qa", "dup-a", "dup-b", "offline"];
	for (let index = 0; index < fileNames.length; index += 1) {
		const name = CARD_NAMES[index] as string;
		await writeFile(
			join(root, "characters", `${fileNames[index]}.md`),
			`---\nname: ${name}\ndescription: ${name} 简介\n---\n${name} prompt`,
		);
	}
	// 同名双卡：dup-a / dup-b 均注册名 "Dup"（卡 name 无唯一约束）。
	const cards = await Promise.all(
		fileNames.map((fileName) => loadCharacterCard(join(root, "characters", `${fileName}.md`), configPath)),
	);
	const creator = await CreatorRuntime.startNew(
		{ cwd: join(root, "project"), agentDir: join(root, "agent"), characters: cards },
		{},
	);
	creatorRuntimes.push(creator);
	return { creator, cards };
}

async function joinCharacter(
	creator: CreatorRuntime,
	character: CharacterCard,
	sessionId: string,
): Promise<{ runtime: CharacterRuntime; pi: ExtensionAPI }> {
	const root = await createTemporaryDirectory();
	const attempt = await JoinAttempt.connect(creator.activeDescriptor, sessionId, {
		cursorStorePath: join(root, "cursors", `${sessionId}.json`),
		triggerDebounceMs: TEST_TRIGGER_DEBOUNCE_MS,
	});
	const pi = createConsumableMockPi().pi;
	const runtime = await attempt.claimCharacter(character.characterId, pi);
	// join 历史投递窗口：等注入发生并推游标到 1（B6：join 批次不带水位不推进）。
	const sendMessage = pi.sendMessage as unknown as { mock: { calls: unknown[] } };
	const deadline = Date.now() + 5_000;
	while (sendMessage.mock.calls.length === 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	await new Promise((resolve) => setTimeout(resolve, 200));
	runtime.saveCursor(1);
	return { runtime, pi };
}

afterEach(async () => {
	await Promise.all(creatorRuntimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("whisper target discovery (#183)", () => {
	it("N1-N5: 按名解析 / 精确 id / 同名歧义 / 离线未命中 / 不占额", { timeout: 20_000 }, async () => {
		const { creator, cards } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1");
		const devCard = cards[0] as CharacterCard;
		const qaCard = cards[1] as CharacterCard;
		const dupA = cards[2] as CharacterCard;
		const dupB = cards[3] as CharacterCard;
		const offlineCard = cards[4] as CharacterCard;
		const { runtime: dev } = await joinCharacter(creator, devCard, "session-183-dev");
		const { runtime: qa } = await joinCharacter(creator, qaCard, "session-183-qa");
		await joinCharacter(creator, dupA, "session-183-dup-a");
		await joinCharacter(creator, dupB, "session-183-dup-b");

		// N1：注册名唯一命中 → resolved（路径形态 id）。
		const byName = await dev.resolveWhisperTarget("QA");
		expect(byName).toMatchObject({ kind: "resolved", character_id: qaCard.characterId });

		// N2：精确 character_id 零回归（含 `..` 与分隔符）。
		const byId = await dev.resolveWhisperTarget(qaCard.characterId);
		expect(byId).toMatchObject({ kind: "resolved", character_id: qaCard.characterId });

		// 解析结果投递：wire 侧仍发精确 id，服务端接受（真实 WS 往返）。
		if (byName.kind !== "resolved") throw new Error("expected resolved");
		const published = await dev.whisper(byName.character_id, "按名解析后投递");
		expect(published.published).toBe(true);

		// N3：双在线同名 → ambiguous（候选含两条 id），不投递。
		const ambiguous = await dev.resolveWhisperTarget("Dup");
		expect(ambiguous.kind).toBe("ambiguous");
		if (ambiguous.kind !== "ambiguous") throw new Error("expected ambiguous");
		expect(ambiguous.candidates.map((candidate) => candidate.character_id).sort()).toEqual(
			[dupA.characterId, dupB.characterId].sort(),
		);

		// N4：离线（配置存在但未在线）与不存在同态 → not-found，名册不含目标。
		const offline = await dev.resolveWhisperTarget("Offline");
		expect(offline.kind).toBe("not-found");
		if (offline.kind !== "not-found") throw new Error("expected not-found");
		const rosterIds = offline.roster.map((entry) => entry.character_id);
		expect(rosterIds).not.toContain(offlineCard.characterId);
		expect(rosterIds).toEqual(expect.arrayContaining([qaCard.characterId, dupA.characterId, dupB.characterId]));
		expect((await dev.resolveWhisperTarget("nobody")).kind).toBe("not-found");

		// N5：未命中/歧义路径不产生 wire 请求 → 轮次用量不变（不占额）。
		const usageOf = async (): Promise<number> => {
			const state = await dev.getGroupChatState("other");
			return state.round?.used_messages ?? -1;
		};
		const before = await usageOf();
		await dev.resolveWhisperTarget("Offline");
		await dev.resolveWhisperTarget("Dup");
		expect(await usageOf()).toBe(before);

		// 命中自己 → self（不投递）。
		expect(await dev.resolveWhisperTarget("Dev")).toMatchObject({ kind: "self" });

		// 边界：绕过解析、按注册名直发 wire 仍报既有 -32110（服务端语义未动）。
		await expect(qa.whisper("Dev", "直发注册名")).rejects.toThrow(/not online/i);
	});
});
