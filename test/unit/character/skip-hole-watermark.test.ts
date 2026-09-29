import { afterEach, describe, expect, it, vi } from "vitest";
import type { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { GroupChatInput } from "../../../src/character/group-chat-input.js";
import type { PublicMessage, ServerMessage } from "../../../src/protocol/messages.js";
import { createConsumableMockPi, emitBatchConsumption } from "../../helpers/consumable-pi.js";

/**
 * #201 消费水位单位钉（integration 红钉 `skip-hole.test.ts` 的下层判别器）：
 * 连续性游标只由「消费确认」推进，覆盖区间证明决定推进是否安全。
 * 行为锚（acceptance.md「消费水位推进（#201）」）：
 *  - 入队（sendMessage 返回）不推进；
 *  - 批覆盖下界 ≤ 游标 → 消费确认推进到批水位；
 *  - 覆盖下界 > 游标（缺口未补）/ 无覆盖元数据 → 不推进（区间保持未读，重拉）；
 *  - 自产 whisper 回帧不注入（发送者零事件），其水位靠覆盖证明消费。
 */

function createMockRuntime(options: {
	loadCursor: () => number;
	saveCursor: (sequence: number) => void;
	fetchMessagesSince: (
		since: number,
	) => Promise<{ messages: ServerMessage[]; latestSequence: number; totalMessages: number; contextCount: number }>;
}): CharacterRuntime {
	return {
		groupChatId: "group-1",
		character: {
			characterId: "dev",
			name: "Developer",
			description: "Writes code",
			path: "/chars/dev.md",
			prompt: "You are a developer.",
		},
		getGroupChatState: async () => ({}),
		hasPublicMessages: true,
		onEnvironmentMessage: undefined,
		onAgentSettled: undefined,
		isAgentActive: false,
		loadCursor: options.loadCursor,
		saveCursor: options.saveCursor,
		fetchMessagesSince: options.fetchMessagesSince,
		refreshGroupChatState: async () => undefined,
	} as unknown as CharacterRuntime;
}

function aPublicMessage(sequence: number): ServerMessage {
	return {
		jsonrpc: "2.0",
		method: "public_message",
		params: {
			event_id: `evt-${sequence}`,
			sequence,
			timestamp: "2026-09-29T00:00:00.000Z",
			sender: { type: "user_persona" },
			content: `message-${sequence}`,
			round: { round_max_messages: 200, used_messages: sequence, remaining_messages: 200 - sequence },
		},
	} as PublicMessage;
}

function aWhisperMessage(sequence: number, senderId: string): ServerMessage {
	return {
		jsonrpc: "2.0",
		method: "whisper_message",
		params: {
			event_id: `whisper-${sequence}`,
			sequence,
			timestamp: "2026-09-29T00:00:00.000Z",
			sender: { type: "character", character_id: senderId, name: senderId },
			recipient: { type: "character", character_id: "dev", name: "Dev" },
			content: `secret-${sequence}`,
			round: { round_max_messages: 200, used_messages: sequence, remaining_messages: 200 - sequence },
		},
	} as unknown as ServerMessage;
}

function aGroupChatUpdate(latestSequence: number): ServerMessage {
	return {
		jsonrpc: "2.0",
		method: "group_chat_update",
		params: {
			latest_sequence: latestSequence,
			preview_messages: [aPublicMessage(latestSequence)],
			total_messages: latestSequence,
		},
	} as unknown as ServerMessage;
}

afterEach(() => vi.useRealTimers());

describe("#201 消费水位（单位钉）", () => {
	it("入队不推进；消费确认推进到批水位（pull 批覆盖证明）", async () => {
		vi.useFakeTimers();
		let cursor = 1;
		const saveCursor = vi.fn((sequence: number) => {
			cursor = sequence;
		});
		const runtime = createMockRuntime({
			loadCursor: () => cursor,
			saveCursor,
			fetchMessagesSince: async () => ({
				messages: [aPublicMessage(2), aPublicMessage(3)],
				latestSequence: 3,
				totalMessages: 3,
				contextCount: 0,
			}),
		});
		const api = createConsumableMockPi();
		const input = new GroupChatInput(runtime, api.pi);
		input.start();

		runtime.onEnvironmentMessage?.(aGroupChatUpdate(3));
		await vi.advanceTimersByTimeAsync(1000);

		expect(api.pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(saveCursor).not.toHaveBeenCalled(); // 入队 ≠ 消费

		emitBatchConsumption(api.pi);
		expect(saveCursor).toHaveBeenCalledWith(3);
		expect(cursor).toBe(3);
		input.stop();
	});

	it("实时批覆盖下界 > 游标（缺口未补）→ 消费不推进；缺口由拉取路径补后推进", async () => {
		vi.useFakeTimers();
		let cursor = 1;
		const saveCursor = vi.fn((sequence: number) => {
			cursor = sequence;
		});
		const runtime = createMockRuntime({
			loadCursor: () => cursor,
			saveCursor,
			fetchMessagesSince: async () => ({
				messages: [aPublicMessage(2), aPublicMessage(3)],
				latestSequence: 3,
				totalMessages: 3,
				contextCount: 0,
			}),
		});
		const api = createConsumableMockPi();
		const input = new GroupChatInput(runtime, api.pi);
		input.start();

		// 实时帧 3 先到（2 未到）：注入但覆盖下界 = 2 > 游标 1 → 消费不推进。
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler(aPublicMessage(3));
		await vi.advanceTimersByTimeAsync(1000);
		emitBatchConsumption(api.pi);
		expect(saveCursor).not.toHaveBeenCalled();

		// 拉取路径补窗口 [2,3]（覆盖下界 = 游标 1）→ 消费推进到 3。
		handler(aGroupChatUpdate(3));
		await vi.advanceTimersByTimeAsync(1000);
		emitBatchConsumption(api.pi);
		expect(saveCursor).toHaveBeenCalledWith(3);
		expect(cursor).toBe(3);
		input.stop();
	});

	it("实时帧段不连续（2,4 缺 3）→ 无覆盖声明，消费不推进", async () => {
		vi.useFakeTimers();
		let cursor = 1;
		const saveCursor = vi.fn((sequence: number) => {
			cursor = sequence;
		});
		const runtime = createMockRuntime({
			loadCursor: () => cursor,
			saveCursor,
			fetchMessagesSince: async () => ({ messages: [], latestSequence: 0, totalMessages: 0, contextCount: 0 }),
		});
		const api = createConsumableMockPi();
		const input = new GroupChatInput(runtime, api.pi);
		input.start();

		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler(aPublicMessage(2));
		handler(aPublicMessage(4));
		await vi.advanceTimersByTimeAsync(1000);

		expect(api.pi.sendMessage).toHaveBeenCalledTimes(1);
		emitBatchConsumption(api.pi);
		expect(saveCursor).not.toHaveBeenCalled(); // 非连续帧段不声明覆盖
		input.stop();
	});

	it("无覆盖元数据的消费事件（旧格式 / 降级面）→ 不推进", async () => {
		vi.useFakeTimers();
		let cursor = 1;
		const saveCursor = vi.fn((sequence: number) => {
			cursor = sequence;
		});
		const runtime = createMockRuntime({
			loadCursor: () => cursor,
			saveCursor,
			fetchMessagesSince: async () => ({
				messages: [aPublicMessage(2)],
				latestSequence: 2,
				totalMessages: 2,
				contextCount: 0,
			}),
		});
		const api = createConsumableMockPi();
		const input = new GroupChatInput(runtime, api.pi);
		input.start();

		runtime.onEnvironmentMessage?.(aGroupChatUpdate(2));
		await vi.advanceTimersByTimeAsync(1000);

		expect(api.pi.sendMessage).toHaveBeenCalledTimes(1);
		// 手写消费事件：customType 匹配但无覆盖元数据（旧格式 / 降级面）→ no-op。
		api.emitMessageStart({
			message: { customType: "pi-tavern.group-chat-input", content: "x", display: true },
		});
		expect(saveCursor).not.toHaveBeenCalled();
		input.stop();
	});

	it("自产 whisper 回帧不注入（发送者零事件），覆盖证明由其水位承担", async () => {
		vi.useFakeTimers();
		let cursor = 1;
		const saveCursor = vi.fn((sequence: number) => {
			cursor = sequence;
		});
		const runtime = createMockRuntime({
			loadCursor: () => cursor,
			saveCursor,
			fetchMessagesSince: async () => ({
				// 自产 whisper（seq 2）+ 他人消息（seq 3）：只注入他人消息。
				messages: [aWhisperMessage(2, "dev"), aPublicMessage(3)],
				latestSequence: 3,
				totalMessages: 3,
				contextCount: 0,
			}),
		});
		const api = createConsumableMockPi();
		const input = new GroupChatInput(runtime, api.pi);
		input.start();

		// 实时自产 whisper 帧：静默不注入。
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler(aWhisperMessage(2, "dev"));
		await vi.advanceTimersByTimeAsync(1000);
		expect(api.pi.sendMessage).not.toHaveBeenCalled();

		// 拉取窗口含自产 whisper + 他人消息：只投他人消息，消费推进覆盖自产 seq。
		handler(aGroupChatUpdate(3));
		await vi.advanceTimersByTimeAsync(1000);
		const sent = (api.pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { content?: string };
		expect(sent.content ?? "").toContain("message-3");
		expect(sent.content ?? "").not.toContain("secret-2");
		emitBatchConsumption(api.pi);
		expect(saveCursor).toHaveBeenCalledWith(3);
		input.stop();
	});
});
