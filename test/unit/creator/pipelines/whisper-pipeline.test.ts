import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { WhisperPipeline } from "../../../../src/creator/creator-pipelines/whisper-message-pipeline.js";
import { createGroupChatState } from "../../../../src/data/group-chat-state.js";
import type { SessionStore } from "../../../../src/data/session-store.js";
import type { PublicMessageState } from "../../../../src/protocol/public-message-state.js";
import type { WhisperMessageState } from "../../../../src/protocol/whisper-message-state.js";

/**
 * WH7（#152，QA 分层报告评审补测——后端发现降层断言缺失，Arch 认领）：
 * 「校验后掉线不回滚」窄窗口——integration 无法确定性复现（校验与投递同
 * await 链），unit 级注入 deps.send 抛错模拟投递瞬间失败，断言已提交状态
 * 不回滚 + 不占二次额度。真实环境 send 由 BroadcastHub 容错（失败静默），
 * 本用例注入抛错模拟注入方不兜底的极端投递失败。
 */
describe("WH7: whisper 校验后投递失败不回滚（窄窗口竞态）", () => {
	const fakeSocket = {} as WebSocket;

	function setupPipeline(send: (socket: WebSocket, message: unknown) => void) {
		const state = createGroupChatState({
			groupChatId: "group-1",
			createdAt: "2026-08-09T00:00:00.000Z",
			groupMaxMessages: 10,
		});
		state.nextSequence = 4;
		state.round = { roundMaxMessages: 10, usedMessages: 0 };
		state.onlineCharacters.set("sender-session", {
			sessionId: "sender-session",
			character: { characterId: "alice", name: "Alice", description: "Alice" },
			isStreaming: false,
			handRaised: false,
		});
		state.onlineCharacters.set("target-session", {
			sessionId: "target-session",
			character: { characterId: "carol", name: "Carol", description: "Carol" },
			isStreaming: false,
			handRaised: false,
		});

		const whisperMessages: WhisperMessageState[] = [];
		const publicMessages: PublicMessageState[] = [
			{
				sender: { type: "user_persona" },
				content: "R4",
				event_id: "evt-4",
				sequence: 4,
				timestamp: "2026-08-09T00:00:04.000Z",
				round: { round_max_messages: 10, used_messages: 0, remaining_messages: 10 },
			},
		];

		const appendCustomMessageEntry = vi.fn(() => "entry-5");
		const getEntry = vi.fn(() => ({ timestamp: "2026-08-09T00:00:05.000Z" }));
		const sessionStore = {
			assertWritable: vi.fn(() => undefined),
			appendCustomMessageEntry,
			getEntry,
			recoverFromFailedAppendAndCatch: vi.fn((error: unknown) => error as Error),
		} as unknown as SessionStore;

		const connections = new Map<string, WebSocket>([
			["sender-session", fakeSocket],
			["target-session", fakeSocket],
		]);

		const pipeline = new WhisperPipeline({
			state,
			publicMessages,
			whisperMessages,
			persistedCount: { get: () => 0, add: vi.fn() },
			sessionStore,
			readMergedMessages: () => [...publicMessages, ...whisperMessages],
			connections,
			send,
		});

		return { pipeline, state, whisperMessages, appendCustomMessageEntry };
	}

	it("chain: whisper delivery-failure no-rollback——投递静默失败后调用仍成功 + 已提交不回滚 + 不占二次额度（WH7 主锚）", async () => {
		// 与生产语义一致（BroadcastHub.send 容错：非 OPEN/抛错均静默吞掉，不传播）：
		// 注入记录式 stub（掉线不抛）→ 调用仍 resolve published:true（WH7 主语义）。
		const deliveryFailures: Array<{ method: string; target: string }> = [];
		const { pipeline, state, whisperMessages, appendCustomMessageEntry } = setupPipeline((socket, frame) => {
			void socket;
			const f = frame as { method: string; params: { recipient: { character_id: string } } };
			deliveryFailures.push({ method: f.method, target: f.params.recipient.character_id });
			// 静默丢弃（不抛错）——模拟接收者连接已断、广播中枢容错路径。
		});

		const message = {
			jsonrpc: "2.0" as const,
			id: "req-1",
			method: "whisper" as const,
			params: { character_id: "carol", content: "悄悄话R1" },
		};

		// 投递失败被静默吞掉 → 调用仍成功返回（WH7：不回滚、不重试、不占二次额度）。
		const result = await pipeline.runWhisper(fakeSocket, { sessionId: "sender-session", online: true }, message);
		expect(result.published).toBe(true);
		if (result.published) {
			expect(result.sequence).toBe(5);
		}

		// 投递确实发生过（尝试单播接收者）——仅一次，无重试。
		expect(deliveryFailures).toEqual([{ method: "whisper_message", target: "carol" }]);

		// 持久化已发生（提交先于投递）。
		expect(appendCustomMessageEntry).toHaveBeenCalledTimes(1);
		expect(appendCustomMessageEntry).toHaveBeenCalledWith(
			"pi-tavern.whisper-message",
			expect.stringContaining("悄悄话R1"),
			true,
			expect.objectContaining({ sequence: 5, recipient: expect.objectContaining({ character_id: "carol" }) }),
		);

		// 状态不回滚：sequence 已推进、额度已占（仅 1 次，不占二次）、私信流已提交。
		expect(state.nextSequence).toBe(5);
		expect(state.round?.usedMessages).toBe(1);
		expect(whisperMessages).toHaveLength(1);
		expect(whisperMessages[0]?.sequence).toBe(5);
		expect(whisperMessages[0]?.content).toBe("悄悄话R1");
	});

	it("chain: whisper delivery-contract-violation（依赖违约防御）——注入方违反 send 契约抛错时错误传播且不回滚", async () => {
		// 对抗测试：生产 BroadcastHub 承诺 send 不抛错；若注入方违约抛错，错误传播
		// （reject），但已提交状态同样不回滚（防御语义）。不冒充 WH7 主锚。
		const { pipeline, state, whisperMessages } = setupPipeline(() => {
			throw new Error("socket closed (simulated delivery failure)");
		});

		const message = {
			jsonrpc: "2.0" as const,
			id: "req-1",
			method: "whisper" as const,
			params: { character_id: "carol", content: "悄悄话R1" },
		};

		await expect(
			pipeline.runWhisper(fakeSocket, { sessionId: "sender-session", online: true }, message),
		).rejects.toThrow("socket closed");

		// 状态仍不回滚（已提交私信不因投递失败回滚）。
		expect(state.nextSequence).toBe(5);
		expect(state.round?.usedMessages).toBe(1);
		expect(whisperMessages).toHaveLength(1);
	});

	it("chain: whisper delivery-success——正常投递 resolve published:true（对照锚）", async () => {
		const sent: unknown[] = [];
		const { pipeline, state } = setupPipeline((socket, frame) => {
			void socket;
			sent.push(frame);
		});

		const message = {
			jsonrpc: "2.0" as const,
			id: "req-1",
			method: "whisper" as const,
			params: { character_id: "carol", content: "悄悄话R1" },
		};

		const result = await pipeline.runWhisper(fakeSocket, { sessionId: "sender-session", online: true }, message);

		// 成功路径：published + sequence + 单播接收者完整帧（发送者零事件）。
		expect(result.published).toBe(true);
		if (result.published) {
			expect(result.sequence).toBe(5);
		}
		expect(sent).toHaveLength(1);
		const fullFrame = sent[0] as { method: string; params: { recipient: { character_id: string } } };
		expect(fullFrame.method).toBe("whisper_message");
		expect(fullFrame.params.recipient.character_id).toBe("carol");
		expect(state.nextSequence).toBe(5);
	});
});
