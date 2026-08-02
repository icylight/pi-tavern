import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { GroupChatInput } from "../../../src/character/group-chat-input.js";
import type { PublicMessage, ServerMessage } from "../../../src/protocol/messages.js";

function createMockRuntime(
	overrides: {
		characterId?: string;
		groupChatId?: string;
		hasPublicMessages?: boolean;
		getGroupChatState?: () => Promise<unknown>;
	} = {},
): CharacterRuntime {
	return {
		groupChatId: overrides.groupChatId ?? "group-1",
		character: {
			characterId: overrides.characterId ?? "dev",
			name: "Developer",
			description: "Writes code",
			path: "/chars/dev.md",
			prompt: "You are a developer.",
		},
		getGroupChatState: overrides.getGroupChatState ?? (async () => ({})),
		hasPublicMessages: overrides.hasPublicMessages ?? false,
		onEnvironmentMessage: undefined,
		onAgentSettled: undefined,
		isAgentActive: false,
		loadCursor: () => null,
		saveCursor: () => undefined,
		fetchMessagesSince: async () => ({ messages: [], latestSequence: 0, totalMessages: 0 }),
		// ISSUE-014/#14：投递将下一个 turn 标记为群聊触发。
		markGroupChatTurnTriggered: () => undefined,
		refreshGroupChatState: async () => undefined,
	} as unknown as CharacterRuntime;
}

