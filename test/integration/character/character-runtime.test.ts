import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { JoinAttempt } from "../../../src/character/join-attempt.js";
import { type CharacterCard, loadCharacterCard } from "../../../src/config/character-card.js";
import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";

const temporaryDirectories: string[] = [];
const creatorRuntimes: CreatorRuntime[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-m7-"));
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
	const character = characters[0];
	if (!character) {
		throw new Error("startCreator requires at least one character");
	}
	return { creator, character, characters };
}

afterEach(async () => {
	await Promise.all(creatorRuntimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("M7 message fetch (ISSUE-012)", () => {
	it("pulls the increment since a cursor and heals gaps (A3/A4)", async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1");
		await creator.submitUserPersonaMessage("hello 2");
		await creator.submitUserPersonaMessage("hello 3");

		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-m7-fetch", {});
		const runtime = await attempt.claimCharacter(character.characterId);

		// 从游标之后增量拉取：仅更新的消息，按序。
		const pulled = await runtime.fetchMessagesSince(1);
		expect(pulled).not.toBeNull();
		expect(pulled?.messages.map((m) => (m as { params?: { sequence?: number } }).params?.sequence)).toEqual([2, 3]);
		expect(pulled?.latestSequence).toBe(3);
		expect(pulled?.totalMessages).toBe(3);

		// 缺口修复：跳过某条消息的游标仍会返回其后的
		// 每一条消息（服务端按序号过滤，无窗口限制）。
		const gapHealed = await runtime.fetchMessagesSince(0);
		expect(gapHealed?.messages.map((m) => (m as { params?: { sequence?: number } }).params?.sequence)).toEqual([
			1, 2, 3,
		]);

		// 最新消息之后没有新内容。
		const empty = await runtime.fetchMessagesSince(3);
		expect(empty?.messages).toEqual([]);
	});

	it("persists the delivery cursor atomically and reloads it (A2)", async () => {
		const root = await createTemporaryDirectory();
		const characterPath = join(root, "characters", "architect.md");
		const configPath = join(root, "tavern.json");
		await mkdir(join(root, "characters"), { recursive: true });
		await writeFile(characterPath, "---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt");
		const character = await loadCharacterCard(characterPath, configPath);
		const creator = await CreatorRuntime.startNew(
			{
				cwd: join(root, "project"),
				agentDir: join(root, "agent"),
				characters: [character],
			},
			{},
		);
		creatorRuntimes.push(creator);

		const cursorPath = join(root, "cursors", "group-1.json");
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-m7-cursor", {
			cursorStorePath: cursorPath,
		});
		const runtime = await attempt.claimCharacter(character.characterId);

		// 尚无游标：首次加入回退到完整历史路径。
		expect(runtime.loadCursor()).toBeNull();

		// 成功投递后，游标持久化并可重载。
		runtime.saveCursor(7);
		expect(runtime.loadCursor()).toBe(7);
		const stored = JSON.parse(await readFile(cursorPath, "utf8")) as { last_sequence?: number };
		expect(stored.last_sequence).toBe(7);
	});

	it("treats a missing or corrupt cursor store as no cursor", async () => {
		const { creator, character } = await startCreator();
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-m7-nocursor", {
			cursorStorePath: join(await createTemporaryDirectory(), "nowhere", "cursor.json"),
		});
		const runtime = await attempt.claimCharacter(character.characterId);

		expect(runtime.loadCursor()).toBeNull();

		const { creator: creator2, character: character2 } = await startCreator();
		const corruptPath = join(await createTemporaryDirectory(), "cursors", "group-1.json");
		await mkdir(join(corruptPath, ".."), { recursive: true });
		await writeFile(corruptPath, "{ not json");
		const attempt2 = await JoinAttempt.connect(creator2.activeDescriptor, "session-m7-corrupt", {
			cursorStorePath: corruptPath,
		});
		const runtime2 = await attempt2.claimCharacter(character2.characterId);
		expect(runtime2.loadCursor()).toBeNull();
	});

	it("swallows a cursor write failure while advancing the in-memory position (best-effort)", async () => {
		const { creator, character } = await startCreator();
		const root = await createTemporaryDirectory();
		// 父路径中的同名文件迫使 mkdirSync(recursive) 以
		// ENOTDIR 失败：写入永远无法落地，但内存游标会推进。
		const blocker = join(root, "blocker");
		await writeFile(blocker, "not a directory");
		const cursorPath = join(blocker, "sub", "cursor.json");

		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-m7-writefail", {
			cursorStorePath: cursorPath,
		});
		const runtime = await attempt.claimCharacter(character.characterId);

		expect(runtime.loadCursor()).toBeNull();
		expect(() => runtime.saveCursor(9)).not.toThrow();
		// 尽管写入失败，内存游标仍推进……
		expect(runtime.loadCursor()).toBe(9);
		// ……且磁盘上没有任何写入。
		await expect(readFile(cursorPath, "utf8")).rejects.toThrow();
	});

	it("treats an EISDIR cursor path as no cursor (runtime swallows the primitive's throw)", async () => {
		const { creator, character } = await startCreator();
		const root = await createTemporaryDirectory();
		// 原语在 EISDIR（IO 失败）时抛错；运行时的尽力而为
		// 编排吞掉该错误并报告无游标，依决策 7。
		const eisdirPath = join(root, "cursors", "group-1.json");
		await mkdir(eisdirPath, { recursive: true });

		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-m7-eisdir", {
			cursorStorePath: eisdirPath,
		});
		const runtime = await attempt.claimCharacter(character.characterId);

		expect(runtime.loadCursor()).toBeNull();
	});

	it("isolates cursors per session: two sessions never advance each other's cursor (P0)", async () => {
		const { creator, characters } = await startCreator(2);
		await creator.submitUserPersonaMessage("one"); // seq 1
		await creator.submitUserPersonaMessage("two"); // seq 2
		await creator.submitUserPersonaMessage("three"); // seq 3

		const root = await createTemporaryDirectory();
		const cursorDir = join(root, "cursors", "group-iso");
		// #100：解构 + 一次守卫（fixture 契约：startCreator(2) 恒 2 成员）——
		// 替代 `!` 断言（noNonNullAssertion 警告消除，风格同 src 契约守卫）。
		const [characterA, characterB] = characters;
		if (!characterA || !characterB) {
			throw new Error("startCreator(2) 应返回 2 个角色（fixture 契约）");
		}
		const attemptA = await JoinAttempt.connect(creator.activeDescriptor, "session-iso-a", {
			cursorStorePath: join(cursorDir, "session-iso-a.json"),
		});
		const runtimeA = await attemptA.claimCharacter(characterA.characterId);
		const attemptB = await JoinAttempt.connect(creator.activeDescriptor, "session-iso-b", {
			cursorStorePath: join(cursorDir, "session-iso-b.json"),
		});
		const runtimeB = await attemptB.claimCharacter(characterB.characterId);

		// A 已投递到序号 3；B 仅投递了序号 1。
		runtimeA.saveCursor(3);
		runtimeB.saveCursor(1);

		// 各自独立文件：互不推进、无共享临时文件冲突。
		expect(JSON.parse(await readFile(join(cursorDir, "session-iso-a.json"), "utf8")).last_sequence).toBe(3);
		expect(JSON.parse(await readFile(join(cursorDir, "session-iso-b.json"), "utf8")).last_sequence).toBe(1);
		expect(runtimeA.loadCursor()).toBe(3);
		expect(runtimeB.loadCursor()).toBe(1);

		// B 从自己的游标拉取：无跳过、无重复投递。
		const pulled = await runtimeB.fetchMessagesSince(1);
		expect(pulled?.messages.map((m) => (m as { params?: { sequence?: number } }).params?.sequence)).toEqual([2, 3]);
	});

	it("does not adopt the v1 group-chat cursor: a fresh session pulls from full history (P0)", async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("one"); // seq 1
		await creator.submitUserPersonaMessage("two"); // seq 2
		await creator.submitUserPersonaMessage("three"); // seq 3

		const root = await createTemporaryDirectory();
		const groupId = "group-legacy";
		// v1 共享游标被其他会话推进（如 120）时不携带
		// 会话身份：采纳它可能导致本会话跳过 91-120。
		const legacyPath = join(root, "cursors", `${groupId}.json`);
		await mkdir(join(root, "cursors"), { recursive: true });
		await writeFile(legacyPath, JSON.stringify({ last_sequence: 120, updated_at: "2026-01-01T00:00:00.000Z" }));

		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-legacy", {
			cursorStorePath: join(root, "cursors", groupId, "session-legacy.json"),
		});
		const runtime = await attempt.claimCharacter(character.characterId);

		// 旧版文件永不被采纳：无会话游标即无游标。
		expect(runtime.loadCursor()).toBeNull();

		// 从 0 拉取完整历史：无跳过，重复可接受。
		const pulled = await runtime.fetchMessagesSince(0);
		expect(pulled?.messages.map((m) => (m as { params?: { sequence?: number } }).params?.sequence)).toEqual([1, 2, 3]);

		// 保存仅写入会话文件；旧版文件保持不动。
		runtime.saveCursor(3);
		const sessionFile = join(root, "cursors", groupId, "session-legacy.json");
		expect(JSON.parse(await readFile(sessionFile, "utf8")).last_sequence).toBe(3);
		expect(JSON.parse(await readFile(legacyPath, "utf8")).last_sequence).toBe(120);
	});

	it("writes concurrent session cursors atomically without clobbering (P0)", async () => {
		const { creator, characters } = await startCreator(2);
		const root = await createTemporaryDirectory();
		const cursorDir = join(root, "cursors", "group-conc");
		// #100：解构 + 守卫（同 group-iso，fixture 契约）。
		const [characterA, characterB] = characters;
		if (!characterA || !characterB) {
			throw new Error("startCreator(2) 应返回 2 个角色（fixture 契约）");
		}
		const attemptA = await JoinAttempt.connect(creator.activeDescriptor, "session-conc-a", {
			cursorStorePath: join(cursorDir, "session-conc-a.json"),
		});
		const runtimeA = await attemptA.claimCharacter(characterA.characterId);
		const attemptB = await JoinAttempt.connect(creator.activeDescriptor, "session-conc-b", {
			cursorStorePath: join(cursorDir, "session-conc-b.json"),
		});
		const runtimeB = await attemptB.claimCharacter(characterB.characterId);

		// 跨会话交错保存：按会话分文件意味着无共享
		// 临时文件名，也无会话间后写覆盖冲突。
		runtimeA.saveCursor(5);
		runtimeB.saveCursor(9);
		runtimeA.saveCursor(6);

		expect(JSON.parse(await readFile(join(cursorDir, "session-conc-a.json"), "utf8")).last_sequence).toBe(6);
		expect(JSON.parse(await readFile(join(cursorDir, "session-conc-b.json"), "utf8")).last_sequence).toBe(9);
		// 共享目录中无残留临时文件。
		const leftovers = (await readdir(cursorDir)).filter((name) => name.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
	});

	it("resumes the same session cursor across a reload handoff (P0)", async () => {
		const { creator, character } = await startCreator();
		const root = await createTemporaryDirectory();
		const cursorPath = join(root, "cursors", "group-reload", "session-reload.json");

		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-reload", {
			cursorStorePath: cursorPath,
		});
		const runtime = await attempt.claimCharacter(character.characterId);
		runtime.saveCursor(7);

		// 重载交接携带 cursorStorePath；新运行时从
		// 同一会话游标恢复，无重复投递。
		const handoff = await runtime.detachForReload("session-reload");
		const resumed = await CharacterRuntime.takeHandoff(handoff);
		expect(resumed.loadCursor()).toBe(7);
		const pulled = await resumed.fetchMessagesSince(7);
		expect(pulled?.messages).toEqual([]);

		await resumed.close();
	});
});

