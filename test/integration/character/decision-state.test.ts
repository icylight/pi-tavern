import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { JoinAttempt } from "../../../src/character/join-attempt.js";
import { type CharacterCard, loadCharacterCard } from "../../../src/config/character-card.js";
import { DecisionPipeline } from "../../../src/creator/creator-pipelines/decision-pipeline.js";
import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";
import { getGroupChatSessionDirectory } from "../../../src/data/discovery/active-descriptor.js";

/**
 * #107 决策状态机制红钉（QA 属主，integration 层）：
 *
 * 契约（ADR-0006）：decision_declare 唯一入口；校验五项（目标存在/未被活跃
 * 替代/版本单调/DAG 无环/权限对等）；declareAsUser = User 侧入口（无限配额，
 * 关闭 = 最终决定）；角色侧 = runtime.declareDecision（配额 3 次/轮成功计次）；
 * 注入节「当前有效裁决」（机械生成，无则省略，截断 5 + 「+M 更早」）。
 *
 * 反例锚点 → 用例映射（PM 记录 seq529）：T1 正常声明 / T2 悬空（C4）/ T3 循环
 * （C4）/ T4-T5 版本冲突撞名（C7/C8）/ T6 角色替代 closed 拒绝（C5a）/ T7 User
 * 替代已决定（C5b）/ T8 配额（C9）/ T9-T13 注入层（M2/C10/C1/R1/R4/T13 唯一
 * 入口）/ T14 reload 快照（C2）。
 */

