import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { GroupChatInput } from "../../../src/character/group-chat-input.js";
import { DEFAULT_TEMPLATES, type MessageTemplateKey } from "../../../src/config/message-templates.js";
import type { PublicMessage, ServerMessage } from "../../../src/protocol/messages.js";

function createMockRuntime(
	overrides: {
		characterId?: string;
		groupChatId?: string;
		hasPublicMessages?: boolean;
		getGroupChatState?: () => Promise<unknown>;
		messageTemplates?: Record<MessageTemplateKey, string>;
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
		messageTemplates: overrides.messageTemplates,
		onEnvironmentMessage: undefined,
		onAgentSettled: undefined,
		isAgentActive: false,
		loadCursor: () => null,
		saveCursor: () => undefined,
		markIncrementPending: () => undefined,
		// P1-4 方案 a：进入时刻水位（新帧数字 / 旧帧 null）。mock 默认 null = 旧帧回退路径。
		readyLatestSequence: null,
		fetchMessagesSince: async () => ({ messages: [], latestSequence: 0, totalMessages: 0, contextCount: 0 }),
		// 标记机制已删除（agent_start 无条件点亮）。
		refreshGroupChatState: async () => undefined,
	} as unknown as CharacterRuntime;
}

function createMockPi(): ExtensionAPI {
	return {
		// 与 pi SDK 真实 API 面一致（QA 实证）：sendMessage options 无 preflightResult，
		// resolve = 入队成功/run 正常结束（游标推进依据，A5 双通道判定）。
		sendMessage: vi.fn(async () => undefined),
	} as unknown as ExtensionAPI;
}

function aPublicMessage(senderType: "user_persona", overrides?: Partial<PublicMessage["params"]>): PublicMessage {
	return {
		jsonrpc: "2.0",
		method: "public_message",
		params: {
			event_id: "evt-1",
			sequence: 1,
			timestamp: "2026-01-01T00:00:00.000Z",
			sender: { type: senderType },
			content: "Hello",
			round: { round_max_messages: 10, used_messages: 0, remaining_messages: 10 },
			...overrides,
		},
	} as PublicMessage;
}

function aCharacterPublicMessage(characterId: string, overrides?: Partial<PublicMessage["params"]>): ServerMessage {
	return aPublicMessage("user_persona", {
		sender: { type: "character", character_id: characterId, name: "Dev" },
		...overrides,
	} as Partial<PublicMessage["params"]>) as ServerMessage;
}

function aCharacterJoined(): ServerMessage {
	return {
		jsonrpc: "2.0",
		method: "character_joined",
		params: { character: { character_id: "tester", name: "Tester", description: "Tests" } },
	} as ServerMessage;
}

function aCharacterLeft(): ServerMessage {
	return {
		jsonrpc: "2.0",
		method: "character_left",
		params: { character: { character_id: "tester", name: "Tester", description: "Tests" }, reason: "left" },
	} as ServerMessage;
}

function createWhisperMessage(params: {
	sender: { type: "character"; character_id: string; name?: string };
	recipient: { type: "character"; character_id: string; name?: string };
	content: string;
}): ServerMessage {
	return {
		jsonrpc: "2.0",
		method: "whisper_message",
		params: {
			event_id: "evt-w1",
			sequence: 21,
			timestamp: "2026-01-01T00:00:00.000Z",
			sender: params.sender,
			recipient: params.recipient,
			content: params.content,
			round: { round_max_messages: 10, used_messages: 1, remaining_messages: 9 },
		},
	} as ServerMessage;
}

