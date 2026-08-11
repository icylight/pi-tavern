import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { JoinAttempt } from "../../../src/character/join-attempt.js";
import { type CharacterCard, loadCharacterCard } from "../../../src/config/character-card.js";
import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";
import type { ServerMessage } from "../../../src/protocol/messages.js";

const temporaryDirectories: string[] = [];
const creatorRuntimes: CreatorRuntime[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-context-window-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function startCreator(): Promise<{ creator: CreatorRuntime; character: CharacterCard }> {
	const root = await createTemporaryDirectory();
	const configPath = join(root, "tavern.json");
	await mkdir(join(root, "characters"), { recursive: true });
	const card = { name: "QA", description: "QA" };
	await writeFile(
		join(root, "characters", "qa.md"),
		`---\nname: ${card.name}\ndescription: ${card.description}\n---\n${card.name} prompt`,
	);
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

function sequences(messages: ServerMessage[] | null | undefined): number[] {
	return (messages ?? []).map((m) => (m as { params?: { sequence?: number } }).params?.sequence ?? -1);
}

afterEach(async () => {
	await Promise.all(creatorRuntimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("context window: 拉取附加上下文窗口（方案 A，零协议变更）", () => {
	it("窗口=1：多带最近已投递 1 条（sequence=C）+ 未读全量，升序无重复", async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("seed 1");
		await creator.submitUserPersonaMessage("seed 2");
		await creator.submitUserPersonaMessage("seed 3");

		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-cw-1", {});
		const runtime = await attempt.claimCharacter(character.characterId);

		// 服务端 fetch_messages_since 语义 = sequence > since（严格大于）：
		// 游标 = 2（已投递 1..2），窗口 1 → adjustedSince = max(0, 2-1) = 1
		// → 返回 >1 = [2,3]：多带的已读上下文 = sequence 2（最近已投递，跨 run 重复注入属预期设计）。
		const pulled = await runtime.fetchMessagesSince(2, 1);
		expect(pulled).not.toBeNull();
		expect(sequences(pulled?.messages)).toEqual([2, 3]);
		expect(pulled?.latestSequence).toBe(3);
	});

	it("窗口大于历史深度：起点 clamp 到 0，取实际可用全量", async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("seed 1");
		await creator.submitUserPersonaMessage("seed 2");
		await creator.submitUserPersonaMessage("seed 3");

		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-cw-clamp", {});
		const runtime = await attempt.claimCharacter(character.characterId);

		// 游标 = 2，窗口 10 > 历史深度 → 起点 max(0, 2-10) = 0 → 全量 1,2,3
		const pulled = await runtime.fetchMessagesSince(2, 10);
		expect(pulled).not.toBeNull();
		expect(sequences(pulled?.messages)).toEqual([1, 2, 3]);
	});

	it("默认 0 行为不变：无窗口参数只返回未读（> 游标）", async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("seed 1");
		await creator.submitUserPersonaMessage("seed 2");
		await creator.submitUserPersonaMessage("seed 3");

		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-cw-0", {});
		const runtime = await attempt.claimCharacter(character.characterId);

		const pulled = await runtime.fetchMessagesSince(2);
		expect(pulled).not.toBeNull();
		expect(sequences(pulled?.messages)).toEqual([3]);
	});

	it("窗口拉取不更新游标存储值（额外 N 条不消费未读水位）", async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("seed 1");
		await creator.submitUserPersonaMessage("seed 2");
		await creator.submitUserPersonaMessage("seed 3");

		const root = await createTemporaryDirectory();
		const cursorPath = join(root, "cursors", "group-cw.json");
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-cw-cursor", {
			cursorStorePath: cursorPath,
		});
		const runtime = await attempt.claimCharacter(character.characterId);

		runtime.saveCursor(2);
		const pulled = await runtime.fetchMessagesSince(2, 1);
		expect(pulled).not.toBeNull();
		// 窗口拉取（含游标自身已读）后游标存储值仍 = 2，不被窗口推进
		expect(runtime.loadCursor()).toBe(2);
	});

	it("reload 移交后窗口仍生效（getter 跨 handoff 延续，与 join 行为一致）", async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("seed 1");
		await creator.submitUserPersonaMessage("seed 2");
		await creator.submitUserPersonaMessage("seed 3");

		const root = await createTemporaryDirectory();
		const cursorPath = join(root, "cursors", "group-reload-cw.json");
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-reload-cw", {
			cursorStorePath: cursorPath,
			getFetchContextWindow: () => 1,
		});
		const runtime = await attempt.claimCharacter(character.characterId);
		runtime.saveCursor(2);

		// 重载交接：窗口 getter 随 handoff 快照转移（函数引用，跨移交实时求值）。
		const handoff = await runtime.detachForReload("session-reload-cw");
		const resumed = await CharacterRuntime.takeHandoff(handoff);
		// 无显式窗口参数 → 窗口来自 getter = 1 → 返回 [2,3]（游标自身 + 未读）
		const pulled = await resumed.fetchMessagesSince(2);
		expect(pulled).not.toBeNull();
		expect(sequences(pulled?.messages)).toEqual([2, 3]);

		await resumed.close();
	});

	it("reload 无 getter（缺省 undefined）→ 窗口 0 兜底，只取未读", async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("seed 1");
		await creator.submitUserPersonaMessage("seed 2");
		await creator.submitUserPersonaMessage("seed 3");

		const root = await createTemporaryDirectory();
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-reload-cw0", {
			cursorStorePath: join(root, "cursors", "group-reload-cw0.json"),
		});
		const runtime = await attempt.claimCharacter(character.characterId);
		runtime.saveCursor(2);
		const handoff = await runtime.detachForReload("session-reload-cw0");
		const resumed = await CharacterRuntime.takeHandoff(handoff);
		const pulled = await resumed.fetchMessagesSince(2);
		expect(pulled).not.toBeNull();
		expect(sequences(pulled?.messages)).toEqual([3]);

		await resumed.close();
	});
});
