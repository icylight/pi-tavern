import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import type { CharacterCard } from "../../../src/config/character-card.js";
import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";
import { decodeServerMessage, encodeMessage } from "../../../src/protocol/codec.js";

/**
 * tier-2 精简下沉（User 拍板 2026-08-02）：acceptance 的细粒度断言下沉 integration
 * 后，两项原属 acceptance 独有语义在此进程内覆盖（QA 属主补测）：
 * - ISSUE-008 join 快照分页契约（100 条窗口 + has_more/cursor/total）
 * - 并发 speaks 保持 creator 顺序（多接收者一致）+ round 配额拒绝
 *
 * Peer 帧语义 = BufferedWsClient 同款（acceptance/ws-helper）：frames 只增不消费、
 * waitFor/collect 从 fromIndex 扫描——绝不在谓词等待中丢弃帧（2026-08-02 QA 踩坑：
 * 消费式 next() + 谓词丢弃会把目标帧之前的广播提前吞掉，导致 collect 缺帧）。
 * #119 M1/M2：信封迁移（请求 {jsonrpc,id,method,params}、通知 method+params、响应 result）。
 */
const temporaryDirectories: string[] = [];
const runtimes: CreatorRuntime[] = [];
const sockets: WebSocket[] = [];

const characters: [CharacterCard, CharacterCard] = [
	{
		characterId: "characters/architect.md",
		name: "Architect",
		description: "Architecture",
		path: "/characters/architect.md",
		prompt: "Architect prompt",
	},
	{
		characterId: "characters/reviewer.md",
		name: "Reviewer",
		description: "Reviews designs",
		path: "/characters/reviewer.md",
		prompt: "Reviewer prompt",
	},
];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-paging-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const socket of sockets.splice(0)) {
		socket.terminate();
	}
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function startRuntime(): Promise<CreatorRuntime> {
	const root = await createTemporaryDirectory();
	const runtime = await CreatorRuntime.startNew(
		{
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters,
		},
		{ readyTimeoutMs: 5_000 },
	);
	runtimes.push(runtime);
	return runtime;
}

/** 帧缓冲客户端（只增不消费；waitFor/collect 从 fromIndex 扫描）。 */
class Peer {
	private readonly frames: Record<string, unknown>[] = [];
	private readonly frameWaiters: Array<() => void> = [];

	constructor(
		readonly socket: WebSocket,
		readonly sendMessage: (message: unknown) => void,
	) {
		socket.on("message", (data) => {
			this.frames.push(decodeServerMessage(data) as Record<string, unknown>);
			for (const waiter of [...this.frameWaiters]) waiter();
		});
	}

	allFrames(): Record<string, unknown>[] {
		return [...this.frames];
	}

	send(message: unknown): void {
		this.sendMessage(message);
	}

	async waitFor(
		predicate: (message: Record<string, unknown>) => boolean,
		timeoutMs = 10_000,
		fromIndex = 0,
	): Promise<Record<string, unknown>> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const existing = this.frames.slice(fromIndex).find(predicate);
			if (existing) {
				return existing;
			}
			if (Date.now() > deadline) {
				throw new Error("timeout waiting for frame");
			}
			// PM/Dev ①：等待期间必须真超时（deadline 检查在 await 后 = 假超时）——
			// Promise.race 兜底唤醒，帧到达与超时竞争。
			await Promise.race([
				new Promise<void>((resolveWait) => {
					const waiter = (): void => {
						const index = this.frameWaiters.indexOf(waiter);
						if (index !== -1) {
							this.frameWaiters.splice(index, 1);
						}
						resolveWait();
					};
					this.frameWaiters.push(waiter);
				}),
				new Promise((resolveSleep) => setTimeout(resolveSleep, 250)),
			]);
		}
	}

	async collect(
		predicate: (message: Record<string, unknown>) => boolean,
		count: number,
		timeoutMs = 10_000,
		fromIndex = 0,
	): Promise<Record<string, unknown>[]> {
		const collected: Record<string, unknown>[] = [];
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const matched = this.frames.slice(fromIndex).filter((m) => !collected.includes(m) && predicate(m));
			collected.push(...matched);
			if (collected.length >= count) {
				return collected.slice(0, count);
			}
			if (Date.now() > deadline) {
				throw new Error("timeout collecting frames");
			}
			await Promise.race([
				new Promise<void>((resolveWait) => {
					const waiter = (): void => {
						const index = this.frameWaiters.indexOf(waiter);
						if (index !== -1) {
							this.frameWaiters.splice(index, 1);
						}
						resolveWait();
					};
					this.frameWaiters.push(waiter);
				}),
				new Promise((resolveSleep) => setTimeout(resolveSleep, 250)),
			]);
		}
	}
}