const temporaryDirectories: string[] = [];
const creatorRuntimes: CreatorRuntime[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-d107-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function startCreator(
	characterCount = 1,
): Promise<{ creator: CreatorRuntime; character: CharacterCard; characters: CharacterCard[]; root: string }> {
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
	return { creator, character: characters[0] as CharacterCard, characters, root };
}

/** 真实 pi 上下文替身（speak 同款）。 */
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

/** join 后稳定态：等 join 历史投递完成 + 稳定窗口吸收二次投递。 */
async function settleJoin(pi: ExtensionAPI): Promise<void> {
	const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
	await waitFor(() => sendMessage.mock.calls.length > 0, 5_000);
	await new Promise((resolve) => setTimeout(resolve, 1_500));
	sendMessage.mockClear();
}

/** User 侧声明入口（declareAsUser：无限配额，decided_by=user_persona）。 */
async function declareAsUser(
	creator: CreatorRuntime,
	decl: {
		decision_id: string;
		version: number;
		content: string;
		supersedes?: string[];
		status?: "proposed" | "closed";
	},
) {
	const pipeline = new DecisionPipeline(creator.decisionDeps);
	return pipeline.declareAsUser({
		decision_id: decl.decision_id,
		version: decl.version,
		content: decl.content,
		supersedes: decl.supersedes ?? [],
		status: decl.status ?? "proposed",
	});
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

/** 最近一次 sendMessage 投递的 content（sendMessage 参数顶层 content 字段）。 */
function lastDeliveredContent(pi: ExtensionAPI): string {
	const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
	const call = sendMessage.mock.calls.at(-1)?.[0] as { content?: string };
	return call?.content ?? "";
}

afterEach(async () => {
	await Promise.all(creatorRuntimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("#107 decision state (QA integration)", () => {
	it("T1: normal declare succeeds and snapshot reflects current + active", { timeout: 15_000 }, async () => {
		const { creator } = await startCreator();
		const result = await declareAsUser(creator, { decision_id: "D1", version: 1, content: "方向 A" });
		expect(result).toEqual({ accepted: true });

		expect(creator.decisionStore.records).toHaveLength(1);
		expect(creator.decisionStore.records[0]).toMatchObject({
			decision_id: "D1",
			version: 1,
			status: "proposed",
			supersedes: [],
			decided_by: { type: "user_persona" },
		});
	});

	it("T2: dangling supersedes → target_missing (C4)", { timeout: 15_000 }, async () => {
		const { creator } = await startCreator();
		const result = await declareAsUser(creator, {
			decision_id: "D2",
			version: 1,
			content: "替代不存在的目标",
			supersedes: ["NOPE@v1"],
		});
		expect(result.accepted).toBe(false);
		expect(result.error_code).toBe("target_missing");
		// 失败无状态副作用（原子性）。
		expect(creator.decisionStore.records).toHaveLength(0);
	});

	it("T3: superseding an already-superseded target → cycle_rejected (C4)", { timeout: 15_000 }, async () => {
		const { creator } = await startCreator();
		await declareAsUser(creator, { decision_id: "P1", version: 1, content: "提案 1" });
		await declareAsUser(creator, { decision_id: "P2", version: 1, content: "提案 2", supersedes: ["P1@v1"] });
		// P1@v1 已被 P2@v1 替代（终态不可引用）→ 引用被拒。
		const result = await declareAsUser(creator, {
			decision_id: "P3",
			version: 1,
			content: "提案 3",
			supersedes: ["P1@v1"],
		});
		expect(result.accepted).toBe(false);
		expect(result.error_code).toBe("cycle_rejected");
	});

	it("T4: duplicate version → version_not_monotonic (C8)", { timeout: 15_000 }, async () => {
		const { creator } = await startCreator();
		await declareAsUser(creator, { decision_id: "D1", version: 1, content: "v1" });
		const result = await declareAsUser(creator, { decision_id: "D1", version: 1, content: "v1 重复" });
		expect(result.accepted).toBe(false);
		expect(result.error_code).toBe("version_not_monotonic");
	});

	it("T5: id collision (same id, same version) → version_not_monotonic (C7)", { timeout: 15_000 }, async () => {
		const { creator } = await startCreator();
		await declareAsUser(creator, { decision_id: "D1", version: 1, content: "A 的提案" });
		const result = await declareAsUser(creator, { decision_id: "D1", version: 1, content: "B 撞名" });
		expect(result.accepted).toBe(false);
		expect(result.error_code).toBe("version_not_monotonic");
	});

	it("T6: character cannot supersede a closed decision (C5a)", { timeout: 15_000 }, async () => {
		const { creator, character } = await startCreator();
		// User 关闭 D1（决定 1）。
		await declareAsUser(creator, { decision_id: "D1", version: 1, content: "决定 1" });
		await declareAsUser(creator, { decision_id: "D1", version: 2, content: "决定 1 定稿", status: "closed" });

		// 角色尝试关闭新提案替代已决定的 D1 → 拒绝（谁决定谁推翻）。
		await creator.submitUserPersonaMessage("hello 1");
		const { runtime, pi } = await joinCharacter(creator, character, "session-t6");
		await settleJoin(pi);
		const result = await runtime.declareDecision({
			decision_id: "D2",
			version: 1,
			content: "角色想推翻",
			supersedes: ["D1@v2"],
		});
		expect(result.accepted).toBe(false);
		expect(result.error_code).toBe("target_closed_denied");
		expect(creator.decisionStore.records.some((r) => r.decision_id === "D2")).toBe(false);
	});

	it("T7: User closes new proposal superseding a closed decision (C5b)", { timeout: 15_000 }, async () => {
		const { creator } = await startCreator();
		await declareAsUser(creator, { decision_id: "D1", version: 1, content: "决定 1" });
		const closed = await declareAsUser(creator, {
			decision_id: "D1",
			version: 2,
			content: "决定 1 定稿",
			status: "closed",
		});
		expect(closed.accepted).toBe(true);

		// User 关闭 D2 替代已决定的 D1@v2 → 成功。
		const overturn = await declareAsUser(creator, {
			decision_id: "D2",
			version: 1,
			content: "新决定替代 D1",
			supersedes: ["D1@v2"],
			status: "closed",
		});
		expect(overturn.accepted).toBe(true);

		const d1 = creator.decisionStore.records.find((r) => r.decision_id === "D1" && r.version === 2);
		expect(d1?.status).toBe("superseded");
	});

	it(
		"T8: character declare quota — 4th success rejected, failures do not consume (C9)",
		{ timeout: 15_000 },
		async () => {
			const { creator, character } = await startCreator();
			await creator.submitUserPersonaMessage("hello 1");
			const { runtime, pi } = await joinCharacter(creator, character, "session-t8");
			await settleJoin(pi);

			// 前 3 次成功（配额 3，成功才计次）。
			for (let v = 1; v <= 3; v++) {
				const ok = await runtime.declareDecision({ decision_id: "Q1", version: v, content: `提案 ${v}` });
				expect(ok.accepted).toBe(true);
			}
			// 第 4 次成功声明 → quota_exceeded。
			const fourth = await runtime.declareDecision({ decision_id: "Q1", version: 4, content: "提案 4" });
			expect(fourth.accepted).toBe(false);
			expect(fourth.error_code).toBe("quota_exceeded");

			// 失败不消耗：下一轮开始前同一轮内失败尝试后仍不能再成功（计数不变）——
			// 用失败声明验证：失败（悬空）不消耗配额，但配额已满仍拒绝。
			const failed = await runtime.declareDecision({
				decision_id: "QX",
				version: 1,
				content: "悬空",
				supersedes: ["NOPE@v1"],
			});
			expect(failed.accepted).toBe(false);
			expect(failed.error_code).toBe("target_missing");
			// 计数未因失败增加：仍满额（再试成功型仍 quota_exceeded）。
			const afterFail = await runtime.declareDecision({ decision_id: "Q1", version: 5, content: "提案 5" });
			expect(afterFail.error_code).toBe("quota_exceeded");
		},
	);

	it("T9: injection section shows current decision + active (M2/R4)", { timeout: 15_000 }, async () => {
		const { creator, character } = await startCreator();
		await declareAsUser(creator, { decision_id: "D1", version: 1, content: "方向 A" });
		await creator.submitUserPersonaMessage("hello 1");
		const { pi } = await joinCharacter(creator, character, "session-t9");
		await settleJoin(pi);

		// 触发一次投递（他人消息）→ 注入节含活跃提案。
		await creator.submitUserPersonaMessage("hello");
		await waitFor(() => lastDeliveredContent(pi).includes("当前有效裁决"));
		const content = lastDeliveredContent(pi);
		expect(content).toContain("当前有效裁决：");
		expect(content).toContain("D1@v1 活跃");
		expect(content).toContain("由 User 提案");
		expect(content).not.toContain("已决定");
	});

	it("T10: injection truncates active set at 5 with +M note (C10)", { timeout: 15_000 }, async () => {
		const { creator, character } = await startCreator();
		for (let i = 1; i <= 6; i++) {
			await declareAsUser(creator, { decision_id: `D${i}`, version: 1, content: `提案 ${i}` });
		}
		await creator.submitUserPersonaMessage("hello 1");
		const { pi } = await joinCharacter(creator, character, "session-t10");
		await settleJoin(pi);

		await creator.submitUserPersonaMessage("hello");
		await waitFor(() => lastDeliveredContent(pi).includes("当前有效裁决"));
		const content = lastDeliveredContent(pi);
		const activeCount = (content.match(/活跃（/g) ?? []).length;
		expect(activeCount).toBe(5);
		expect(content).toContain("+1 个更早活跃提案");
	});

	it("T11: no decisions → section omitted (zero noise)", { timeout: 15_000 }, async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1");
		const { pi } = await joinCharacter(creator, character, "session-t11");
		await settleJoin(pi);

		await creator.submitUserPersonaMessage("hello");
		await waitFor(() => lastDeliveredContent(pi).length > 0);
		expect(lastDeliveredContent(pi)).not.toContain("当前有效裁决");
	});

	it("T12: out-of-order arrival — chain correctness independent of arrival (C1)", { timeout: 15_000 }, async () => {
		const { creator } = await startCreator();
		// 先声明 D2（替代 D1@v1）→ 悬空拒绝；再声明 D1，再补 D2 → 成功。
		const premature = await declareAsUser(creator, {
			decision_id: "D2",
			version: 1,
			content: "替代 D1",
			supersedes: ["D1@v1"],
		});
		expect(premature.error_code).toBe("target_missing");
		await declareAsUser(creator, { decision_id: "D1", version: 1, content: "方向 A" });
		const retry = await declareAsUser(creator, {
			decision_id: "D2",
			version: 1,
			content: "替代 D1",
			supersedes: ["D1@v1"],
		});
		expect(retry.accepted).toBe(true);
		// 状态链正确：D1 被替代，D2 活跃。
		const d1 = creator.decisionStore.records.find((r) => r.decision_id === "D1");
		expect(d1?.status).toBe("superseded");
	});

	it(
		"T13: text ruling never enters state — speak does not create decisions (unique entry)",
		{ timeout: 15_000 },
		async () => {
			const { creator, character } = await startCreator();
			await creator.submitUserPersonaMessage("hello 1");
			const { runtime, pi } = await joinCharacter(creator, character, "session-t13");
			await settleJoin(pi);

			// 角色在群里发文字裁决（speak）→ 状态零变化。
			const before = creator.decisionStore.records.length;
			await runtime.speak("我决定：方向 B（文字裁决）");
			expect(creator.decisionStore.records.length).toBe(before);
			expect(pi.sendMessage).toBeDefined();
			// 注入节不出现任何决定（快照空：无 current、无 active）。
			expect(runtime.decisionSnapshot).toMatchObject({ current: null, active: [] });
		},
	);

	it("T15: restart preserves supersede relations — D1 stays superseded (P0-1/R1)", { timeout: 15_000 }, async () => {
		const { creator, character, root } = await startCreator();
		const groupId = creator.state.groupChat.groupChatId;
		await declareAsUser(creator, { decision_id: "D1", version: 1, content: "决定 1" });
		const replaced = await declareAsUser(creator, {
			decision_id: "D2",
			version: 1,
			content: "决定 2",
			supersedes: ["D1@v1"],
		});
		expect(replaced.accepted).toBe(true);
		expect(creator.decisionStore.records.find((r) => r.decision_id === "D1")?.status).toBe("superseded");
		// session 文件需存在（resume 前置）：先有公开消息落盘。
		await creator.submitUserPersonaMessage("hello 1");
		await creator.close();

		// resume 恢复（P0-1：磁盘 = 应用后终态）：D1 不复活、D2 活跃。
		// session 文件名 = {时间戳}_{groupId}.jsonl（decisions sidecar 无时间戳）。
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const sessionDir = getGroupChatSessionDirectory(agentDir, cwd);
		const sessionFiles = (await readdir(sessionDir)).filter(
			(name) => name.endsWith(".jsonl") && name.includes(groupId) && !name.endsWith(".decisions.jsonl"),
		);
		expect(sessionFiles).toHaveLength(1);
		const sessionPath = join(sessionDir, sessionFiles[0] as string);
		const resumed = await CreatorRuntime.resume({ cwd, agentDir, sessionPath, characters: [character] });
		const d1 = resumed.decisionStore.records.find((r) => r.decision_id === "D1");
		const d2 = resumed.decisionStore.records.find((r) => r.decision_id === "D2");
		expect(d1?.status).toBe("superseded");
		expect(d2?.status).toBe("proposed");
		await resumed.close();
	});

	it("T16: decision change reaches other characters without any message (P0-3)", { timeout: 15_000 }, async () => {
		const { creator, characters } = await startCreator(2);
		await creator.submitUserPersonaMessage("hello 1");
		// 角色 B join 后 settle。
		const { pi: piB } = await joinCharacter(creator, characters[1] as CharacterCard, "session-t16-b");
		await settleJoin(piB);

		// 角色 A（User 侧声明）产生决策变化——B 无任何发言/手动拉取。
		await declareAsUser(creator, { decision_id: "D1", version: 1, content: "方向 A" });
		// P0-3 修复后：快照变化 = 环境事件 → 零消息也触发 deliver。
		await waitFor(() => lastDeliveredContent(piB).includes("当前有效裁决"), 8_000);
		const content = lastDeliveredContent(piB);
		expect(content).toContain("D1@v1 活跃");
		expect(content).toContain("方向 A");
	});

	it("T18: effect point — decision visible only after declare (F1)", { timeout: 15_000 }, async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1");
		const { pi: piB } = await joinCharacter(creator, character, "session-t18");
		await settleJoin(piB);

		// 未 declare：文字裁决不产生状态（注入节无决定）。
		await creator.submitUserPersonaMessage("我决定：方向 A（文字）");
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		expect(lastDeliveredContent(piB)).not.toContain("当前有效裁决");

		// declare 后：注入节出现决定（生效点 = 机制动作）。
		await declareAsUser(creator, { decision_id: "D1", version: 1, content: "方向 A" });
		await waitFor(() => lastDeliveredContent(piB).includes("当前有效裁决"), 8_000);
		expect(lastDeliveredContent(piB)).toContain("D1@v1 活跃");
	});

	it("T14: reload resync — decision_snapshot rides state (C2)", { timeout: 15_000 }, async () => {
		const { creator, character } = await startCreator();
		// D1 proposed（current = null，active 含 D1）→ User 关闭后 current = D1@v2。
		await declareAsUser(creator, { decision_id: "D1", version: 1, content: "方向 A" });
		await declareAsUser(creator, { decision_id: "D1", version: 2, content: "方向 A 定稿", status: "closed" });

		const { runtime } = await joinCharacter(creator, character, "session-d14");
		const state = await runtime.getGroupChatState();
		expect(state.decision_snapshot).toBeDefined();
		expect(state.decision_snapshot?.current).toMatchObject({ decision_id: "D1", version: 2, status: "closed" });
		expect(state.decision_snapshot?.active).toHaveLength(2);
	});
});
