/**
 * B4 字符侧接线集成测试（#114，ADR-0007；挂靠 issue 09:26 版 B4 节 + QA 清单 6）。
 *
 * 覆盖（四处接线）：
 * ① 路由天然可达（character-runtime handleServerMessage → onEnvironmentMessage）
 * ② isEnvironmentEvent 门闸：board_update 进 pendingEvents 批处理（缺此被吞）
 * ③ buildContent 白板桶：谁/动作/内容摘要渲染进 agent 上下文
 * ④ 不挂 incrementPending：board_update 不产生消息流拉取（负例断言：
 *    无 [tavern-inject] latest_seq 通知、无「新消息」桶——与 group_chat_update
 *    拉取触发对照）
 *
 * 观察通道：PITAVERTEST=1 + setTestNotify（board_updates=N 计数通知）。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { setTestNotify } from "../../../src/character/group-chat-input.js";
import { JoinAttempt } from "../../../src/character/join-attempt.js";
import { type CharacterCard, loadCharacterCard } from "../../../src/config/character-card.js";
import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";

const temporaryDirectories: string[] = [];
const creatorRuntimes: CreatorRuntime[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-b4-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function startCreator(count = 1): Promise<{ creator: CreatorRuntime; characters: CharacterCard[] }> {
	const root = await createTemporaryDirectory();
	const configPath = join(root, "tavern.json");
	await mkdir(join(root, "characters"), { recursive: true });
	const cards = [
		{ name: "Dev", description: "Writes code" },
		{ name: "Arch", description: "Architecture" },
	].slice(0, count);
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
	return { creator, characters };
}

/** 真实 pi 上下文替身（同 self-echo 测试）。 */
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

async function settleJoin(runtime: CharacterRuntime, pi: ExtensionAPI): Promise<void> {
	const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
	const deadline = Date.now() + 5_000;
	while (sendMessage.mock.calls.length === 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	// join 后存在二次投递窗口（reEvaluateUnread 1s 窗口）：等待稳定后再清计数。
	await new Promise((resolve) => setTimeout(resolve, 1_500));
	runtime.saveCursor(1);
	sendMessage.mockClear();
}

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const tick = (): void => {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() > deadline) {
				reject(new Error("timeout waiting for condition"));
				return;
			}
			setTimeout(tick, 25);
		};
		tick();
	});
}

afterEach(async () => {
	setTestNotify(undefined);
	await Promise.all(creatorRuntimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("B4 字符侧四处接线（#114，integration）", () => {
	it("门闸放行 + 白板桶渲染 + 不产生消息流拉取（board_update 两套消费语义）", { timeout: 20_000 }, async () => {
		process.env.PITAVERN_TEST = "1";
		const notifications: string[] = [];
		setTestNotify((message) => notifications.push(message));

		const { creator, characters } = await startCreator();
		const character = characters[0] as CharacterCard;
		await creator.submitUserPersonaMessage("开题"); // 建轮次（对照 speak 用）
		const { runtime, pi } = await joinCharacter(creator, character, "session-b4");
		await settleJoin(runtime, pi);
		const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
		notifications.length = 0;

		// 贴条：applied → 广播 board_update（发送者也收，echo 语义）→ 门闸放行
		const result = await runtime.boardWrite("set", { content: "共识一" });
		expect(result).toEqual({ changed: true, note: { id: expect.any(String), content: "共识一" } });

		// 1s 合并窗口到期 → 1 次上下文注入（09:26 定案：字符侧窗口合并）
		await waitFor(() => notifications.some((n) => n.includes("board_updates=1")));
		const injected = sendMessage.mock.calls
			.map((call) => String((call[0] as { content?: string }).content ?? ""))
			.join("\n");

		// 白板桶渲染：谁/动作/内容摘要
		expect(injected).toContain("白板更新：");
		expect(injected).toContain("贴条：「共识一」");

		// 负例：无消息流拉取（无 latest_seq 通知、无「新消息」桶）
		expect(notifications.some((n) => n.includes("latest_seq="))).toBe(false);
		expect(injected).not.toContain("新消息：");

		// 告知/拒绝静默：remove 不存在 → changed:false → 无新通知
		const noop = await runtime.boardWrite("remove", { id: "ghost" });
		expect(noop).toEqual({ changed: false, code: "note_not_found" });
		await new Promise((resolve) => setTimeout(resolve, 1_600));
		expect(notifications.filter((n) => n.includes("board_updates=")).length).toBe(1);
	});

	it("对照：speak 仍走 group_chat_update 拉取语义（两套消费语义不混淆）", { timeout: 20_000 }, async () => {
		process.env.PITAVERN_TEST = "1";
		const notifications: string[] = [];
		setTestNotify((message) => notifications.push(message));

		const { creator, characters } = await startCreator(2);
		const [observer, speaker] = characters as [CharacterCard, CharacterCard];
		await creator.submitUserPersonaMessage("开题");
		const { runtime, pi } = await joinCharacter(creator, observer, "session-b4b");
		await settleJoin(runtime, pi);
		const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
		notifications.length = 0;

		// 另一角色发言：group_chat_update 广播 → 观察者拉取（他人消息非回声）
		const { runtime: speakerRuntime, pi: speakerPi } = await joinCharacter(creator, speaker, "session-b4c");
		await settleJoin(speakerRuntime, speakerPi);
		const speak = await speakerRuntime.speak("我的发言");
		expect(speak.published).toBe(true);

		// group_chat_update 触发拉取：latest_seq 通知 + 「新消息」桶
		await waitFor(() => notifications.some((n) => n.includes("latest_seq=")));
		const delivered = (): string =>
			sendMessage.mock.calls.map((call) => String((call[0] as { content?: string }).content ?? "")).join("\n");
		await waitFor(() => delivered().includes("新消息："));
		expect(delivered()).toContain("我的发言");
		// 无白板桶（对照方向）
		expect(delivered()).not.toContain("白板更新：");
	});
});