async function connectPeer(runtime: CreatorRuntime): Promise<Peer> {
	const descriptor = runtime.activeDescriptor;
	const socket = new WebSocket(
		`ws://${descriptor.host}:${descriptor.port}/${descriptor.groupChatId}/${descriptor.instanceId}`,
	);
	sockets.push(socket);
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	return new Peer(socket, (message) => socket.send(encodeMessage(message)));
}

async function joinAndReady(runtime: CreatorRuntime, sessionId: string, characterId: string): Promise<Peer> {
	const peer = await connectPeer(runtime);
	peer.send({
		jsonrpc: "2.0",
		id: `join-${sessionId}`,
		method: "join_group_chat",
		params: { session_id: sessionId },
	});
	await peer.waitFor((m) => m.id === `join-${sessionId}` && ("result" in m || "error" in m));
	peer.send({
		jsonrpc: "2.0",
		id: `claim-${sessionId}`,
		method: "claim_character",
		params: { character_id: characterId },
	});
	await peer.waitFor((m) => m.id === `claim-${sessionId}` && ("result" in m || "error" in m));
	peer.send({ jsonrpc: "2.0", id: `ready-${sessionId}`, method: "character_ready" });
	await peer.waitFor((m) => m.id === `ready-${sessionId}` && ("result" in m || "error" in m));
	return peer;
}

describe("ISSUE-008 join snapshot paging contract (integration)", () => {
	it("join message_history beyond the 100-message window advertises has_more + cursor", async () => {
		const runtime = await startRuntime();
		for (let i = 1; i <= 102; i++) {
			await runtime.submitUserPersonaMessage(`message ${i}`);
		}

		const peer = await joinAndReady(runtime, "session-paging", characters[0].characterId);
		const history = await peer.waitFor((m) => m.method === "message_history");
		const historyParams = history.params as Record<string, unknown>;

		const messages = historyParams.messages as Record<string, unknown>[];
		expect(messages).toHaveLength(100);
		expect(historyParams.has_more).toBe(true);
		expect(historyParams.cursor).toBeTruthy();
		expect(historyParams.total_messages).toBe(102);
		// 窗口覆盖 seq 3..102（最早 2 条超出窗口），oldest-first（条目 = 信封化 public_message）。
		expect((messages[0]?.params as Record<string, unknown>)?.sequence).toBe(3);
		expect((messages[99]?.params as Record<string, unknown>)?.sequence).toBe(102);
	});

	it("under-100 history advertises no paging (has_more false, cursor null)", async () => {
		const runtime = await startRuntime();
		await runtime.submitUserPersonaMessage("hello 1");
		await runtime.submitUserPersonaMessage("hello 2");

		const peer = await joinAndReady(runtime, "session-paging2", characters[0].characterId);
		const history = await peer.waitFor((m) => m.method === "message_history");
		const historyParams = history.params as Record<string, unknown>;

		const messages = historyParams.messages as Record<string, unknown>[];
		expect(messages).toHaveLength(2);
		expect(historyParams.has_more).toBe(false);
		expect(historyParams.cursor).toBeNull();
		expect(historyParams.total_messages).toBe(2);
	});
});

