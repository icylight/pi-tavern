import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { JoinAttempt } from "../../../src/character/join-attempt.js";
import { type CharacterCard, loadCharacterCard } from "../../../src/config/character-card.js";
import type { TavernConfig } from "../../../src/config/load-config.js";
import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";
import { writeCursorFile } from "../../../src/data/cursor-store.js";
import { decodeServerMessage } from "../../../src/protocol/codec.js";
import { type ConsumableMockPi, createConsumableMockPi, emitBatchConsumption } from "../../helpers/consumable-pi.js";
import { parseMessageElements } from "../../helpers/message-section.js";

/**
 * #215：结构化投递 integration 钉测（进程内模拟 pi 消费边界）。
 *
 * 证据 = 真实 CharacterRuntime/WS 投递 + mock pi 捕获的已生成 content；
 * 属 mock 证据，真实 pi 已消费 content 由 acceptance `structured-delivery.test.ts` 锚定：
 * - chain:serialize-total：元素与同查询者 fetch_messages_since 投影全字段深等（含转义往返）
 * - chain:batch-order：实时私信 + 补拉混合，逐批 sequence 升序去重且不跳号
 * - chain:legacy-history：经 decodeServerMessage 的旧 message_history 内层元素并入数组
 * - chain:cursor-consume-retry：消费确认前不推进；同步拒绝整批重投且不推进
 * - chain:rejoin-catchup：已有游标重入补拉 / 无游标新 Session 不注入 / reload 不重复拉
 */

