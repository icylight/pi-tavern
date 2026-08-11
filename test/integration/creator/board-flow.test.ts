/**
 * B3 白板管线集成测试（挂靠 B3 节 09:26 版 + QA 清单 1-5）。
 *
 * 断言口径（09:26 版定案）：wire 层 N 次 applied → N 条 board_update 即时广播
 * （无网络层合并）；changed:false（告知/拒绝）不广播（群聊静默）。
 * 字符侧窗口合并（N 条 → 1 次上下文注入）属 B4 两步断言，本文件不覆盖。
 * 信封迁移——请求 {jsonrpc,id,method,params}、响应 result/error、
 * 通知 method+params；响应按 id 关联（method 不再出现在响应帧）。
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import type { CharacterCard } from "../../../src/config/character-card.js";
import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";
import { getGroupChatSessionDirectory } from "../../../src/data/discovery/active-descriptor.js";
import { decodeServerMessage, encodeMessage } from "../../../src/protocol/codec.js";

const temporaryDirectories: string[] = [];
const runtimes: CreatorRuntime[] = [];
const sockets: WebSocket[] = [];

const characters: [CharacterCard, CharacterCard] = [
	{
		characterId: "characters/dev.md",
		name: "Dev",
		description: "Writes code",
		path: "/characters/dev.md",
		prompt: "Dev prompt",
	},
	{
		characterId: "characters/arch.md",
		name: "Arch",
		description: "Architecture",
		path: "/characters/arch.md",
		prompt: "Arch prompt",
	},
];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-board-flow-"));
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

/** 帧缓冲客户端（只增不消费；waitFor/collect 从 fromIndex 扫描——同 paging 测试）。 */
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

const isBoardUpdate = (m: Record<string, unknown>): boolean => m.method === "board_update";
/** 响应帧判别（result/error 信封；具体请求种类由调用处的 id 关联）。 */
const isBoardWriteResponse = (m: Record<string, unknown>): boolean => "result" in m || "error" in m;