describe("concurrent speaks keep creator order + round quota (integration)", () => {
	it("interleaved speaks broadcast the same strictly-increasing sequence set to all receivers", async () => {
		const runtime = await startRuntime();
		await runtime.setMaxMessages(3); // 首个 round 前设置（setMaxMessages 作用于 next round）
		await runtime.submitUserPersonaMessage("Hello from the creator");

		const memberA = await joinAndReady(runtime, "session-spk-a", characters[0].characterId);
		const memberB = await joinAndReady(runtime, "session-spk-b", characters[1].characterId);
		// 跳过 join 期帧（message_history/character_joined/seq1 广播）。
		const baselineA = memberA.allFrames().length;
		const baselineB = memberB.allFrames().length;

		// 并发 burst（对齐 acceptance speak-order 原版语义）：不带 based_on_sequence
		// （undefined → stale 检查跳过）→ 三连并发确定性全发布 [2,3,4]；交错发送
		// 保留「creator 顺序权威 + 双接收者一致」的并发语义（stale 拒绝语义由
		// family-messages B2/B4/B6 专测，不在本用例混测——Arch 2026-08-02 定夺）。
		memberA.send({ jsonrpc: "2.0", id: "s1", method: "speak", params: { content: "one" } });
		memberB.send({ jsonrpc: "2.0", id: "s2", method: "speak", params: { content: "two" } });
		memberA.send({ jsonrpc: "2.0", id: "s3", method: "speak", params: { content: "three" } });

		const speakUpdate = (m: Record<string, unknown>): boolean =>
			m.method === "group_chat_update" && ((m.params as Record<string, unknown>).latest_sequence as number) >= 2;
		const [seenByA, seenByB] = await Promise.all([
			memberA.collect(speakUpdate, 3, 10_000, baselineA),
			memberB.collect(speakUpdate, 3, 10_000, baselineB),
		]);
		// 双方观察到的通知序列严格递增且一致（creator 顺序权威）。
		const sequencesA = seenByA.map((m) => (m.params as Record<string, unknown>).latest_sequence as number);
		const sequencesB = seenByB.map((m) => (m.params as Record<string, unknown>).latest_sequence as number);
		expect(sequencesA).toEqual([2, 3, 4]);
		expect(sequencesB).toEqual([2, 3, 4]);
		// 最后一条通知的 preview 携带 3 条已发布消息（seq 2..4，oldest-first）。
		const last = seenByA[2];
		expect(last).toBeDefined();
		if (!last) {
			throw new Error("expected 3 notifications");
		}
		const lastParams = last.params as Record<string, unknown>;
		const preview = (lastParams.preview_messages as Record<string, unknown>[]).map(
			(m) => (m.params as Record<string, unknown>).sequence,
		);
		expect(preview).toEqual([2, 3, 4]);
		// sender 归属 multiset（交错发送顺序不定）：2 个 Architect + 1 个 Reviewer。
		const senderNames = (lastParams.preview_messages as Record<string, unknown>[])
			.map((m) => ((m.params as Record<string, unknown>).sender as Record<string, unknown>).name)
			.sort();
		expect(senderNames).toEqual(["Architect", "Architect", "Reviewer"]);

		// 配额：round 上限 3，第 4 条拒绝且举手（published false + hand_raised）。
		memberA.send({
			jsonrpc: "2.0",
			id: "s4",
			method: "speak",
			params: { content: "four", based_on_sequence: 4 },
		});
		const fourth = await memberA.waitFor((m) => ("result" in m || "error" in m) && m.id === "s4", 10_000, baselineA);
		expect(fourth.error).toBeUndefined();
		const fourthResult = fourth.result as Record<string, unknown>;
		expect(fourthResult.published).toBe(false);
		expect(fourthResult.hand_raised).toBe(true);
	});
});