function createMockPi(): ExtensionAPI {
	return {
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI;
}

function aPublicMessage(senderType: "user_persona", overrides?: Partial<PublicMessage>): PublicMessage {
	return {
		type: "public_message",
		event_id: "evt-1",
		sequence: 1,
		timestamp: "2026-01-01T00:00:00.000Z",
		sender: { type: senderType },
		content: "Hello",
		round: { round_max_messages: 10, used_messages: 0, remaining_messages: 10 },
		...overrides,
	} as PublicMessage;
}

function aCharacterPublicMessage(characterId: string, overrides?: Partial<PublicMessage>): ServerMessage {
	return aPublicMessage("user_persona", {
		sender: { type: "character", character_id: characterId, name: "Dev" },
		...overrides,
	} as Partial<PublicMessage>) as ServerMessage;
}

function aCharacterJoined(): ServerMessage {
	return {
		type: "character_joined",
		character: { character_id: "tester", name: "Tester", description: "Tests" },
	} as ServerMessage;
}

function aCharacterLeft(): ServerMessage {
	return {
		type: "character_left",
		character: { character_id: "tester", name: "Tester", description: "Tests" },
		reason: "left",
	} as ServerMessage;
}

describe("GroupChatInput", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not queue own character's public message echo", () => {
		const runtime = createMockRuntime({ characterId: "dev" });
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();

		// 自己的回声
		const handler = runtime.onEnvironmentMessage;
		expect(handler).toBeDefined();
		handler?.(aCharacterPublicMessage("dev"));

		// 不应设置 debounce 定时器
		expect(input.hasPendingBatch()).toBe(false);

		input.stop();
	});

	it("queues environment messages with 1-second trailing-edge debounce", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({ hasPublicMessages: true });
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		// 第一条消息启动定时器
		handler(aPublicMessage("user_persona"));
		expect(input.hasPendingBatch()).toBe(true);

		// 第二条消息重置定时器
		vi.advanceTimersByTime(500);
		handler(aCharacterJoined());
		expect(input.hasPendingBatch()).toBe(true);

		// 静默 1s 后定时器触发
		await vi.advanceTimersByTimeAsync(1000);
		expect(input.hasPendingBatch()).toBe(false);

		// pi.sendMessage 应已被调用
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		input.stop();
	});

	it("submits group-chat-input with events and state on flush", async () => {
		vi.useFakeTimers();
		const stateSnapshot = {
			group_chat: { group_chat_id: "group-1", name: "Test", created_at: "", group_max_messages: 10 },
			round: { round_max_messages: 10, used_messages: 2, remaining_messages: 8 },
			online_characters: [],
		};

		const runtime = createMockRuntime({
			characterId: "dev",
			groupChatId: "group-1",
			getGroupChatState: vi.fn(async () => stateSnapshot),
		});
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		handler(aPublicMessage("user_persona", { content: "First message" }));

		await vi.advanceTimersByTimeAsync(1000);

		expect(runtime.getGroupChatState).toHaveBeenCalled();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
		const message = call[0] as {
			customType: string;
			content: string;
			display: boolean;
			details: Record<string, unknown>;
		};
		const options = call[1] as { triggerTurn: boolean; deliverAs: string };

		expect(message.customType).toBe("pi-tavern.group-chat-input");
		expect(message.display).toBe(true);
		expect(message.details.group_chat_id).toBe("group-1");
		expect(message.details.character_id).toBe("dev");
		expect(message.details.events).toHaveLength(1);
		expect(message.details.group_chat_state).toEqual(stateSnapshot);
		expect(message.content).toContain("First message");
		// ISSUE-003 三字段身份契约（cab1fd7）
		expect(message.content).toContain("你的当前角色：Developer（character_id=dev，注册名=Developer）");

		expect(options.triggerTurn).toBe(true);
		expect(options.deliverAs).toBe("followUp");

		input.stop();
	});

	it("filters out own echo while keeping other messages in batch", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({ characterId: "dev" });
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		// 自己的回声
		handler(aCharacterPublicMessage("dev", { content: "My own" }));
		// 他人的消息
		handler(aCharacterPublicMessage("other", { content: "Other's message" }));
		// User persona
		handler(aPublicMessage("user_persona", { content: "User says" }));

		await vi.advanceTimersByTimeAsync(1000);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<{ content: string }> } };
		const events = message.details.events;

		// 仅 2 个事件：他人消息和 user persona（自己的回声已被过滤）
		expect(events).toHaveLength(2);
		expect(events[0]?.content).toBe("Other's message");
		expect(events[1]?.content).toBe("User says");

		input.stop();
	});

	it("skips character_joined and character_left when no public messages exist", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({ hasPublicMessages: false });
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		handler(aCharacterJoined());
		handler(aCharacterLeft());

		await vi.advanceTimersByTimeAsync(1000);

		// 不应提交：无公开消息时 join/left 事件被过滤
		// （且批次为空）
		expect(pi.sendMessage).not.toHaveBeenCalled();

		input.stop();
	});

	it("includes character_joined and character_left when public messages exist", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({ hasPublicMessages: true });
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		handler(aCharacterJoined());
		handler(aCharacterLeft());

		await vi.advanceTimersByTimeAsync(1000);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<{ type: string }> } };
		const types = message.details.events.map((e) => e.type);
		expect(types).toEqual(["character_joined", "character_left"]);

		input.stop();
	});

	it("orders message_history expansion before the member's own join event (BC-12)", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({ hasPublicMessages: true });
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		// creator 先发送 message_history，再广播
		// character_joined；两者必须与历史事件一起落在同一首批，
		// 且历史事件在 join 事件之前（websocket-protocol.md 顺序）。
		handler({
			type: "message_history",
			messages: [aPublicMessage("user_persona", { sequence: 1, content: "First" })],
			cursor: null,
			has_more: false,
			total_messages: 1,
		});
		handler(aCharacterJoined());

		await vi.advanceTimersByTimeAsync(1000);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<{ type: string; sequence?: number }> } };
		const events = message.details.events;
		expect(events.map((e) => e.type)).toEqual(["public_message", "character_joined"]);
		expect(events[0]?.sequence).toBe(1);

		input.stop();
	});

	it("stops the debounce timer and discards batch on stop", () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime();
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		handler(aPublicMessage("user_persona"));
		expect(input.hasPendingBatch()).toBe(true);

		input.stop();
		expect(input.hasPendingBatch()).toBe(false);

		// 定时器应被清除——推进时间不应触发发送
		vi.advanceTimersByTime(2000);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("pages older history when message_history has_more is set (ISSUE-008)", async () => {
		vi.useFakeTimers();

		// 第一页：最新 10 条（sequence 11-20），带 cursor 的 has_more。
		const firstPage = Array.from({ length: 10 }, (_, i) =>
			aPublicMessage("user_persona", { event_id: `evt-${20 - i}`, sequence: 20 - i, content: `msg ${20 - i}` }),
		);
		const olderPage = Array.from({ length: 10 }, (_, i) =>
			aPublicMessage("user_persona", { event_id: `evt-${10 - i}`, sequence: 10 - i, content: `msg ${10 - i}` }),
		);

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		runtime.fetchMessageHistoryPage = vi.fn(async (cursor: string | null) => {
			if (cursor === "cursor-20") {
				return { messages: olderPage, cursor: null, hasMore: false, totalMessages: 20 };
			}
			return { messages: [], cursor: null, hasMore: false, totalMessages: 20 };
		});

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		handler({
			type: "message_history",
			messages: firstPage,
			cursor: "cursor-20",
			has_more: true,
			total_messages: 20,
		} as unknown as ServerMessage);

		// 让 fire-and-forget 分页完成，然后 flush。
		await vi.advanceTimersByTimeAsync(0);
		expect(runtime.fetchMessageHistoryPage).toHaveBeenCalledWith("cursor-20");

		await vi.advanceTimersByTimeAsync(2000);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<{ type: string; sequence?: number }> } };
		const sequences = message.details.events.map((e) => e.sequence).sort((a, b) => (a ?? 0) - (b ?? 0));
		// 全部 20 条消息（两页）都在。
		expect(sequences).toHaveLength(20);
		expect(sequences[0]).toBe(1);
		expect(sequences[19]).toBe(20);

		input.stop();
	});

	it("does not page when has_more is false, and stops on a repeated cursor (ISSUE-008 A1/A5)", async () => {
		vi.useFakeTimers();

		const page = Array.from({ length: 3 }, (_, i) =>
			aPublicMessage("user_persona", { event_id: `evt-${3 - i}`, sequence: 3 - i, content: `msg ${3 - i}` }),
		);
		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		runtime.fetchMessageHistoryPage = vi.fn(async (_cursor: string | null) => {
			// 服务器从不推进 cursor：客户端不得无限循环。
			return { messages: page, cursor: "stuck-cursor", hasMore: true, totalMessages: 3 };
		});

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		handler({
			type: "message_history",
			messages: page,
			cursor: "stuck-cursor",
			has_more: true,
			total_messages: 3,
		} as unknown as ServerMessage);
		await vi.advanceTimersByTimeAsync(0);

		// 恰好一次分页请求：重复的 cursor 终止循环。
		expect(runtime.fetchMessageHistoryPage).toHaveBeenCalledTimes(1);

		input.stop();
	});

	it("ignores has_more=false history without paging (ISSUE-008 A5)", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		runtime.fetchMessageHistoryPage = vi.fn(async () => ({
			messages: [],
			cursor: null,
			hasMore: false,
			totalMessages: 2,
		}));

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		handler({
			type: "message_history",
			messages: [aPublicMessage("user_persona", { sequence: 1 }), aPublicMessage("user_persona", { sequence: 2 })],
			cursor: null,
			has_more: false,
			total_messages: 2,
		} as unknown as ServerMessage);
		await vi.advanceTimersByTimeAsync(2000);

		expect(runtime.fetchMessageHistoryPage).not.toHaveBeenCalled();

		input.stop();
	});

	it("M7 A1: group_chat_update pulls immediately without the 1s debounce", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		runtime.fetchMessagesSince = vi.fn(async (since: number) => ({
			messages: [aPublicMessage("user_persona", { sequence: since + 1 })],
			latestSequence: since + 1,
			totalMessages: since + 1,
		}));
		runtime.loadCursor = vi.fn(() => 4);
		runtime.saveCursor = vi.fn();
		runtime.isAgentActive = false;

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		handler({
			type: "group_chat_update",
			latest_sequence: 5,
			preview_messages: [aPublicMessage("user_persona", { sequence: 5 })],
			total_messages: 5,
		} as unknown as ServerMessage);

		// 完全不推进 fake time：拉取是即时的（A1）。
		await vi.advanceTimersByTimeAsync(0);
		expect(runtime.fetchMessagesSince).toHaveBeenCalledWith(4);
		expect(runtime.saveCursor).toHaveBeenCalledWith(5);

		// agent 空闲，立即投递（无 debounce 等待）。
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		input.stop();
	});

	it("M7 A3/A4: pull returns strictly increasing no-gap messages after cursor", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		runtime.fetchMessagesSince = vi.fn(async (since: number) => {
			// 模拟丢失的通知：cursor 为 1，服务器有 2..5。
			const messages = [2, 3, 4, 5]
				.filter((seq) => seq > since)
				.map((seq) => aPublicMessage("user_persona", { sequence: seq }));
			return { messages, latestSequence: 5, totalMessages: 5 };
		});
		runtime.loadCursor = vi.fn(() => 1);
		runtime.saveCursor = vi.fn();
		runtime.isAgentActive = false;

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		handler({
			type: "group_chat_update",
			latest_sequence: 5,
			preview_messages: [aPublicMessage("user_persona", { sequence: 5 })],
			total_messages: 5,
		} as unknown as ServerMessage);
		await vi.advanceTimersByTimeAsync(0);

		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<{ sequence?: number }> } };
		const sequences = message.details.events.map((e) => e.sequence).sort((a, b) => (a ?? 0) - (b ?? 0));
		expect(sequences).toEqual([2, 3, 4, 5]);
		expect(runtime.saveCursor).toHaveBeenCalledWith(5);

		input.stop();
	});

	it("#38: active run pulls and steer-delivers immediately; settle finds nothing new", async () => {
		// #38 口径 A：run 活跃窗口不再延迟——拉取立即执行，
		// 投递切换到 steer 通道（当前工具调用后、下一次 LLM 调用前投递）。
		// settle 钩子作为安全网：光标已被运行中投递推进，
		// 没有剩余内容可拉取或投递（无重复）。
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		const fetchMock = vi.fn(async (since: number) => ({
			messages: [7, 8, 9].filter((seq) => seq > since).map((seq) => aPublicMessage("user_persona", { sequence: seq })),
			latestSequence: 9,
			totalMessages: 9,
		}));
		runtime.fetchMessagesSince = fetchMock;
		let cursor = 6;
		runtime.loadCursor = vi.fn(() => cursor);
		runtime.saveCursor = vi.fn((value: number) => {
			cursor = value;
		});
		runtime.markGroupChatTurnTriggered = vi.fn();
		runtime.isAgentActive = true;

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		// 运行中到达两条通知（7，然后 9）。
		handler({
			type: "group_chat_update",
			latest_sequence: 7,
			preview_messages: [],
			total_messages: 7,
		} as unknown as ServerMessage);
		handler({
			type: "group_chat_update",
			latest_sequence: 9,
			preview_messages: [],
			total_messages: 9,
		} as unknown as ServerMessage);
		await vi.advanceTimersByTimeAsync(0);

		// #38：run 不再延迟——第一条 update 立即拉取，
		// 第二条合并进单飞行补拉（cursor 6 → 9）。
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(6);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(9);
		// 光标在运行中推进（单点推进，A5）。
		expect(runtime.saveCursor).toHaveBeenCalledWith(9);

		// run 活跃期间经 steer 通道投递——不触发新 turn
		// （#14 群聊触发标记保持原样）。
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
		const options = call[1] as { deliverAs: string };
		expect(options.deliverAs).toBe("steer");
		expect(runtime.markGroupChatTurnTriggered).not.toHaveBeenCalled();
		const message = call[0] as { details: { events: Array<{ sequence?: number }> } };
		const sequences = message.details.events.map((e) => e.sequence).sort((a, b) => (a ?? 0) - (b ?? 0));
		expect(sequences).toEqual([7, 8, 9]);

		// settle → 尾部窗口拉取从已投递光标（9）之后开始：
		// 无新内容，因此无额外投递。
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock.mock.calls[2]?.[0]).toBe(9);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		input.stop();
	});

	it("#38: member events during a run are steer-delivered, not merged at settle", async () => {
		// #38 口径 A：成员事件不再为 settle flush 排队——
		// run 活跃期间它们与拉取的增量一起走 steer 通道
		// （到达顺序保持），settle 钩子无剩余可投递。
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
			hasPublicMessages: true,
		});
		runtime.fetchMessagesSince = vi.fn(async (since: number) => ({
			messages: [7].filter((seq) => seq > since).map((seq) => aPublicMessage("user_persona", { sequence: seq })),
			latestSequence: 7,
			totalMessages: 7,
		}));
		let cursor = 6;
		runtime.loadCursor = vi.fn(() => cursor);
		runtime.saveCursor = vi.fn((value: number) => {
			cursor = value;
		});
		runtime.markGroupChatTurnTriggered = vi.fn();
		runtime.isAgentActive = true;

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		// 运行中成员加入，然后消息通知到达。
		handler(aCharacterJoined());
		handler({
			type: "group_chat_update",
			latest_sequence: 7,
			preview_messages: [],
			total_messages: 7,
		} as unknown as ServerMessage);
		await vi.advanceTimersByTimeAsync(0);

		// #38：update 立即拉取并与待处理 join 事件合并为
		// 一次 steer 投递（到达顺序保持）。
		expect(runtime.fetchMessagesSince).toHaveBeenCalledWith(6);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<{ type: string; sequence?: number }> } };
		expect(message.details.events.map((e) => e.type)).toEqual(["character_joined", "public_message"]);
		const options = call[1] as { deliverAs: string };
		expect(options.deliverAs).toBe("steer");
		expect(runtime.markGroupChatTurnTriggered).not.toHaveBeenCalled();

		// join debounce 稍后触发，无剩余可投递。
		await vi.advanceTimersByTimeAsync(1000);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		// settle → 无排队、无额外投递。
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		input.stop();
	});

	it("#38: run-time steer delivery advances the cursor; settle has nothing left (B6 invariant)", async () => {
		// B6 不变量保持：客户端在 speak 时仍不推进光标。
		// 区别是运行中拉取现在推进它（单点推进），因此 7..9 在 run 中
		// 经 steer 投递，settle 补拉无剩余——无跳过、无重复投递。
		vi.useFakeTimers();

		let cursor = 6;
		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		runtime.loadCursor = vi.fn(() => cursor);
		runtime.saveCursor = vi.fn((value: number) => {
			cursor = value;
		});
		runtime.fetchMessagesSince = vi.fn(async (since: number) => ({
			messages: [7, 8, 9].filter((seq) => seq > since).map((seq) => aPublicMessage("user_persona", { sequence: seq })),
			latestSequence: 9,
			totalMessages: 9,
		}));
		runtime.isAgentActive = true;

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		// 7..9 的通知在运行中到达。
		handler({
			type: "group_chat_update",
			latest_sequence: 9,
			preview_messages: [],
			total_messages: 9,
		} as unknown as ServerMessage);
		await vi.advanceTimersByTimeAsync(0);

		// #38：run 中经 steer 投递；光标在运行中推进到 9
		// （不再延迟到 settle）。
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<{ sequence?: number }> } };
		const sequences = message.details.events.map((e) => e.sequence).sort((a, b) => (a ?? 0) - (b ?? 0));
		expect(sequences).toEqual([7, 8, 9]);
		expect(cursor).toBe(9);

		// run 中途 character 发言并在 seq 10 发布；投递光标
		// 保持在 9（speak 时客户端零推进，B6——
		// speak 发布者从不触碰投递光标）。

		// settle → 尾部窗口拉取从 9 开始（已投递）：
		// mock 无新内容返回，因此无重复投递，光标保持。
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(runtime.fetchMessagesSince).toHaveBeenCalledTimes(2);
		expect(runtime.fetchMessagesSince).toHaveBeenLastCalledWith(9);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(cursor).toBe(9);

		input.stop();
	});

	it("#38 T2: cursor advances monotonically during a run; steer batches never overlap or duplicate", async () => {
		// 约定的单点推进：运行中拉取在每次成功投递时保存光标，
		// 因此 run 中两条通知（7，然后 9）产生两个严格递增、
		// 不重叠的 steer 批次，settle 钩子无剩余——无重复、
		// 无间隙、不重拉已投递窗口。
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		const fetchSinceCalls: number[] = [];
		runtime.fetchMessagesSince = vi.fn(async (since: number) => {
			fetchSinceCalls.push(since);
			if (since === 6) {
				// 第一条通知：此时只有 seq 7。
				return { messages: [aPublicMessage("user_persona", { sequence: 7 })], latestSequence: 7, totalMessages: 7 };
			}
			if (since === 7) {
				// 第二条通知：此后 8 和 9 已到达。
				return {
					messages: [8, 9].map((seq) => aPublicMessage("user_persona", { sequence: seq })),
					latestSequence: 9,
					totalMessages: 9,
				};
			}
			return { messages: [], latestSequence: since, totalMessages: since };
		});
		let cursor = 6;
		runtime.loadCursor = vi.fn(() => cursor);
		runtime.saveCursor = vi.fn((value: number) => {
			cursor = value;
		});
		runtime.isAgentActive = true;

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		// 运行中两条带间隔的通知（7，然后 9）。
		handler({
			type: "group_chat_update",
			latest_sequence: 7,
			preview_messages: [],
			total_messages: 7,
		} as unknown as ServerMessage);
		handler({
			type: "group_chat_update",
			latest_sequence: 9,
			preview_messages: [],
			total_messages: 9,
		} as unknown as ServerMessage);
		await vi.advanceTimersByTimeAsync(0);

		// 光标在运行中单调推进：6 → 7 → 9。第二条
		// update 合并进单飞行补拉循环，绝不重拉
		// 已投递窗口。
		expect(fetchSinceCalls).toEqual([6, 7]);
		expect(runtime.saveCursor).toHaveBeenCalledTimes(2);
		expect(runtime.saveCursor).toHaveBeenNthCalledWith(1, 7);
		expect(runtime.saveCursor).toHaveBeenNthCalledWith(2, 9);

		// 两次 steer 投递：[7] 然后 [8, 9]——严格递增、
		// 不重叠、无间隙、无重复。
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
		const calls = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls as [unknown, unknown][];
		const deliveries = calls.map(([payload, options]) => {
			const message = payload as { details: { events: Array<{ sequence?: number }> } };
			const sequences = message.details.events.map((e) => e.sequence).sort((a, b) => (a ?? 0) - (b ?? 0));
			return { sequences, deliverAs: (options as { deliverAs: string }).deliverAs };
		});
		expect(deliveries[0]?.sequences).toEqual([7]);
		expect(deliveries[1]?.sequences).toEqual([8, 9]);
		expect(deliveries[0]?.deliverAs).toBe("steer");
		expect(deliveries[1]?.deliverAs).toBe("steer");

		// settle → 尾部窗口拉取从 9 开始（已投递）：
		// mock 无新内容，因此无额外拉取目标、无投递。
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchSinceCalls).toEqual([6, 7, 9]);
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);

		input.stop();
	});

	it("#38 T3: steer delivery never marks a group-chat-triggered turn (#14 boundary)", async () => {
		// #14 边界：只有实际开启新 turn 的 idle flush 才能
		// 标记群聊触发（agent_start 消费它点亮 is_streaming）。
		// run 中的 steer 投递必须不触碰标记——
		// 运行中的 turn 仍是唯一的 streaming 源。
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		runtime.markGroupChatTurnTriggered = vi.fn();
		const pi = createMockPi();

		// idle 投递保持 #14 语义：flush 将下一个 turn 标记为
		// 群聊触发并使用 followUp 通道。
		const idleInput = new GroupChatInput(runtime, pi);
		idleInput.start();
		const idleHandler = runtime.onEnvironmentMessage ?? (() => {});
		idleHandler(aPublicMessage("user_persona"));
		await vi.advanceTimersByTimeAsync(1000);
		expect(runtime.markGroupChatTurnTriggered).toHaveBeenCalledTimes(1);
		const idleOptions = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
			deliverAs: string;
			triggerTurn: boolean;
		};
		expect(idleOptions.deliverAs).toBe("followUp");
		expect(idleOptions.triggerTurn).toBe(true);
		idleInput.stop();
		(pi.sendMessage as ReturnType<typeof vi.fn>).mockClear();
		(runtime.markGroupChatTurnTriggered as ReturnType<typeof vi.fn>).mockClear();

		// 活跃 run：steer 投递不得标记——不会消费 agent_start，
		// 因此 is_streaming 仅由运行中的 turn 点亮。
		runtime.fetchMessagesSince = vi.fn(async (since: number) => ({
			messages: [aPublicMessage("user_persona", { sequence: since + 1 })],
			latestSequence: since + 1,
			totalMessages: since + 1,
		}));
		runtime.isAgentActive = true;
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler({
			type: "group_chat_update",
			latest_sequence: 1,
			preview_messages: [],
			total_messages: 1,
		} as unknown as ServerMessage);
		await vi.advanceTimersByTimeAsync(0);
		expect(runtime.markGroupChatTurnTriggered).not.toHaveBeenCalled();
		// 滞留救援语义钉死：steer 分支 triggerTurn=true（streaming 时 pi 忽略照常
		// 入队；非 streaming 时触发唤醒，堵 agent_settled 缺失的 wedged 场景）。
		expect((pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
			deliverAs: "steer",
			triggerTurn: true,
		});
		input.stop();
	});

	it("M7 A7: single-flight lock coalesces concurrent updates into one refetch", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		let resolveFirst: (() => void) | undefined;
		let calls = 0;
		runtime.fetchMessagesSince = vi.fn(async () => {
			calls++;
			await new Promise<void>((resolveWait) => {
				resolveFirst = resolveWait;
			});
			return { messages: [], latestSequence: calls, totalMessages: calls };
		});
		runtime.loadCursor = vi.fn(() => 0);
		runtime.saveCursor = vi.fn();
		runtime.isAgentActive = false;

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		// 第一次拉取在途时有两条 update。
		handler({
			type: "group_chat_update",
			latest_sequence: 1,
			preview_messages: [],
			total_messages: 1,
		} as unknown as ServerMessage);
		handler({
			type: "group_chat_update",
			latest_sequence: 2,
			preview_messages: [],
			total_messages: 2,
		} as unknown as ServerMessage);
		handler({
			type: "group_chat_update",
			latest_sequence: 3,
			preview_messages: [],
			total_messages: 3,
		} as unknown as ServerMessage);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toBe(1); // single flight

		resolveFirst?.();
		await vi.advanceTimersByTimeAsync(0);
		// 第一次完成后一次合并补拉。
		expect(calls).toBe(2);

		input.stop();
	});
});