/** ：私信占位广播帧（无正文）。 */
function createWhisperPlaceholder(params: {
	sender: { type: "character"; character_id: string; name?: string };
	recipient: { type: "character"; character_id: string; name?: string };
}): ServerMessage {
	return {
		jsonrpc: "2.0",
		method: "whisper_placeholder",
		params: {
			event_id: "evt-w2",
			sequence: 22,
			timestamp: "2026-01-01T00:00:00.000Z",
			sender: params.sender,
			recipient: params.recipient,
		},
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
		//  三字段身份契约（cab1fd7）
		expect(message.content).toContain("你的当前角色：Developer（character_id=dev，注册名=Developer）");
		// 环境文本带当前时间（头部）+ 消息发言时间/间隔（存在性断言防脆测）
		expect(message.content).toMatch(/当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
		expect(message.content).toMatch(/User Persona（\d{4}-\d{2}-\d{2} \d{2}:\d{2}（\d+ 秒前|\d+ 分钟前））:/);

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
		handler(aCharacterPublicMessage("dev", { event_id: "evt-own", sequence: 1, content: "My own" }));
		// 他人的消息
		handler(aCharacterPublicMessage("other", { event_id: "evt-other", sequence: 2, content: "Other's message" }));
		// User Persona 消息
		handler(aPublicMessage("user_persona", { event_id: "evt-user", sequence: 3, content: "User says" }));

		await vi.advanceTimersByTimeAsync(1000);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<{ params: { content: string } }> } };
		const events = message.details.events;

		// 仅 2 个事件：他人消息和 user persona（自己的回声已被过滤）
		expect(events).toHaveLength(2);
		expect((events[0]?.params as Record<string, unknown>)?.content).toBe("Other's message");
		expect((events[1]?.params as Record<string, unknown>)?.content).toBe("User says");

		input.stop();
	});

	it("filters out own board_update echo while keeping others. updates", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({ characterId: "dev" });
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		// 自己的 board_update 回显（actor = 本角色）——响应已含结果，过滤
		handler({
			jsonrpc: "2.0",
			method: "board_update",
			params: {
				actor: "dev",
				action: "add",
				note: { id: "n1", content: "我的条" },
			},
		} as ServerMessage);
		// 他人的 board_update——照常进批处理（门闸放行）
		handler({
			jsonrpc: "2.0",
			method: "board_update",
			params: {
				actor: "other",
				action: "remove",
				note: { id: "n2", content: "别人的条" },
			},
		} as ServerMessage);

		await vi.advanceTimersByTimeAsync(1000);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<Record<string, unknown>> } };
		const events = message.details.events;

		// 仅 1 个事件：他人的更新（自己的回显已被过滤）
		expect(events).toHaveLength(1);
		expect((events[0]?.params as Record<string, unknown>)?.actor).toBe("other");

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

	it("T3: 实时注入用自定义 public_message 模板渲染（三面同变）", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			hasPublicMessages: true,
			messageTemplates: { ...DEFAULT_TEMPLATES, public_message: "[{sender}]→{content}" },
		});
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler(aPublicMessage("user_persona"));
		await vi.advanceTimersByTimeAsync(1000);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const message = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { content?: string };
		// 消息带 timestamp → when 并入 vars.sender（契约方案 a），模板格式可辨。
		expect(message.content ?? "").toContain("[User Persona");
		expect(message.content ?? "").toContain("]→Hello");

		input.stop();
	});

	it("T3: 实时注入相对时间用自定义模板渲染（minutes_ago 接入 formatMessageTime）", async () => {
		vi.useFakeTimers();

		// 消息 timestamp = 2026-01-01，fake timers 基准 = 真实当前时间 → 间隔巨大 → 分钟分支。
		const runtime = createMockRuntime({
			hasPublicMessages: true,
			messageTemplates: { ...DEFAULT_TEMPLATES, minutes_ago: "{count} min ago" },
		});
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler(aPublicMessage("user_persona"));
		await vi.advanceTimersByTimeAsync(1000);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const message = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { content?: string };
		// 自定义相对时间模板生效（此前硬编码「x 分钟前」中文）。
		expect(message.content ?? "").toContain("min ago");
		expect(message.content ?? "").not.toContain("分钟前");

		input.stop();
	});

	it("skips character_joined and character_left even when public messages exist", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({ hasPublicMessages: true });
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		handler(aCharacterJoined());
		handler(aCharacterLeft());

		await vi.advanceTimersByTimeAsync(1000);

		expect(pi.sendMessage).not.toHaveBeenCalled();

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
			jsonrpc: "2.0",
			method: "message_history",
			params: {
				messages: [aPublicMessage("user_persona", { sequence: 1, content: "First" })],
				cursor: null,
				has_more: false,
				total_messages: 1,
			},
		});
		handler(aCharacterJoined());

		await vi.advanceTimersByTimeAsync(1000);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<{ params?: { sequence?: number } }> } };
		const events = message.details.events;
		expect(events.map((e) => (e as Record<string, unknown>).method)).toEqual(["public_message"]);
		expect((events[0]?.params as Record<string, unknown>)?.sequence).toBe(1);

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

	it("pages older history when message_history has_more is set ", async () => {
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
			jsonrpc: "2.0",
			method: "message_history",
			params: {
				messages: firstPage,
				cursor: "cursor-20",
				has_more: true,
				total_messages: 20,
			},
		} as unknown as ServerMessage);

		// 让 fire-and-forget 分页完成，然后 flush。
		await vi.advanceTimersByTimeAsync(0);
		expect(runtime.fetchMessageHistoryPage).toHaveBeenCalledWith("cursor-20");

		await vi.advanceTimersByTimeAsync(2000);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<{ params?: { sequence?: number } }> } };
		const sequences = message.details.events
			.map((e) => (e as { params?: { sequence?: number } }).params?.sequence)
			.sort((a, b) => (a ?? 0) - (b ?? 0));
		// 全部 20 条消息（两页）都在。
		expect(sequences).toHaveLength(20);
		expect(sequences[0]).toBe(1);
		expect(sequences[19]).toBe(20);

		input.stop();
	});

	it("does not page when has_more is false, and stops on a repeated cursor (A1/A5)", async () => {
		vi.useFakeTimers();

		const page = Array.from({ length: 3 }, (_, i) =>
			aPublicMessage("user_persona", { event_id: `evt-${3 - i}`, sequence: 3 - i, content: `msg ${3 - i}` }),
		);
		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		// P1-4：模拟已有游标的会话——预置查询（primeJoinCursor）跳过，专注 message_history 兼容路径语义。
		runtime.loadCursor = vi.fn(() => 20);
		runtime.fetchMessageHistoryPage = vi.fn(async (_cursor: string | null) => {
			// 服务器从不推进 cursor：客户端不得无限循环。
			return { messages: page, cursor: "stuck-cursor", hasMore: true, totalMessages: 3 };
		});

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		handler({
			jsonrpc: "2.0",
			method: "message_history",
			params: {
				messages: page,
				cursor: "stuck-cursor",
				has_more: true,
				total_messages: 3,
			},
		} as unknown as ServerMessage);
		await vi.advanceTimersByTimeAsync(0);

		// 恰好一次分页请求：重复的 cursor 终止循环。
		expect(runtime.fetchMessageHistoryPage).toHaveBeenCalledTimes(1);

		input.stop();
	});

	it("ignores has_more=false history without paging (A5)", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		// P1-4：模拟已有游标的会话——预置查询（primeJoinCursor）跳过，专注 message_history 兼容路径语义。
		runtime.loadCursor = vi.fn(() => 2);
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
			jsonrpc: "2.0",
			method: "message_history",
			params: {
				messages: [aPublicMessage("user_persona", { sequence: 1 }), aPublicMessage("user_persona", { sequence: 2 })],
				cursor: null,
				has_more: false,
				total_messages: 2,
			},
		} as unknown as ServerMessage);
		await vi.advanceTimersByTimeAsync(2000);

		expect(runtime.fetchMessageHistoryPage).not.toHaveBeenCalled();

		input.stop();
	});

	it("P1-4 游标预置：无游标（首次 join）→ start 后一次水位查询 + saveCursor(totalMessages)", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		runtime.loadCursor = vi.fn(() => null);
		const saveCursor = vi.fn();
		runtime.saveCursor = saveCursor;
		runtime.fetchMessageHistoryPage = vi.fn(async () => ({
			messages: [],
			cursor: null,
			hasMore: false,
			totalMessages: 12,
		}));

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		await vi.advanceTimersByTimeAsync(0);

		expect(runtime.fetchMessageHistoryPage).toHaveBeenCalledTimes(1);
		expect(runtime.fetchMessageHistoryPage).toHaveBeenCalledWith(null);
		expect(saveCursor).toHaveBeenCalledWith(12);

		input.stop();
	});

	it("P1-4 游标预置 CAS：查询在途时游标被并发写入 → 放弃预置（不覆盖）", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		let cursor: number | null = null;
		runtime.loadCursor = vi.fn(() => cursor);
		const saveCursor = vi.fn((next: number) => {
			cursor = next;
		});
		runtime.saveCursor = saveCursor;
		// 查询在途期间（await 前）由并发 pullIncrement 写入游标 7。
		runtime.fetchMessageHistoryPage = vi.fn(async () => {
			cursor = 7;
			return { messages: [], cursor: null, hasMore: false, totalMessages: 12 };
		});

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		await vi.advanceTimersByTimeAsync(0);

		expect(saveCursor).not.toHaveBeenCalledWith(12);
		expect(cursor).toBe(7);

		input.stop();
	});

	it("P1-4 游标预置新帧路径：readyLatestSequence 非 null → 直接 saveCursor（零 RPC）", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		runtime.loadCursor = vi.fn(() => null);
		const saveCursor = vi.fn();
		runtime.saveCursor = saveCursor;
		runtime.readyLatestSequence = 12;
		runtime.fetchMessageHistoryPage = vi.fn();

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		await vi.advanceTimersByTimeAsync(0);

		// 新帧：进入时刻精确水位直接写，不触发查询 RPC。
		expect(saveCursor).toHaveBeenCalledWith(12);
		expect(runtime.fetchMessageHistoryPage).not.toHaveBeenCalled();

		input.stop();
	});

	it("A1（修订）: idle update arms the 1s trigger window and consumes once at expiry", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		runtime.fetchMessagesSince = vi.fn(async (since: number) => ({
			messages: [aPublicMessage("user_persona", { sequence: since + 1 })],
			latestSequence: since + 1,
			totalMessages: since + 1,
			contextCount: 0,
		}));
		runtime.loadCursor = vi.fn(() => 4);
		runtime.saveCursor = vi.fn();
		runtime.isAgentActive = false;

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		handler({
			jsonrpc: "2.0",
			method: "group_chat_update",
			params: {
				latest_sequence: 5,
				preview_messages: [aPublicMessage("user_persona", { sequence: 5 })],
				total_messages: 5,
			},
		} as unknown as ServerMessage);

		// 窗口未到期：不拉取（广播 = 纯标记，不走 1s join debounce）。
		await vi.advanceTimersByTimeAsync(999);
		expect(runtime.fetchMessagesSince).not.toHaveBeenCalled();

		// 窗口到期：1 次拉全 + 投递（A1 修订：闲态 ≤1s 触发）。
		await vi.advanceTimersByTimeAsync(1);
		expect(runtime.fetchMessagesSince).toHaveBeenCalledWith(4);
		expect(runtime.saveCursor).toHaveBeenCalledWith(5);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		input.stop();
	});

	it("A3/A4: pull returns strictly increasing no-gap messages after cursor", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		runtime.fetchMessagesSince = vi.fn(async (since: number) => {
			// 模拟丢失的通知：cursor 为 1，服务器有 2..5。
			const messages = [2, 3, 4, 5]
				.filter((seq) => seq > since)
				.map((seq) => aPublicMessage("user_persona", { sequence: seq }));
			return { messages, latestSequence: 5, totalMessages: 5, contextCount: 0 };
		});
		runtime.loadCursor = vi.fn(() => 1);
		runtime.saveCursor = vi.fn();
		runtime.isAgentActive = false;

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		handler({
			jsonrpc: "2.0",
			method: "group_chat_update",
			params: {
				latest_sequence: 5,
				preview_messages: [aPublicMessage("user_persona", { sequence: 5 })],
				total_messages: 5,
			},
		} as unknown as ServerMessage);
		// 闲态 1s 触发窗口到期后拉取。
		await vi.advanceTimersByTimeAsync(1000);

		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<{ sequence?: number }> } };
		const sequences = message.details.events
			.map((e) => (e as { params?: { sequence?: number } }).params?.sequence)
			.sort((a, b) => (a ?? 0) - (b ?? 0));
		expect(sequences).toEqual([2, 3, 4, 5]);
		expect(runtime.saveCursor).toHaveBeenCalledWith(5);

		input.stop();
	});

	it("→busy-steer: member events during a run merge with the immediately-pulled batch, order preserved", async () => {
		// 忙态 steer 契约：成员事件仍走 join debounce
		// （1000ms）入 pendingEvents；run 活跃期 update 立即拉取 + steer 投递，
		// 与待处理成员事件合并为一次投递（到达顺序保持：事件先到，消息更新）。
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
			hasPublicMessages: true,
		});
		runtime.fetchMessagesSince = vi.fn(async (since: number) => ({
			messages: [7].filter((seq) => seq > since).map((seq) => aPublicMessage("user_persona", { sequence: seq })),
			latestSequence: 7,
			totalMessages: 7,
			contextCount: 0,
		}));
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

		// 运行中成员加入，然后消息通知到达。
		handler(aCharacterJoined());
		handler({
			jsonrpc: "2.0",
			method: "group_chat_update",
			params: {
				latest_sequence: 7,
				preview_messages: [],
				total_messages: 7,
			},
		} as unknown as ServerMessage);
		// run 活跃期间只排隐藏令牌；安全边界 abort、settled 后再拉取。
		await vi.advanceTimersByTimeAsync(0);
		expect(input.consumeAbortControlToken(vi.fn())).toBe(true);
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(runtime.fetchMessagesSince).toHaveBeenCalledWith(6);
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<{ params?: { sequence?: number } }> } };
		expect(message.details.events.map((e) => (e as Record<string, unknown>).method)).toEqual(["public_message"]);
		const options = call[1] as { deliverAs: string };
		expect(options.deliverAs).toBe("followUp");

		// settle → 补拉全（游标已推进到 7 → 空拉取，无重复投递）。
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);

		// join debounce 稍后触发，无剩余可投递。
		await vi.advanceTimersByTimeAsync(1000);
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);

		input.stop();
	});

	it("busy-steer B6: busy update pulls immediately and delivers via steer; cursor advances on delivery", async () => {
		// B6 不变量保持：客户端在 speak 时仍不推进光标（仅投递成功推进）。
		// 忙态契约：run 活跃期 update 立即拉取 [7,8,9] + steer 投递；
		// 光标在投递成功（preflight）时推进到 9——settle 补拉从新游标（空）。
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
			contextCount: 0,
		}));
		runtime.isAgentActive = true;

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		// 7..9 的通知在运行中到达。
		handler({
			jsonrpc: "2.0",
			method: "group_chat_update",
			params: {
				latest_sequence: 9,
				preview_messages: [],
				total_messages: 9,
			},
		} as unknown as ServerMessage);
		// 忙态先排令牌；安全边界 abort、settled 后一次拉全并 followUp 重开。
		await vi.advanceTimersByTimeAsync(0);
		expect(input.consumeAbortControlToken(vi.fn())).toBe(true);
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(runtime.fetchMessagesSince).toHaveBeenCalledTimes(1);
		expect(runtime.fetchMessagesSince).toHaveBeenCalledWith(6);
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<{ sequence?: number }> } };
		const sequences = message.details.events
			.map((e) => (e as { params?: { sequence?: number } }).params?.sequence)
			.sort((a, b) => (a ?? 0) - (b ?? 0));
		expect(sequences).toEqual([7, 8, 9]);
		expect(cursor).toBe(9);

		// settle → 补拉全（游标已推进 → 空拉取）：无额外投递。
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);

		input.stop();
	});

	it("busy-steer T2: cursor advances monotonically; sequential consumes never overlap or duplicate", async () => {
		// 忙态契约：光标仅在投递成功时推进（双通道判定）。
		// run 中两条通知（7，然后 9）：第一条立即拉取（since 6 → [7]）投递
		// 推进到 7；第二条立即拉取（since 7 → [8,9]）推进到 9。两次光标
		// 保存严格递增、不重叠——无重复、无间隙、不重拉已投递窗口。
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		const fetchSinceCalls: number[] = [];
		runtime.fetchMessagesSince = vi.fn(async (since: number) => {
			fetchSinceCalls.push(since);
			if (since === 6) {
				return {
					messages: [7, 8, 9].map((seq) => aPublicMessage("user_persona", { sequence: seq })),
					latestSequence: 9,
					totalMessages: 9,
					contextCount: 0,
				};
			}
			return { messages: [], latestSequence: since, totalMessages: since, contextCount: 0 };
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
			jsonrpc: "2.0",
			method: "group_chat_update",
			params: {
				latest_sequence: 7,
				preview_messages: [],
				total_messages: 7,
			},
		} as unknown as ServerMessage);
		handler({
			jsonrpc: "2.0",
			method: "group_chat_update",
			params: {
				latest_sequence: 9,
				preview_messages: [],
				total_messages: 9,
			},
		} as unknown as ServerMessage);
		// 两条通知合并为一个令牌，settled 后一次拉全 [7,8,9]。
		await vi.advanceTimersByTimeAsync(0);
		expect(input.consumeAbortControlToken(vi.fn())).toBe(true);
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchSinceCalls).toEqual([6]);
		expect(runtime.saveCursor).toHaveBeenCalledOnce();
		expect(runtime.saveCursor).toHaveBeenCalledWith(9);
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
		const delivery = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1] as [unknown, unknown];
		const delivered = (
			delivery[0] as { details: { events: Array<{ params?: { sequence?: number } }> } }
		).details.events.map((event) => event.params?.sequence);
		expect(delivered).toEqual([7, 8, 9]);
		expect((delivery[1] as { deliverAs: string }).deliverAs).toBe("followUp");

		input.stop();
	});

	it("T3 (revised ): delivery channels keep steer semantics; no group-chat marker involved", async () => {
		// 标记机制已删除——点亮由 agent_start 无条件执行（run 活跃即亮，
		// 拍板），投递路径不再涉及标记。保留的语义断言 =
		// 通道选择：idle 用 followUp+triggerTurn，忙态用 steer+triggerTurn。
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		const pi = createMockPi();

		// idle 投递：followUp 通道 + triggerTurn（开启新 turn 唤醒 agent）。
		const idleInput = new GroupChatInput(runtime, pi);
		idleInput.start();
		const idleHandler = runtime.onEnvironmentMessage ?? (() => {});
		idleHandler(aPublicMessage("user_persona"));
		await vi.advanceTimersByTimeAsync(1000);
		const idleOptions = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
			deliverAs: string;
			triggerTurn: boolean;
		};
		expect(idleOptions.deliverAs).toBe("followUp");
		expect(idleOptions.triggerTurn).toBe(true);
		idleInput.stop();
		(pi.sendMessage as ReturnType<typeof vi.fn>).mockClear();

		// 活跃 run：忙态走 steer 通道（deliverAs=steer + triggerTurn=true——
		// streaming 时 pi 忽略照常入队；非 streaming 时触发唤醒，堵
		// agent_settled 缺失的 wedged 场景）。
		runtime.fetchMessagesSince = vi.fn(async (since: number) => ({
			messages: [aPublicMessage("user_persona", { sequence: since + 1 })],
			latestSequence: since + 1,
			totalMessages: since + 1,
			contextCount: 0,
		}));
		runtime.isAgentActive = true;
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler({
			jsonrpc: "2.0",
			method: "group_chat_update",
			params: {
				latest_sequence: 1,
				preview_messages: [],
				total_messages: 1,
			},
		} as unknown as ServerMessage);
		// 忙态：立即拉取 + 立即 steer 投递。
		await vi.advanceTimersByTimeAsync(0);
		expect((pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
			deliverAs: "steer",
			triggerTurn: true,
		});
		input.stop();
	});

	it("A7（修订）: single-flight lock coalesces concurrent consumes into one refetch", async () => {
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
			return { messages: [], latestSequence: calls, totalMessages: calls, contextCount: 0 };
		});
		runtime.loadCursor = vi.fn(() => 0);
		runtime.saveCursor = vi.fn();
		runtime.isAgentActive = true;

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		// settle 触发的消费在途（fetch 未完成）时，新 update 到达。
		handler({
			jsonrpc: "2.0",
			method: "group_chat_update",
			params: {
				latest_sequence: 1,
				preview_messages: [],
				total_messages: 1,
			},
		} as unknown as ServerMessage);
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toBe(1); // settle 消费：1 次拉取在途

		// 消费在途时新 update（闲态）→ 窗口开启；到期触发合并。
		handler({
			jsonrpc: "2.0",
			method: "group_chat_update",
			params: {
				latest_sequence: 2,
				preview_messages: [],
				total_messages: 2,
			},
		} as unknown as ServerMessage);
		await vi.advanceTimersByTimeAsync(1000);
		expect(calls).toBe(1); // single flight：在途期间不并发拉取

		resolveFirst?.();
		await vi.advanceTimersByTimeAsync(0);
		// 第一次完成后一次合并补拉。
		expect(calls).toBe(2);

		input.stop();
	});

	it("busy-steer: busy consume preserves order, no gaps or duplicates in the batch", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({ getGroupChatState: async () => ({}) });
		runtime.fetchMessagesSince = vi.fn(async () => ({
			messages: [5, 6, 7].map((seq) => aPublicMessage("user_persona", { sequence: seq })),
			latestSequence: 7,
			totalMessages: 7,
			contextCount: 0,
		}));
		runtime.loadCursor = vi.fn(() => 4);
		runtime.saveCursor = vi.fn();
		runtime.isAgentActive = true;

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		for (const seq of [5, 6, 7]) {
			handler({
				jsonrpc: "2.0",
				method: "group_chat_update",
				params: {
					latest_sequence: seq,
					preview_messages: [aPublicMessage("user_persona", { sequence: seq })],
					total_messages: seq,
				},
			} as unknown as ServerMessage);
		}
		// 忙态：飞行锁合并并发通知 → 一次拉全 + 一次投递（保序不重不漏）。
		await vi.advanceTimersByTimeAsync(0);
		expect(input.consumeAbortControlToken(vi.fn())).toBe(true);
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);

		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<{ sequence?: number }> } };
		const sequences = message.details.events
			.map((e) => (e as { params?: { sequence?: number } }).params?.sequence)
			.sort((a, b) => (a ?? 0) - (b ?? 0));
		expect(sequences).toEqual([5, 6, 7]); // 一次投递、保序、不重不漏

		input.stop();
	});

	it(": idle updates consume once at the 1s trigger window (A1 修订)", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({ getGroupChatState: async () => ({}) });
		runtime.fetchMessagesSince = vi.fn(async (since: number) => ({
			messages: [aPublicMessage("user_persona", { sequence: (since as number) + 1 })],
			latestSequence: (since as number) + 1,
			totalMessages: (since as number) + 1,
			contextCount: 0,
		}));
		runtime.loadCursor = vi.fn(() => 4);
		runtime.saveCursor = vi.fn();
		runtime.isAgentActive = false; // 闲态：1s 触发窗口聚合

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		handler({
			jsonrpc: "2.0",
			method: "group_chat_update",
			params: {
				latest_sequence: 5,
				preview_messages: [aPublicMessage("user_persona", { sequence: 5 })],
				total_messages: 5,
			},
		} as unknown as ServerMessage);
		// 窗口内：0 拉取；到期：1 次拉全 + 1 次投递（≤1s 延迟）。
		await vi.advanceTimersByTimeAsync(999);
		expect(runtime.fetchMessagesSince).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(runtime.fetchMessagesSince).toHaveBeenCalledTimes(1);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		input.stop();
	});

	// （pull 模型：广播 = 标记、消费 = run 边界拉取）红钉先行：当前代码活跃期
	// update 走 400ms 聚合窗口拉取+投递，以下断言必红；实施「标记不拉取 + run 内
	// 零中间注入 + settle = 忙态触发点」后变绿。空拉取 mock：settle 消费发生（1 次
	// 拉取）但无内容可投递 → 不触发空 run（0 次投递）。
	it("busy-steer: busy updates pull immediately (single-flight); empty fetch → no empty run", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({ getGroupChatState: async () => ({}) });
		const fetchMock = vi.fn(async () => ({
			messages: [],
			latestSequence: 0,
			totalMessages: 0,
			contextCount: 0,
		}));
		runtime.fetchMessagesSince = fetchMock;
		runtime.loadCursor = vi.fn(() => 4);
		runtime.saveCursor = vi.fn();
		runtime.isAgentActive = true;

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		// 活跃 run 内顺序到达 3 条通知：立即拉取（飞行锁合并：1 次 + refetch 补拉 1 次）。
		for (const seq of [5, 6, 7]) {
			handler({
				jsonrpc: "2.0",
				method: "group_chat_update",
				params: {
					latest_sequence: seq,
					preview_messages: [],
					total_messages: seq,
				},
			} as unknown as ServerMessage);
		}
		await vi.advanceTimersByTimeAsync(0);
		expect(input.consumeAbortControlToken(vi.fn())).toBe(true);
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		// settle：忙态标记消费 → 补拉全（游标未推进 → 仍空批）不投递。
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		input.stop();
	});

	// （pull 模型混合触发，User 倾向「agent 忙立即拉、不忙等一等」）：闲态 = 首条标记
	// 启动 1s 固定窗口，窗口内 N 条并入 → 1 次触发拉全。当前代码空闲期逐条立即拉取，必红。
	it("RED: idle markers aggregate in a 1s window and trigger a single fetch-all", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({ getGroupChatState: async () => ({}) });
		const fetchMock = vi.fn(async (since: number) => ({
			messages: [5, 6, 7].filter((seq) => seq > since).map((seq) => aPublicMessage("user_persona", { sequence: seq })),
			latestSequence: 7,
			totalMessages: 7,
			contextCount: 0,
		}));
		runtime.fetchMessagesSince = fetchMock;
		runtime.loadCursor = vi.fn(() => 4);
		runtime.saveCursor = vi.fn();
		runtime.isAgentActive = false; // 闲态

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		// 窗口内顺序到达 3 条通知。
		for (const seq of [5, 6, 7]) {
			handler({
				jsonrpc: "2.0",
				method: "group_chat_update",
				params: {
					latest_sequence: seq,
					preview_messages: [],
					total_messages: seq,
				},
			} as unknown as ServerMessage);
		}
		// 窗口未到期：0 拉取。
		await vi.advanceTimersByTimeAsync(999);
		expect(fetchMock).toHaveBeenCalledTimes(0);
		expect(pi.sendMessage).toHaveBeenCalledTimes(0);

		// 窗口到期：1 次触发拉全 + 1 次投递（保序）。
		await vi.advanceTimersByTimeAsync(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(4);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		input.stop();
	});

	// 忙态契约：run 活跃期 update 立即拉取（无窗口、
	// 无有界延迟设计），单飞行锁仅并发保护；投递走 steer 通道。
	it("busy-steer: busy updates pull immediately (single-flight) and deliver via steer", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({ getGroupChatState: async () => ({}) });
		const fetchMock = vi.fn(async (since: number) => ({
			messages: [5, 6, 7].filter((seq) => seq > since).map((seq) => aPublicMessage("user_persona", { sequence: seq })),
			latestSequence: 7,
			totalMessages: 7,
			contextCount: 0,
		}));
		runtime.fetchMessagesSince = fetchMock;
		let cursor = 4;
		runtime.loadCursor = vi.fn(() => cursor);
		runtime.saveCursor = vi.fn((value: number) => {
			cursor = value;
		});
		runtime.isAgentActive = true; // 忙态

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		// 活跃 run 内顺序到达 3 条通知：立即拉取（飞行锁合并 1 次拉全 + 补拉）。
		for (const seq of [5, 6, 7]) {
			handler({
				jsonrpc: "2.0",
				method: "group_chat_update",
				params: {
					latest_sequence: seq,
					preview_messages: [],
					total_messages: seq,
				},
			} as unknown as ServerMessage);
		}
		// 首次拉取（since 4 → [5,6,7]）+ 投递（steer，游标推进 7）；补拉（since 7 → 空）。
		await vi.advanceTimersByTimeAsync(0);
		expect(input.consumeAbortControlToken(vi.fn())).toBe(true);
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(4);
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
		expect((pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]).toMatchObject({ deliverAs: "followUp" });
		expect(runtime.saveCursor).toHaveBeenCalledWith(7);

		// settle：补拉全（游标已推进 → 空）无重复投递。
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);

		input.stop();
	});

	// v0.5 安全边界修正：窗口开启中若由他源启动 run，已确认含他人消息的窗口
	// 到期时转为忙态隐藏令牌；正文仍不在 run 中拉取，settled 后一次拉全。
	it("idle window expiry queues an abort token when another source starts a run", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({ getGroupChatState: async () => ({}) });
		const fetchMock = vi.fn(async (since: number) => ({
			messages: [5].filter((seq) => seq > since).map((seq) => aPublicMessage("user_persona", { sequence: seq })),
			latestSequence: 5,
			totalMessages: 5,
			contextCount: 0,
		}));
		runtime.fetchMessagesSince = fetchMock;
		runtime.loadCursor = vi.fn(() => 4);
		runtime.saveCursor = vi.fn();
		runtime.isAgentActive = false;

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		// 闲态首条标记 → 窗口开启。
		handler({
			jsonrpc: "2.0",
			method: "group_chat_update",
			params: {
				latest_sequence: 5,
				preview_messages: [],
				total_messages: 5,
			},
		} as unknown as ServerMessage);

		// 窗口开启中 run 从他源启动（如用户直聊）。
		runtime.isAgentActive = true;

		// 窗口到期：正文不拉取，只排一个隐藏安全边界令牌。
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetchMock).toHaveBeenCalledTimes(0);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(input.consumeAbortControlToken(vi.fn())).toBe(true);

		// settle：忙态规则，0 延迟触发 1 次拉全。
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(4); // 拉取范围 = 光标后全量（含窗口内消息）
		// 防悬置：窗口内消息未被吞——送达内容含 seq 5。
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<{ sequence?: number }> } };
		const sequences = message.details.events
			.map((e) => (e as { params?: { sequence?: number } }).params?.sequence)
			.sort((a, b) => (a ?? 0) - (b ?? 0));
		expect(sequences).toEqual([5]);

		input.stop();
	});

	it("reload preserves the idle window deadline and abort eligibility", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({ getGroupChatState: async () => ({}) });
		const fetchMock = vi.fn(async (since: number) => ({
			messages: [5].filter((seq) => seq > since).map((seq) => aPublicMessage("user_persona", { sequence: seq })),
			latestSequence: 5,
			totalMessages: 5,
			contextCount: 0,
		}));
		runtime.fetchMessagesSince = fetchMock;
		runtime.loadCursor = vi.fn(() => 4);
		runtime.saveCursor = vi.fn();

		const input = new GroupChatInput(runtime, createMockPi());
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler({
			jsonrpc: "2.0",
			method: "group_chat_update",
			params: {
				latest_sequence: 5,
				preview_messages: [aPublicMessage("user_persona", { sequence: 5 })],
				total_messages: 5,
			},
		} as unknown as ServerMessage);
		await vi.advanceTimersByTimeAsync(400);

		const snapshot = input.snapshotForReload();
		expect(snapshot.idleWindowAbortEligible).toBe(true);
		input.stop();

		const resumedPi = createMockPi();
		const resumed = new GroupChatInput(runtime, resumedPi);
		resumed.start();
		resumed.restoreFromReload(snapshot);
		runtime.isAgentActive = true;

		// 继承原窗口剩余的 600ms，而不是重新等待完整 1s。
		await vi.advanceTimersByTimeAsync(599);
		expect(fetchMock).toHaveBeenCalledTimes(0);
		expect(resumedPi.sendMessage).not.toHaveBeenCalled();

		// reload 后窗口转忙，保留的 external 证据使其排安全边界令牌。
		await vi.advanceTimersByTimeAsync(1);
		expect(resumedPi.sendMessage).toHaveBeenCalledTimes(1);
		expect(resumed.consumeAbortControlToken(vi.fn())).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(0);

		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(4);

		resumed.stop();
	});

	it("P1-F1 窗口含已读他人消息 + 连续自身回显 → 不投递不唤醒（P1 评审回归，红钉）", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		//  窗口语义：since=4 前移 1 → 服务端返回 seq>3 的集合 = 已读游标自身
		// （seq4 他人消息，窗口带入）+ 未读自身回显（seq5/seq6）。
		runtime.fetchMessagesSince = vi.fn(
			async (_since: number): Promise<Awaited<ReturnType<CharacterRuntime["fetchMessagesSince"]>>> => ({
				messages: [
					aPublicMessage("user_persona", { event_id: "evt-4", sequence: 4 }),
					{
						jsonrpc: "2.0",
						method: "public_message",
						params: {
							event_id: "evt-5",
							sequence: 5,
							timestamp: "2026-01-01T00:00:00.000Z",
							sender: { type: "character", character_id: "dev", name: "Dev" },
							content: "Hello",
							round: { round_max_messages: 10, used_messages: 1, remaining_messages: 9 },
						},
					},
					{
						jsonrpc: "2.0",
						method: "public_message",
						params: {
							event_id: "evt-6",
							sequence: 6,
							timestamp: "2026-01-01T00:00:00.000Z",
							sender: { type: "character", character_id: "dev", name: "Dev" },
							content: "Hello",
							round: { round_max_messages: 10, used_messages: 1, remaining_messages: 9 },
						},
					},
				],
				latestSequence: 6,
				totalMessages: 6,
				// P1-F1：seq4 = 已读窗口内容（contextCount=1），seq5/seq6 = 未读自身回显。
				contextCount: 1,
			}),
		);
		runtime.loadCursor = vi.fn(() => 4);
		runtime.saveCursor = vi.fn();
		runtime.isAgentActive = false;

		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);
		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});

		// preview 只带最近 1 条自身回显（latest=6 而 preview 仅 seq6）→
		// classifySelfPreview = incomplete-with-self → 保守拉取（QA E5 同款场景）。
		handler({
			jsonrpc: "2.0",
			method: "group_chat_update",
			params: {
				latest_sequence: 6,
				preview_messages: [
					{
						jsonrpc: "2.0",
						method: "public_message",
						params: {
							event_id: "evt-6",
							sequence: 6,
							timestamp: "2026-01-01T00:00:00.000Z",
							sender: { type: "character", character_id: "dev", name: "Dev" },
							content: "Hello",
							round: { round_max_messages: 10, used_messages: 1, remaining_messages: 9 },
						},
					},
				],
				total_messages: 6,
			},
		} as unknown as ServerMessage);
		await vi.advanceTimersByTimeAsync(1000);

		// 修复目标（WL-F）：未读区间（>4）无可投递事件（全自身回显）→
		// 不投递不唤醒，仅消费水位。修复前：messages 含 seq4 已读他人消息
		// → 误投递（红钉首跑 1 failed 实证）。
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(runtime.saveCursor).toHaveBeenCalledWith(6);

		input.stop();
	});

	function whisperMessageFrame(sequence: number): ServerMessage {
		return {
			jsonrpc: "2.0",
			method: "whisper_message",
			params: {
				sequence,
				sender: { type: "character", character_id: "dev", name: "Dev" },
				recipient: { type: "character", character_id: "qa", name: "QA" },
				content: `secret-${sequence}`,
			},
		} as unknown as ServerMessage;
	}

	function whisperPlaceholderFrame(sequence: number): ServerMessage {
		return {
			jsonrpc: "2.0",
			method: "whisper_placeholder",
			params: {
				sequence,
				sender: { type: "character", character_id: "dev", name: "Dev" },
				recipient: { type: "character", character_id: "qa", name: "QA" },
			},
		} as unknown as ServerMessage;
	}

	it("chain: join-snapshot whisper 帧投递（阻断 2：首屏 message_history 接纳两类 whisper 帧）", async () => {
		vi.useFakeTimers();
		const runtime = createMockRuntime({ hasPublicMessages: true });
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler({
			jsonrpc: "2.0",
			method: "message_history",
			params: {
				messages: [
					{
						jsonrpc: "2.0",
						method: "public_message",
						params: {
							event_id: "evt-1",
							sequence: 1,
							timestamp: "2026-08-08T00:00:00.000Z",
							sender: { type: "user_persona" },
							content: "hello",
							round: { round_max_messages: 10, used_messages: 1, remaining_messages: 9 },
						},
					},
					whisperMessageFrame(2),
					whisperPlaceholderFrame(3),
				],
				cursor: null,
				has_more: false,
				total_messages: 3,
			},
		} as unknown as ServerMessage);
		await vi.advanceTimersByTimeAsync(1000);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const message = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { content?: string };
		expect(message.content ?? "").toContain("hello");
		expect(message.content ?? "").toContain("Dev 向 QA 悄悄说：secret-2");
		expect(message.content ?? "").toContain("Dev 向 QA 悄悄说了一句话");

		input.stop();
	});

	it("chain: whisper realtime 连续帧游标推进（阻断 3：seq=游标+1 注入 + saveCursor）", async () => {
		vi.useFakeTimers();
		const runtime = createMockRuntime({ hasPublicMessages: true });
		runtime.loadCursor = () => 0;
		const saveCursor = vi.fn();
		runtime.saveCursor = saveCursor;
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler(whisperMessageFrame(1));
		await vi.advanceTimersByTimeAsync(1000);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const message = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { content?: string };
		expect(message.content ?? "").toContain("secret-1");
		// 连续帧：投递成功推进游标到水位（不卡 stale）。
		expect(saveCursor).toHaveBeenCalledWith(1);

		input.stop();
	});

	it("chain: whisper realtime 同 seq 去重内容仅一份（复评阻断 1：flush 前同帧两次只进一份）", async () => {
		vi.useFakeTimers();
		const runtime = createMockRuntime({ hasPublicMessages: true });
		runtime.loadCursor = () => 0;
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler(whisperMessageFrame(1));
		handler(whisperMessageFrame(1)); // 同批重复帧
		await vi.advanceTimersByTimeAsync(1000);

		const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
		expect(sendMessage).toHaveBeenCalledTimes(1);
		const content = sendMessage.mock.calls[0]?.[0]?.content as string;
		// 正文仅一份（同 batch 注入两遍会重复出现）。
		expect(content.match(/secret-1/g)?.length ?? 0).toBe(1);

		input.stop();
	});

	it("chain: whisper realtime gap idle 主动补拉（复评阻断 1：idle 无 settle，须主动安排拉取）", async () => {
		vi.useFakeTimers();
		const runtime = createMockRuntime({ hasPublicMessages: true });
		runtime.loadCursor = () => 0;
		const fetchMessagesSince = vi.fn(async () => ({
			messages: [whisperMessageFrame(1), whisperMessageFrame(2), whisperMessageFrame(3)],
			latestSequence: 3,
			totalMessages: 3,
			contextCount: 0,
		}));
		runtime.fetchMessagesSince = fetchMessagesSince;
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
		// 环境更新批次先投递完成（join 首轮注入）。
		await vi.advanceTimersByTimeAsync(1000);
		const callsBefore = sendMessage.mock.calls.length;
		handler(whisperMessageFrame(3)); // 前置缺口 1-2 未消费
		// 窗口（TRIGGER_DEBOUNCE_MS=1000）未到期：gap 帧未直接注入（次数不增），
		// 也未立即拉取——idle 主动安排了拉取窗口。
		await vi.advanceTimersByTimeAsync(500);
		expect(sendMessage.mock.calls.length).toBe(callsBefore);
		expect(fetchMessagesSince).not.toHaveBeenCalled();
		// 窗口到期 → pullIncrement → fetchMessagesSince 全窗口顺序消费。
		await vi.advanceTimersByTimeAsync(2000);
		expect(fetchMessagesSince).toHaveBeenCalled();
		// 补拉窗口消费后投递（含缺口帧 1-2 + 实时帧 3，顺序不跳过）。
		await vi.advanceTimersByTimeAsync(1000);
		const contents = sendMessage.mock.calls.map((call) => (call[0] as { content?: string })?.content ?? "");
		expect(contents.some((c) => c.includes("secret-1"))).toBe(true);
		expect(contents.some((c) => c.includes("secret-3"))).toBe(true);

		input.stop();
	});

	it("chain: whisper realtime 旧帧忽略（复评阻断 2：seq <= 已投递游标不去重丢帧亦不重复注入）", async () => {
		vi.useFakeTimers();
		const runtime = createMockRuntime({ hasPublicMessages: true });
		runtime.loadCursor = () => 5; // 已投递到 5
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler(whisperMessageFrame(5)); // reload 重放旧帧
		await vi.advanceTimersByTimeAsync(1000);

		expect(pi.sendMessage).not.toHaveBeenCalled();

		input.stop();
	});

	it("chain: whisper realtime 连续两帧有序投递（复评阻断 2：同 debounce 连续帧不误判 gap）", async () => {
		vi.useFakeTimers();
		const runtime = createMockRuntime({ hasPublicMessages: true });
		runtime.loadCursor = () => 0;
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler(whisperMessageFrame(1));
		handler(whisperMessageFrame(2)); // 同批连续延伸
		await vi.advanceTimersByTimeAsync(1000);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const message = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { content?: string };
		expect(message.content ?? "").toContain("secret-1");
		expect(message.content ?? "").toContain("secret-2");

		input.stop();
	});

	it("chain: whisper realtime 同步失败 requeue 恢复（复评阻断 2：真实抛错 → 游标不推进 → requeue 重投成功）", async () => {
		vi.useFakeTimers();
		const runtime = createMockRuntime({ hasPublicMessages: true });
		runtime.loadCursor = () => 0;
		const saveCursor = vi.fn();
		runtime.saveCursor = saveCursor;
		const pi = createMockPi();
		// 首次 sendMessage 真实同步抛错（入队拒绝，非 async——rejected promise
		// 不会触发 sendWithDeliveryAck 的同步 catch），第二次成功。
		let failFirst = true;
		(pi.sendMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
			if (failFirst) {
				failFirst = false;
				throw new Error("enqueue rejected");
			}
			return undefined;
		});
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler(whisperMessageFrame(1));
		// 首次投递：同步抛错 → 不推进游标。
		await vi.advanceTimersByTimeAsync(1000);
		expect(saveCursor).not.toHaveBeenCalled();
		// requeue 已安排（pendingEvents 回放 + idle 窗口重投）→ 第二次成功。
		await vi.advanceTimersByTimeAsync(5000);
		const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
		// 成功投递含正文 + 游标最终推进（重复可接受、跳过不可接受）。
		const contents = sendMessage.mock.calls.map((call) => (call[0] as { content?: string })?.content ?? "");
		expect(contents.some((c) => c.includes("secret-1"))).toBe(true);
		expect(saveCursor).toHaveBeenCalledWith(1);

		input.stop();
	});

	it("chain: whisper steer 同步失败 requeue 不丢（复评阻断 1：busy 实时私信 steer 抛错 → 重排重投成功只推进一次）", async () => {
		vi.useFakeTimers();
		const runtime = createMockRuntime({ hasPublicMessages: true });
		runtime.loadCursor = () => 0;
		runtime.isAgentActive = true; // busy：实时私信走 steer 通道
		const saveCursor = vi.fn();
		runtime.saveCursor = saveCursor;
		const pi = createMockPi();
		let failFirst = true;
		(pi.sendMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
			if (failFirst) {
				failFirst = false;
				throw new Error("steer enqueue rejected");
			}
			return undefined;
		});
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler(whisperMessageFrame(1));
		await vi.advanceTimersByTimeAsync(1000);
		// 首次 steer 同步抛错：不推进游标（事件未丢——requeue 重排）。
		expect(saveCursor).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2000);
		// 重投成功（steer 通道）：正文投递 + 游标最终推进。
		const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
		const contents = sendMessage.mock.calls.map((call) => (call[0] as { content?: string })?.content ?? "");
		expect(contents.some((c) => c.includes("secret-1"))).toBe(true);
		expect(saveCursor).toHaveBeenCalledWith(1);

		input.stop();
	});

	it("chain: whisper placeholder-only 不阻塞（无 group_chat_update 时占位水位独立成立，占位不触发未读先读）", async () => {
		vi.useFakeTimers();
		const runtime = createMockRuntime({ hasPublicMessages: true });
		runtime.loadCursor = () => 0;
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler(whisperPlaceholderFrame(3));
		await vi.advanceTimersByTimeAsync(1000);

		// 占位不注入（不唤醒），未读判定合并占位水位但不触发阻塞
		// 占位无正文零信息增量，不拦协议性回复；水位/计数/消费语义保留）。
		expect(pi.sendMessage).not.toHaveBeenCalled();
		// 占位 seq=3、游标 0：缺口存在 → 不阻止（shouldBlock=false），计数保留不声称精确。
		expect(input.unreadOthersProven()?.shouldBlock).toBe(false);
		expect(input.unreadOthersProven()?.count).toBe(1);
		expect(input.unreadOthersProven()?.exact).toBe(false);

		input.stop();
	});

	it("chain: whisper pull 占位窗口失败恢复推进原始水位（复评阻断 2：requeue 保留 latestSequence，占位窗口游标不卡）", async () => {
		vi.useFakeTimers();
		const runtime = createMockRuntime({ hasPublicMessages: true });
		runtime.loadCursor = () => 0;
		const saveCursor = vi.fn();
		runtime.saveCursor = saveCursor;
		// pullIncrement 拉取返回「仅占位」窗口（page.latestSequence = 5）。
		runtime.fetchMessagesSince = vi.fn(async () => ({
			messages: [whisperPlaceholderFrame(3), whisperPlaceholderFrame(4), whisperPlaceholderFrame(5)],
			latestSequence: 5,
			totalMessages: 5,
			contextCount: 0,
		}));
		const pi = createMockPi();
		let failFirst = true;
		(pi.sendMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
			if (failFirst) {
				failFirst = false;
				throw new Error("enqueue rejected");
			}
			return undefined;
		});
		const input = new GroupChatInput(runtime, pi);

		input.start();
		// 触发增量拉取：先有水位知识（group_chat_update）→ armIdleWindow → pull。
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler({
			jsonrpc: "2.0",
			method: "group_chat_update",
			params: {
				latest_sequence: 5,
				preview_messages: [],
				total_messages: 5,
			},
		} as unknown as ServerMessage);
		await vi.advanceTimersByTimeAsync(2000);
		// 首次投递失败（游标不推进）→ requeue（保留原始水位 5）→ 重投成功。
		await vi.advanceTimersByTimeAsync(2000);
		// 游标最终推进到 page.latestSequence = 5（含占位窗口——占位也消费推进，
		// 否则后续 speak 反复 stale）。
		expect(saveCursor).toHaveBeenCalledWith(5);

		input.stop();
	});

	it("chain: whisper retry 批原子——B 批成功不得借用 A 批水位（复评阻断：A 重试中 B 成功，saveCursor 随批不全局借用）", async () => {
		vi.useFakeTimers();
		const runtime = createMockRuntime({ hasPublicMessages: true });
		const saveCursor = vi.fn();
		const cursorState = { value: 0 };
		runtime.loadCursor = () => cursorState.value;
		runtime.saveCursor = (seq) => {
			cursorState.value = seq;
			saveCursor(seq);
		};
		// A 批：pull 全窗口 [whisper 1, whisper 2]，真实水位 2——首投失败。
		runtime.fetchMessagesSince = vi.fn(async () => ({
			messages: [whisperMessageFrame(1), whisperMessageFrame(2)],
			latestSequence: 2,
			totalMessages: 2,
			contextCount: 0,
		}));
		const pi = createMockPi();
		let failFirst = true;
		(pi.sendMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
			if (failFirst) {
				failFirst = false;
				throw new Error("enqueue rejected");
			}
			return undefined;
		});
		const input = new GroupChatInput(runtime, pi);

		input.start();
		// 触发 A 批拉取（group_chat_update 水位 2 → idle 窗口 → pull → 失败 requeue）。
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler({
			jsonrpc: "2.0",
			method: "group_chat_update",
			params: { latest_sequence: 2, preview_messages: [], total_messages: 2 },
		} as unknown as ServerMessage);
		// 窗口（1000ms）到期 → pull → 首投失败 → requeue（重投 debounce 未到）。
		await vi.advanceTimersByTimeAsync(1100);
		expect(saveCursor).not.toHaveBeenCalled(); // A 首投失败不推进
		// A 重投成功（retryBatch 原子优先，saveCursor 随 A 水位 2）。
		await vi.advanceTimersByTimeAsync(1100);
		expect(saveCursor).toHaveBeenCalledWith(2);
		// B 批：A 重试成功后再来新实时帧（seq 3 与 A 连续 → 注入 pendingEvents）。
		handler(whisperMessageFrame(3));
		await vi.advanceTimersByTimeAsync(1100);
		const sendMessage = pi.sendMessage as ReturnType<typeof vi.fn>;
		const contents = sendMessage.mock.calls.map((call) => (call[0] as { content?: string })?.content ?? "");
		expect(contents.some((c) => c.includes("secret-1"))).toBe(true);
		// B 批 flush 用自身水位（3），绝不借 A 水位（2）提前推进。
		expect(saveCursor).toHaveBeenCalledWith(3);
		// A 批事件已投递（未丢）——游标序列 [2, 3] 无越级。

		input.stop();
	});

	it("chain: whisper flush 串行——A await 中到达的旧 B 帧不重复投递且 cursor 不回退", async () => {
		vi.useFakeTimers();
		const runtime = createMockRuntime({ hasPublicMessages: true });
		const saveCursor = vi.fn();
		const cursorState = { value: 0 };
		runtime.loadCursor = () => cursorState.value;
		runtime.saveCursor = (seq) => {
			cursorState.value = seq;
			saveCursor(seq);
		};
		const pi = createMockPi();
		// A 批首投失败 → retryBatch {A, 2}。
		let failFirst = true;
		(pi.sendMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
			if (failFirst) {
				failFirst = false;
				throw new Error("enqueue rejected");
			}
			return undefined;
		});
		runtime.fetchMessagesSince = vi.fn(async () => ({
			messages: [whisperMessageFrame(1), whisperMessageFrame(2)],
			latestSequence: 2,
			totalMessages: 2,
			contextCount: 0,
		}));
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler({
			jsonrpc: "2.0",
			method: "group_chat_update",
			params: { latest_sequence: 2, preview_messages: [], total_messages: 2 },
		} as unknown as ServerMessage);
		await vi.advanceTimersByTimeAsync(1100);
		expect(saveCursor).not.toHaveBeenCalled(); // A 首投失败不推进
		// A 重试窗口：getGroupChatState await 期间 B 帧到达（A 批重投的 flush 被挂起）。
		let releaseState: (() => void) | undefined;
		const originalGetGroupChatState = runtime.getGroupChatState;
		runtime.getGroupChatState = () =>
			new Promise<Awaited<ReturnType<typeof originalGetGroupChatState>>>((resolve) => {
				releaseState = () => resolve(undefined as never);
			});
		// 首挂起恢复后：后续 flush（B 批）用原实现，不再挂起。
		const releaseOnce = () => {
			releaseState?.();
			runtime.getGroupChatState = originalGetGroupChatState;
		};
		// B 帧 seq 1：A flush 挂起期游标仍为 0，因此会暂存；A 成功后执行 B
		// flush 时必须按最新 cursor=2 再过滤，不能重复注入或把游标写回 1。
		handler(whisperMessageFrame(1));
		await vi.advanceTimersByTimeAsync(1100);
		// A 的 flush 正挂在 getGroupChatState（B 事件已排队未投递）。
		expect(saveCursor).not.toHaveBeenCalled();
		releaseOnce();
		await vi.advanceTimersByTimeAsync(2000);
		// A 重投成功（水位 2，批原子——B 未借用）。
		expect(saveCursor).toHaveBeenCalledWith(2);
		await vi.advanceTimersByTimeAsync(2000);
		// B 执行时已被 cursor=2 覆盖：不重复投递，游标保持单调，绝不回退到 1。
		expect(saveCursor).toHaveBeenCalledTimes(1);
		expect(cursorState.value).toBe(2);
		// 仅 A 首投失败 + A 重投成功；B 不产生第三次发送。
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);

		input.stop();
	});

	it("chain: whisper placeholder-only exact 仅连续时成立（复评 B 语义保留——占位=游标+1 才 exact，不阻塞）", async () => {
		vi.useFakeTimers();
		const runtime = createMockRuntime({ hasPublicMessages: true });
		runtime.loadCursor = () => 0;
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler(whisperPlaceholderFrame(1)); // 占位 = 游标+1（连续）
		await vi.advanceTimersByTimeAsync(1000);

		expect(input.unreadOthersProven()?.shouldBlock).toBe(false);
		expect(input.unreadOthersProven()?.count).toBe(1);
		expect(input.unreadOthersProven()?.exact).toBe(true);

		input.stop();
	});
	it("WH4 : whisper_message 用 whisper_full 模板渲染（接收者实时唤醒，C 回归）", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({ hasPublicMessages: true });
		runtime.loadCursor = vi.fn(() => 20); // seq 21 = 游标+1 连续（main 版连续性守卫：gap 走补拉不直接注入）
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		handler(
			createWhisperMessage({
				sender: { type: "character", character_id: "dev", name: "Dev" },
				recipient: { type: "character", character_id: "qa", name: "QA" },
				content: "secret plan",
			}),
		);
		await vi.advanceTimersByTimeAsync(1000);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const message = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { content?: string };
		// 默认模板 full = "{sender} 向 {receiver} 悄悄说：{content}"。
		expect(message.content ?? "").toContain("Dev 向 QA 悄悄说：secret plan");

		input.stop();
	});
	it("chain: whisper-placeholder no-wakeup（阻断 2：非参与者占位不注入不唤醒，仅记水位）", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({ hasPublicMessages: true });
		const pi = createMockPi();
		const input = new GroupChatInput(runtime, pi);

		input.start();
		const handler = runtime.onEnvironmentMessage ?? (() => {});
		// 先有水位知识（join 后 group_chat_update 到达），再收占位帧。
		handler({
			jsonrpc: "2.0",
			method: "group_chat_update",
			params: {
				latest_sequence: 5,
				preview_messages: [],
				total_messages: 5,
			},
		} as unknown as ServerMessage);
		handler(
			createWhisperPlaceholder({
				sender: { type: "character", character_id: "dev", name: "Dev" },
				recipient: { type: "character", character_id: "qa", name: "QA" },
			}),
		);
		await vi.advanceTimersByTimeAsync(1000);

		// 占位不注入：无 sendMessage（不唤醒、不进 debounce）。
		expect(pi.sendMessage).not.toHaveBeenCalled();
		// 占位水位记录（seq 22 > cursor 0）：未读判定合并占位水位但不阻塞
		// （占位零信息增量不拦发言；水位/计数/消费语义保留）。
		expect(input.unreadOthersProven()?.shouldBlock).toBe(false);
		expect(input.unreadOthersProven()?.count).toBe(1);

		input.stop();
	});
});