const temporaryDirectories: string[] = [];
const creatorRuntimes: CreatorRuntime[] = [];
const characterRuntimes: CharacterRuntime[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-sd215-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function startCreator(
	names: string[],
): Promise<{ creator: CreatorRuntime; characters: Map<string, CharacterCard> }> {
	const root = await createTemporaryDirectory();
	const configPath = join(root, "tavern.json");
	await mkdir(join(root, "characters"), { recursive: true });
	const characters = new Map<string, CharacterCard>();
	for (const name of names) {
		const file = join(root, "characters", `${name.toLowerCase()}.md`);
		await writeFile(file, `---\nname: ${name}\ndescription: ${name}\n---\n${name} prompt`);
		characters.set(name, await loadCharacterCard(file, configPath));
	}
	const creator = await CreatorRuntime.startNew(
		{
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [...characters.values()],
		},
		{},
	);
	creatorRuntimes.push(creator);
	return { creator, characters };
}

async function joinCharacter(
	creator: CreatorRuntime,
	card: CharacterCard,
	sessionId: string,
	options: { cursorSequence?: number } = {},
): Promise<{ runtime: CharacterRuntime; harness: ConsumableMockPi }> {
	const root = await createTemporaryDirectory();
	const cursorPath = join(root, "cursors", `${sessionId}.json`);
	if (options.cursorSequence !== undefined) {
		writeCursorFile(cursorPath, options.cursorSequence);
	}
	const attempt = await JoinAttempt.connect(creator.activeDescriptor, sessionId, {
		cursorStorePath: cursorPath,
		triggerDebounceMs: 40,
	});
	const harness = createConsumableMockPi();
	const runtime = await attempt.claimCharacter(card.characterId, harness.pi);
	characterRuntimes.push(runtime);
	return { runtime, harness };
}

function sendMessageSpy(harness: ConsumableMockPi): ReturnType<typeof vi.fn> {
	return harness.pi.sendMessage as unknown as ReturnType<typeof vi.fn>;
}

/** 已生成的群聊输入 content（只取本模块注入，忽略其它 custom message）。 */
function contents(harness: ConsumableMockPi): string[] {
	return sendMessageSpy(harness)
		.mock.calls.map((call) => (call[0] as { customType?: string; content?: string }) ?? {})
		.filter((message) => message.customType === "pi-tavern.group-chat-input" && typeof message.content === "string")
		.map((message) => message.content as string);
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("timeout waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function elementsOf(harness: ConsumableMockPi): Array<ReturnType<typeof parseMessageElements>[number]> {
	return contents(harness).flatMap((content) => parseMessageElements(content));
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(characterRuntimes.splice(0).map((runtime) => runtime.close().catch(() => undefined)));
	await Promise.all(creatorRuntimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("structured delivery (integration)", () => {
	it("chain:serialize-total：元素与同查询者投影全字段深等（含转义往返）", { timeout: 15_000 }, async () => {
		const { creator, characters } = await startCreator(["QA"]);
		const card = characters.get("QA");
		if (!card) throw new Error("missing QA card");
		const { runtime, harness } = await joinCharacter(creator, card, "sd215-serialize");

		const marker = 'sd215-"quoted"-\\\\folder\nsecond ] line';
		await creator.submitUserPersonaMessage(marker);
		await waitFor(() => contents(harness).some((content) => content.includes("second ] line")));

		// 同视角投影对照：同一查询者（本角色）的 fetch_messages_since 元素。
		const page = await runtime.fetchMessagesSince(0);
		if (page === null) throw new Error("fetch_messages_since 未返回");
		const expected = page.messages.find(
			(entry) =>
				"method" in entry &&
				entry.method === "public_message" &&
				(entry.params as { content?: string }).content === marker,
		);
		expect(expected).toBeDefined();

		const injected = elementsOf(harness).find((entry) => entry.params.content === marker);
		expect(injected).toBeDefined();
		expect(injected).toEqual(expected);
		expect(Object.keys(injected ?? {}).sort()).toEqual(["jsonrpc", "method", "params"]);
		const params = (injected ?? { params: {} }).params;
		for (const key of ["id", "cursor", "has_more", "total_messages", "result", "latest_sequence"]) {
			expect(params).not.toHaveProperty(key);
		}
		expect(contents(harness).join("\n")).toContain("second ] line");
	});

	it("chain:batch-order：实时私信与补拉混合，逐批 sequence 升序去重且不跳号", { timeout: 20_000 }, async () => {
		const { creator, characters } = await startCreator(["QA", "Dev"]);
		const qa = characters.get("QA");
		const dev = characters.get("Dev");
		if (!qa || !dev) throw new Error("missing cards");
		const { harness: qaHarness } = await joinCharacter(creator, qa, "sd215-order-qa");
		const { runtime: devRuntime, harness: devHarness } = await joinCharacter(creator, dev, "sd215-order-dev");

		await creator.submitUserPersonaMessage("sd215-order-p1"); // seq 1
		await waitFor(() => contents(qaHarness).some((content) => content.includes("sd215-order-p1")));
		emitBatchConsumption(qaHarness.pi);
		emitBatchConsumption(devHarness.pi);

		const whisper = await devRuntime.whisper(qa.characterId, "sd215-order-w2"); // seq 2
		expect(whisper.published).toBe(true);
		await waitFor(() => contents(qaHarness).some((content) => content.includes("sd215-order-w2")));
		emitBatchConsumption(qaHarness.pi);

		await creator.submitUserPersonaMessage("sd215-order-p3"); // seq 3
		await waitFor(() => contents(qaHarness).some((content) => content.includes("sd215-order-p3")));

		const batches = contents(qaHarness).map((content) =>
			parseMessageElements(content).map((entry) => entry.params.sequence as number),
		);
		for (const batch of batches) {
			expect(batch).toEqual([...new Set(batch)].sort((left, right) => left - right));
		}
		expect(Math.max(...batches.flat())).toBe(3);
		expect(batches.flat()).toContain(2);
		expect(batches.flat()).toContain(3);
	});

	it(
		"chain:legacy-history：decodeServerMessage 通过后的旧容器内层元素并入结构化数组",
		{ timeout: 15_000 },
		async () => {
			const { creator, characters } = await startCreator(["QA"]);
			const card = characters.get("QA");
			if (!card) throw new Error("missing QA card");
			const { runtime, harness } = await joinCharacter(creator, card, "sd215-legacy");

			const legacy = {
				jsonrpc: "2.0",
				method: "message_history",
				params: {
					messages: [
						{
							jsonrpc: "2.0",
							method: "public_message",
							params: {
								event_id: "legacy-e10",
								sequence: 10,
								timestamp: "2026-09-30T00:00:00.000Z",
								sender: { type: "user_persona" },
								content: "legacy-10",
								round: { round_max_messages: 10, used_messages: 1, remaining_messages: 9 },
							},
						},
						{
							jsonrpc: "2.0",
							method: "whisper_message",
							params: {
								event_id: "legacy-e11",
								sequence: 11,
								timestamp: "2026-09-30T00:00:01.000Z",
								sender: { type: "character", character_id: "dev", name: "Dev" },
								recipient: { type: "character", character_id: card.characterId, name: card.name },
								content: "legacy-11",
								round: { round_max_messages: 10, used_messages: 1, remaining_messages: 9 },
							},
						},
						{
							jsonrpc: "2.0",
							method: "whisper_placeholder",
							params: {
								event_id: "legacy-e12",
								sequence: 12,
								timestamp: "2026-09-30T00:00:02.000Z",
								sender: { type: "character", character_id: "dev", name: "Dev" },
								recipient: { type: "character", character_id: "other", name: "Other" },
							},
						},
					],
					cursor: null,
					has_more: false,
					total_messages: 3,
				},
			};

			// 合法内层须经真实 codec 解码（不手造 JS 对象当实证）。
			const decoded = decodeServerMessage(Buffer.from(JSON.stringify(legacy)));
			runtime.onEnvironmentMessage?.(decoded);
			await waitFor(() => contents(harness).some((content) => content.includes("legacy-11")));

			const elements = elementsOf(harness);
			expect(elements.map((entry) => [entry.method, entry.params.sequence])).toEqual([
				["public_message", 10],
				["whisper_message", 11],
				["whisper_placeholder", 12],
			]);
			expect(elements[2]?.params).not.toHaveProperty("content");
			// 容器外壳（分页字段）不进入消息元素。
			expect(contents(harness).join("\n")).not.toContain("has_more");
		},
	);

	it("chain:cursor-consume-retry：消费确认前不推进；同步拒绝整批重投且不推进", { timeout: 20_000 }, async () => {
		const { creator, characters } = await startCreator(["QA"]);
		const card = characters.get("QA");
		if (!card) throw new Error("missing QA card");
		const { runtime, harness } = await joinCharacter(creator, card, "sd215-cursor");
		emitBatchConsumption(harness.pi);
		await waitFor(() => runtime.loadCursor() === 0);

		await creator.submitUserPersonaMessage("sd215-cursor-p1");
		await waitFor(() => contents(harness).some((content) => content.includes("sd215-cursor-p1")));
		// 入队不推进：必须等 pi 消费确认（message_start）。
		expect(runtime.loadCursor()).toBe(0);
		emitBatchConsumption(harness.pi);
		await waitFor(() => runtime.loadCursor() === 1);

		// 同步拒绝：整批入 retryBatch 重投，游标保持未推进。
		const sendMessage = sendMessageSpy(harness);
		sendMessage.mockImplementationOnce(() => {
			throw new Error("enqueue rejected");
		});
		const callsBefore = sendMessage.mock.calls.length;
		await creator.submitUserPersonaMessage("sd215-cursor-p2");
		await waitFor(() => sendMessage.mock.calls.length >= callsBefore + 2);
		expect(runtime.loadCursor()).toBe(1);
		emitBatchConsumption(harness.pi);
		await waitFor(() => runtime.loadCursor() === 2);
	});

	it(
		"chain:rejoin-catchup：已有游标重入补拉 / 无游标新 Session 不注入 / reload 不重复拉",
		{ timeout: 25_000 },
		async () => {
			const { creator, characters } = await startCreator(["QA", "Dev"]);
			const qa = characters.get("QA");
			const dev = characters.get("Dev");
			if (!qa || !dev) throw new Error("missing cards");

			await creator.submitUserPersonaMessage("sd215-rejoin-p1"); // seq 1
			await creator.submitUserPersonaMessage("sd215-rejoin-p2"); // seq 2

			const fetchSpy = vi.spyOn(CharacterRuntime.prototype, "fetchMessagesSince");

			// （1）已有游标 = 1：重入无需新 update 即补拉 seq 2。
			const { runtime, harness } = await joinCharacter(creator, qa, "sd215-rejoin-existing", {
				cursorSequence: 1,
			});
			await waitFor(() => contents(harness).some((content) => content.includes("sd215-rejoin-p2")));
			const injected = elementsOf(harness);
			expect(injected.some((entry) => entry.params.content === "sd215-rejoin-p2")).toBe(true);
			expect(injected.some((entry) => entry.params.content === "sd215-rejoin-p1")).toBe(false);
			expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

			// （2）reload：接管路径不额外触发拉取。
			const handoff = await runtime.detachForReload("pi-session-sd215-reload");
			const callsBeforeReload = fetchSpy.mock.calls.length;
			const reloaded = await CharacterRuntime.takeHandoff(
				handoff,
				createConsumableMockPi().pi,
				undefined,
				async () =>
					({
						configMaxMessages: 20,
						characters: [qa],
					}) as TavernConfig,
			);
			characterRuntimes.push(reloaded);
			await sleep(250);
			expect(fetchSpy.mock.calls.length).toBe(callsBeforeReload);

			// （3）无游标新 Session：不拉取、不注入进入前历史。
			const callsBeforeFresh = fetchSpy.mock.calls.length;
			const { harness: freshHarness } = await joinCharacter(creator, dev, "sd215-rejoin-fresh");
			await waitFor(() => contents(freshHarness).length > 0);
			await sleep(250);
			expect(fetchSpy.mock.calls.length).toBe(callsBeforeFresh);
			expect(contents(freshHarness).every((content) => !content.includes("sd215-rejoin-p1"))).toBe(true);
			expect(contents(freshHarness).every((content) => !content.includes("新消息："))).toBe(true);
		},
	);
});