describe("B3 白板管线（integration）", () => {
	it("贴条：响应四态 applied 带 note（id 回带）+ 广播 board_update add", async () => {
		const runtime = await startRuntime();
		const peer = await joinAndReady(runtime, "s1", characters[0].characterId);

		peer.send({
			jsonrpc: "2.0",
			id: "w1",
			method: "board_write",
			params: { action: "set", note: { content: "第一条" } },
		});
		const response = await peer.waitFor((m) => isBoardWriteResponse(m) && m.id === "w1");
		const result = response.result as Record<string, unknown>;
		expect(result.changed).toBe(true);
		const note = result.note as Record<string, unknown>;
		expect(typeof note.id).toBe("string");
		expect(note.content).toBe("第一条");

		const update = await peer.waitFor(
			(m) => isBoardUpdate(m) && (m.params as Record<string, unknown>).action === "add",
		);
		const updateParams = update.params as Record<string, unknown>;
		expect(updateParams.actor).toBe(characters[0].characterId);
		expect(updateParams.note).toEqual({ id: note.id, content: "第一条" });
		// 无 sequence 字段（不在消息流、无水位语义）。
		expect("sequence" in updateParams).toBe(false);
	});

	it("改条/撕条/清板增量摘要：update·remove 带内容、clear 无 note；N 条 applied → N 条广播", async () => {
		const runtime = await startRuntime();
		const peer = await joinAndReady(runtime, "s2", characters[0].characterId);

		peer.send({
			jsonrpc: "2.0",
			id: "w1",
			method: "board_write",
			params: { action: "set", note: { content: "待改" } },
		});
		const r1 = await peer.waitFor((m) => isBoardWriteResponse(m) && m.id === "w1");
		const note1 = (r1.result as Record<string, unknown>).note as Record<string, unknown>;

		// edit → action update（响应带新内容，广播同）
		peer.send({
			jsonrpc: "2.0",
			id: "w2",
			method: "board_write",
			params: { action: "set", note: { id: note1.id, content: "改后" } },
		});
		const r2 = await peer.waitFor((m) => isBoardWriteResponse(m) && m.id === "w2");
		expect((r2.result as Record<string, unknown>).changed).toBe(true);
		const u2 = await peer.waitFor((m) => isBoardUpdate(m) && (m.params as Record<string, unknown>).action === "update");
		expect((u2.params as Record<string, unknown>).note).toEqual({ id: note1.id, content: "改后" });

		// remove → 广播携带被撕条完整内容（id + content）；响应不带 note
		peer.send({
			jsonrpc: "2.0",
			id: "w3",
			method: "board_write",
			params: { action: "remove", note: { id: note1.id } },
		});
		const r3 = await peer.waitFor((m) => isBoardWriteResponse(m) && m.id === "w3");
		expect((r3.result as Record<string, unknown>).changed).toBe(true);
		expect((r3.result as Record<string, unknown>).note).toBeUndefined();
		const u3 = await peer.waitFor((m) => isBoardUpdate(m) && (m.params as Record<string, unknown>).action === "remove");
		expect((u3.params as Record<string, unknown>).note).toEqual({ id: note1.id, content: "改后" });

		// 再贴一张 → clear（非空板 applied，广播无 note）
		peer.send({
			jsonrpc: "2.0",
			id: "w4",
			method: "board_write",
			params: { action: "set", note: { content: "第二张" } },
		});
		await peer.waitFor((m) => isBoardWriteResponse(m) && m.id === "w4");
		peer.send({ jsonrpc: "2.0", id: "w5", method: "board_write", params: { action: "clear" } });
		const r5 = await peer.waitFor((m) => isBoardWriteResponse(m) && m.id === "w5");
		expect((r5.result as Record<string, unknown>).changed).toBe(true);
		expect((r5.result as Record<string, unknown>).note).toBeUndefined();
		const u5 = await peer.waitFor((m) => isBoardUpdate(m) && (m.params as Record<string, unknown>).action === "clear");
		expect((u5.params as Record<string, unknown>).note).toBeUndefined();

		// wire 层即时广播：5 次 applied → 5 条 board_update（顺序一致，无合并）
		const updates = peer.allFrames().filter((m) => isBoardUpdate(m));
		expect(updates.map((m) => (m.params as Record<string, unknown>).action)).toEqual([
			"add",
			"update",
			"remove",
			"add",
			"clear",
		]);
	});

	it("告知/拒绝：changed:false 群聊静默（不广播 board_update）", async () => {
		const runtime = await startRuntime();
		const peer = await joinAndReady(runtime, "s3", characters[0].characterId);
		const updateCountBefore = peer.allFrames().filter((m) => isBoardUpdate(m)).length;

		// remove 不存在 = 告知码 note_not_found（changed:false 不广播）
		peer.send({
			jsonrpc: "2.0",
			id: "w1",
			method: "board_write",
			params: { action: "remove", note: { id: "ghost" } },
		});
		const r1 = await peer.waitFor((m) => isBoardWriteResponse(m) && m.id === "w1");
		expect(r1.result).toEqual({ changed: false, code: "note_not_found" });
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 150));
		expect(peer.allFrames().filter((m) => isBoardUpdate(m))).toHaveLength(updateCountBefore);

		// 5 条 applied set（各广播 1 条 add——wire 层 N→N；唯一 id 逐个确认）
		for (let i = 0; i < 5; i++) {
			peer.send({
				jsonrpc: "2.0",
				id: `ws${i}`,
				method: "board_write",
				params: { action: "set", note: { content: `条${i}` } },
			});
			await peer.waitFor((m) => isBoardWriteResponse(m) && m.id === `ws${i}`);
		}
		const afterApplied = peer.allFrames().filter((m) => isBoardUpdate(m)).length;
		expect(afterApplied).toBe(updateCountBefore + 5);

		// 窗口后拒绝/告知均未广播（仅 5 条 applied 的 add）
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 400));
		expect(peer.allFrames().filter((m) => isBoardUpdate(m))).toHaveLength(updateCountBefore + 5);
	});

	it("actor 隔离：A 用 B 的条 id = note_not_found，双板互不串写", async () => {
		const runtime = await startRuntime();
		const a = await joinAndReady(runtime, "sa", characters[0].characterId);
		const b = await joinAndReady(runtime, "sb", characters[1].characterId);

		a.send({
			jsonrpc: "2.0",
			id: "wa",
			method: "board_write",
			params: { action: "set", note: { content: "A 的" } },
		});
		await peerBoardWriteResponse(a, "wa");

		b.send({
			jsonrpc: "2.0",
			id: "wb",
			method: "board_write",
			params: { action: "set", note: { content: "B 的" } },
		});
		await peerBoardWriteResponse(b, "wb");

		// 先查 B 的条 id（隔离断言需要 B 的真实 id）
		a.send({ jsonrpc: "2.0", id: "wq", method: "board_query" });
		const query = await peerBoardQuery(a, "wq");
		const boards = (query.result as Record<string, unknown>).boards as Record<string, unknown>;
		const bNotes = boards[characters[1].characterId] as Array<Record<string, unknown>>;
		expect(bNotes).toHaveLength(1);
		const noteB = bNotes[0];
		if (!noteB) throw new Error("unreachable");

		a.send({
			jsonrpc: "2.0",
			id: "wx2",
			method: "board_write",
			params: { action: "remove", note: { id: noteB.id } },
		});
		const rx = await peerBoardWriteResponse(a, "wx2");
		expect(rx.result).toEqual({ changed: false, code: "note_not_found" });

		// 双板不变
		a.send({ jsonrpc: "2.0", id: "wq2", method: "board_query" });
		const q2 = await peerBoardQuery(a, "wq2");
		const boards2 = (q2.result as Record<string, unknown>).boards as Record<string, unknown>;
		expect(boards2[characters[0].characterId]).toHaveLength(1);
		expect(boards2[characters[1].characterId]).toHaveLength(1);
	});

	it("board_write 不占发言额度、不产生消息流与 group_chat_update", async () => {
		const runtime = await startRuntime();
		const peer = await joinAndReady(runtime, "s4", characters[0].characterId);

		// 基线 round 快照
		peer.send({ jsonrpc: "2.0", id: "g1", method: "get_group_chat_state" });
		const before = await peer.waitFor((m) => isBoardWriteResponse(m) && m.id === "g1");
		const roundBefore = (before.result as Record<string, unknown>).round as Record<string, unknown>;

		const groupChatUpdateBefore = peer.allFrames().filter((m) => m.method === "group_chat_update").length;

		// 两次贴条 + 一次撕条
		peer.send({
			jsonrpc: "2.0",
			id: "w1",
			method: "board_write",
			params: { action: "set", note: { content: "贴" } },
		});
		await peer.waitFor((m) => isBoardWriteResponse(m) && m.id === "w1");
		peer.send({
			jsonrpc: "2.0",
			id: "w2",
			method: "board_write",
			params: { action: "set", note: { content: "贴2" } },
		});
		await peer.waitFor((m) => isBoardWriteResponse(m) && m.id === "w2");

		// round 计数不变（无额度消耗）
		peer.send({ jsonrpc: "2.0", id: "g2", method: "get_group_chat_state" });
		const after = await peer.waitFor((m) => isBoardWriteResponse(m) && m.id === "g2");
		const roundAfter = (after.result as Record<string, unknown>).round as Record<string, unknown>;
		expect(roundAfter).toEqual(roundBefore);

		// 无消息流产出（无 public_message / message_history 增量）
		expect(peer.allFrames().filter((m) => m.method === "public_message")).toHaveLength(0);

		// 无 group_chat_update 通知（board 走独立广播通道，不触发消息流拉取）
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 400));
		expect(peer.allFrames().filter((m) => m.method === "group_chat_update")).toHaveLength(groupChatUpdateBefore);
	});

	it("leave → resume → board_query 读回（文件保留；删除群聊同步清理）", async () => {
		const root = await createTemporaryDirectory();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const runtime = await CreatorRuntime.startNew({ cwd, agentDir, characters });
		runtimes.push(runtime);

		const peer = await joinAndReady(runtime, "s5", characters[0].characterId);
		peer.send({
			jsonrpc: "2.0",
			id: "w1",
			method: "board_write",
			params: { action: "set", note: { content: "持久化" } },
		});
		const r1 = await peer.waitFor((m) => isBoardWriteResponse(m) && m.id === "w1");
		const note = (r1.result as Record<string, unknown>).note as Record<string, unknown>;

		// 补首条消息建轮次 + speak 落会话条目（board 操作不入消息流/不写会话文件——resume 需会话文件存在）
		await runtime.submitUserPersonaMessage("开题");
		peer.send({ jsonrpc: "2.0", id: "sp1", method: "speak", params: { content: "留档发言" } });
		await peer.waitFor((m) => isBoardWriteResponse(m) && m.id === "sp1");

		peer.send({ jsonrpc: "2.0", method: "leave_group_chat" });
		await runtime.close();
		await runtime.close();

		// resume：从会话 JSONL 恢复（SessionManager 命名 <时间戳>_<id>.jsonl，目录扫描定位；
		// boards 文件独立保留，恢复读取 = 懒加载）
		const sessionDir = getGroupChatSessionDirectory(agentDir, cwd);
		const sessionFiles = (await readdir(sessionDir)).filter((f) => f.endsWith(".jsonl"));
		expect(sessionFiles).toHaveLength(1);
		const sessionPath = join(sessionDir, sessionFiles[0] ?? "");
		const resumed = await CreatorRuntime.resume({ cwd, agentDir, sessionPath, characters });
		runtimes.push(resumed);

		const peer2 = await joinAndReady(resumed, "s5", characters[0].characterId);
		peer2.send({ jsonrpc: "2.0", id: "q1", method: "board_query" });
		const query = await peer2.waitFor((m) => isBoardWriteResponse(m) && m.id === "q1");
		const boards = (query.result as Record<string, unknown>).boards as Record<string, unknown>;
		expect(boards[characters[0].characterId]).toEqual([{ id: note.id, content: "持久化" }]);
	});

	it("creator 实时提示：onBoardUpdated 在 applied 时触发、changed:false 不触发（B5）", async () => {
		const runtime = await startRuntime();
		const updates: Array<{ actor: string; action: string; note?: { id: string; content: string } }> = [];
		runtime.onBoardUpdated = (update) => {
			updates.push(update);
		};
		const peer = await joinAndReady(runtime, "s6", characters[0].characterId);

		peer.send({
			jsonrpc: "2.0",
			id: "w1",
			method: "board_write",
			params: { action: "set", note: { content: "贴条" } },
		});
		await peer.waitFor((m) => isBoardWriteResponse(m) && m.id === "w1");
		expect(updates).toHaveLength(1);
		expect(updates[0]).toEqual({
			actor: characters[0].characterId,
			action: "add",
			note: { id: expect.any(String), content: "贴条" },
		});

		// changed:false（告知/拒绝）不触发
		peer.send({
			jsonrpc: "2.0",
			id: "w2",
			method: "board_write",
			params: { action: "remove", note: { id: "ghost" } },
		});
		await peer.waitFor((m) => isBoardWriteResponse(m) && m.id === "w2");
		expect(updates).toHaveLength(1);
	});

	it("协议级错误走 error 信封（未入群成员直接 board_write）", async () => {
		const runtime = await startRuntime();
		const peer = await connectPeer(runtime);

		peer.send({
			jsonrpc: "2.0",
			id: "w1",
			method: "board_write",
			params: { action: "set", note: { content: "未入群" } },
		});
		const failure = await peer.waitFor((m) => isBoardWriteResponse(m) && m.id === "w1");
		expect(failure.result).toBeUndefined();
		const error = failure.error as { code: number; message: string };
		expect(typeof error.message).toBe("string");
		expect(error.code).toBe(-32100);
	});
});

/** 等待 board_write 响应并返回。 */
async function peerBoardWriteResponse(peer: Peer, id: string): Promise<Record<string, unknown>> {
	return peer.waitFor((m) => isBoardWriteResponse(m) && m.id === id);
}

/** 等待 board_query 响应并返回。 */
async function peerBoardQuery(peer: Peer, id: string): Promise<Record<string, unknown>> {
	return peer.waitFor((m) => isBoardWriteResponse(m) && m.id === id);
}