describe("ISSUE-013 B: speak staleness client side", () => {
	it("B1: a stale speak is rejected with the missing range; quota untouched", async () => {
		const { creator, character } = await startCreator();
		// 最新序号为 2；角色尚未看到任何消息。
		await creator.submitUserPersonaMessage("one");
		await creator.submitUserPersonaMessage("two");

		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-b1", {});
		const runtime = await attempt.claimCharacter(character.characterId);

		const result = await runtime.speak("stale reply");
		expect(result.published).toBe(false);
		expect(result.reason).toBe("stale");
		expect(result.missingFrom).toBe(1);
		expect(result.missingTo).toBe(2);
		expect(result.autoRecover).toBe(true);
		// B4：被拒绝的发言未消耗配额也未触发手举。
		expect(creator.state.round?.usedMessages).toBe(0);
		expect(creator.state.onlineCharacters.get("session-b1")?.handRaised).toBe(false);
	});

	it("B6: consecutive speaks publish — own echo does not self-reject", async () => {
		const root = await createTemporaryDirectory();
		const cursorPath = join(root, "cursors", "group.json");
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("one"); // 序号 1，轮次已创建

		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-b6", {
			cursorStorePath: cursorPath,
		});
		const runtime = await attempt.claimCharacter(character.characterId);
		// 模拟投递管线已投递序号 1（加入历史）。
		runtime.saveCursor(1);

		const first = await runtime.speak("one");
		expect(first.published).toBe(true);
		expect(first.sequence).toBe(2);

		// 若无 B6，已见序号仍为 1，这第二条发言
		// 会相对角色自己的消息被判为过期。
		const second = await runtime.speak("two");
		expect(second.published).toBe(true);
		expect(second.sequence).toBe(3);
	});

	it("B5: auto-recovery budget exhausts after two stale speaks in the same round", async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("one");
		await creator.submitUserPersonaMessage("two");

		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-b5", {});
		const runtime = await attempt.claimCharacter(character.characterId);

		const first = await runtime.speak("r1");
		expect(first.autoRecover).toBe(true);
		const second = await runtime.speak("r2");
		expect(second.autoRecover).toBe(true);
		// 预算耗尽：第三次拒绝不得自动拉取。
		const third = await runtime.speak("r3");
		expect(third.autoRecover).toBe(false);
		expect(third.reason).toBe("stale");
	});

	it("B5: budget resets when the round snapshot changes", async () => {
		const root = await createTemporaryDirectory();
		const cursorPath = join(root, "cursors", "group.json");
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("one"); // seq 1

		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-b5r", {
			cursorStorePath: cursorPath,
		});
		const runtime = await attempt.claimCharacter(character.characterId);
		runtime.saveCursor(1);

		// 轮次状态 10:0 下的两次过期发言。
		await creator.submitUserPersonaMessage("two"); // 最新 2 > 已见 1
		expect((await runtime.speak("r1")).autoRecover).toBe(true);
		expect((await runtime.speak("r2")).autoRecover).toBe(true);

		// 已发布的发言改变轮次快照（10:0 → 10:1）。
		runtime.saveCursor(2);
		const published = await runtime.speak("fresh");
		expect(published.published).toBe(true);

		// 再次过期：预算随轮次快照重置。
		await creator.submitUserPersonaMessage("three"); // 最新 4 > 已见 3
		const afterReset = await runtime.speak("r3");
		expect(afterReset.autoRecover).toBe(true);
	});
});
