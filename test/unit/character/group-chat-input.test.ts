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
		// ISSUE-014/#14: delivery marks the next turn as group-chat triggered.
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

		// Own echo
		const handler = runtime.onEnvironmentMessage;
		expect(handler).toBeDefined();
		handler?.(aCharacterPublicMessage("dev"));

		// Debounce timer should NOT have been set
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

		// First message starts the timer
		handler(aPublicMessage("user_persona"));
		expect(input.hasPendingBatch()).toBe(true);

		// Second message resets the timer
		vi.advanceTimersByTime(500);
		handler(aCharacterJoined());
		expect(input.hasPendingBatch()).toBe(true);

		// Timer fires after 1s of silence
		await vi.advanceTimersByTimeAsync(1000);
		expect(input.hasPendingBatch()).toBe(false);

		// pi.sendMessage should have been called
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
		// ISSUE-003 three-field identity contract (cab1fd7)
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

		// Own echo
		handler(aCharacterPublicMessage("dev", { content: "My own" }));
		// Someone else's message
		handler(aCharacterPublicMessage("other", { content: "Other's message" }));
		// User persona
		handler(aPublicMessage("user_persona", { content: "User says" }));

		await vi.advanceTimersByTimeAsync(1000);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<{ content: string }> } };
		const events = message.details.events;

		// Only 2 events: other's message and user persona (own echo filtered out)
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

		// Should not have submitted because join/left events are filtered
		// when there are no public messages (and the batch is empty)
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

		// The creator sends message_history first, then broadcasts
		// character_joined; both must land in the same first batch with the
		// history events before the join event (websocket-protocol.md order).
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

		// Timer should be cleared - advancing time should not trigger send
		vi.advanceTimersByTime(2000);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("pages older history when message_history has_more is set (ISSUE-008)", async () => {
		vi.useFakeTimers();

		// First page: 10 newest (sequences 11-20), has_more with a cursor.
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

		// Let the fire-and-forget paging complete, then flush.
		await vi.advanceTimersByTimeAsync(0);
		expect(runtime.fetchMessageHistoryPage).toHaveBeenCalledWith("cursor-20");

		await vi.advanceTimersByTimeAsync(2000);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<{ type: string; sequence?: number }> } };
		const sequences = message.details.events.map((e) => e.sequence).sort((a, b) => (a ?? 0) - (b ?? 0));
		// All 20 messages (both pages) are present.
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
			// Server never advances the cursor: the client must not loop.
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

		// Exactly one paging request: the repeated cursor terminates the loop.
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

		// No fake-time advance at all: the pull is immediate (A1).
		await vi.advanceTimersByTimeAsync(0);
		expect(runtime.fetchMessagesSince).toHaveBeenCalledWith(4);
		expect(runtime.saveCursor).toHaveBeenCalledWith(5);

		// Delivered immediately since the agent is idle (no debounce wait).
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		input.stop();
	});

	it("M7 A3/A4: pull returns strictly increasing no-gap messages after cursor", async () => {
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		runtime.fetchMessagesSince = vi.fn(async (since: number) => {
			// Simulates a missed notification: cursor is 1, server has 2..5.
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
		// #38 口径 A: the run-active window no longer defers — the pull runs
		// immediately and the delivery switches to the steer channel (delivered
		// after the current tool call, before the next LLM call). The settle
		// hook stays as a safety net: with the cursor already advanced by the
		// run-time delivery, it has nothing left to pull or deliver (no
		// duplicates).
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

		// Two notifications arrive during the run (7, then 9).
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

		// #38: the run no longer defers — the first update pulled immediately,
		// the second coalesced into a single-flight refetch (cursor 6 → 9).
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(6);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(9);
		// Cursor advanced during the run (single-point advancement, A5).
		expect(runtime.saveCursor).toHaveBeenCalledWith(9);

		// Delivered via the steer channel while the run is active — no new
		// turn is triggered (the #14 group-chat-trigger mark stays untouched).
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
		const options = call[1] as { deliverAs: string };
		expect(options.deliverAs).toBe("steer");
		expect(runtime.markGroupChatTurnTriggered).not.toHaveBeenCalled();
		const message = call[0] as { details: { events: Array<{ sequence?: number }> } };
		const sequences = message.details.events.map((e) => e.sequence).sort((a, b) => (a ?? 0) - (b ?? 0));
		expect(sequences).toEqual([7, 8, 9]);

		// Settle → the tail-window pull starts past the delivered cursor (9):
		// nothing new, so no extra delivery.
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock.mock.calls[2]?.[0]).toBe(9);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		input.stop();
	});

	it("#38: member events during a run are steer-delivered, not merged at settle", async () => {
		// #38 口径 A: member events are no longer queued for the settle flush —
		// while the run is active they ride the steer channel together with the
		// pulled increment (arrival order preserved), and nothing is left for
		// the settle hook to deliver.
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

		// A member joins during the run, then a message notification arrives.
		handler(aCharacterJoined());
		handler({
			type: "group_chat_update",
			latest_sequence: 7,
			preview_messages: [],
			total_messages: 7,
		} as unknown as ServerMessage);
		await vi.advanceTimersByTimeAsync(0);

		// #38: the update pulled immediately and merged with the pending join
		// event into one steer delivery (arrival order preserved).
		expect(runtime.fetchMessagesSince).toHaveBeenCalledWith(6);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<{ type: string; sequence?: number }> } };
		expect(message.details.events.map((e) => e.type)).toEqual(["character_joined", "public_message"]);
		const options = call[1] as { deliverAs: string };
		expect(options.deliverAs).toBe("steer");
		expect(runtime.markGroupChatTurnTriggered).not.toHaveBeenCalled();

		// The join debounce fires later with nothing left to deliver.
		await vi.advanceTimersByTimeAsync(1000);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		// Settle → nothing queued, nothing extra delivered.
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		input.stop();
	});

	it("#38: run-time steer delivery advances the cursor; settle has nothing left (B6 invariant)", async () => {
		// B6 invariant preserved: the client still never advances the cursor
		// on speak. The difference is that the run-time pull now advances it
		// (single-point advancement), so 7..9 are delivered mid-run via steer
		// and the settle refetch has nothing left — nothing is skipped and
		// nothing is delivered twice.
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

		// Notification for 7..9 arrives during the run.
		handler({
			type: "group_chat_update",
			latest_sequence: 9,
			preview_messages: [],
			total_messages: 9,
		} as unknown as ServerMessage);
		await vi.advanceTimersByTimeAsync(0);

		// #38: delivered mid-run via steer; the cursor advanced to 9 during
		// the run (not deferred to settle).
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const call = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
		const message = call[0] as { details: { events: Array<{ sequence?: number }> } };
		const sequences = message.details.events.map((e) => e.sequence).sort((a, b) => (a ?? 0) - (b ?? 0));
		expect(sequences).toEqual([7, 8, 9]);
		expect(cursor).toBe(9);

		// Mid-run the character speaks and publishes at seq 10; the delivery
		// cursor stays at 9 (client-side zero advancement on speak, B6 — the
		// speak publisher never touches the delivery cursor).

		// Settle → the tail-window pull starts at 9 (already delivered): the
		// mock returns nothing new, so no re-delivery and the cursor stays.
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
		// The agreed single-point advancement: the run-time pull saves the
		// cursor on every successful delivery, so two notifications during a
		// run (7, then 9) produce two strictly-increasing, non-overlapping
		// steer batches and the settle hook has nothing left — no duplicate,
		// no gap, no re-pull of the delivered window.
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		const fetchSinceCalls: number[] = [];
		runtime.fetchMessagesSince = vi.fn(async (since: number) => {
			fetchSinceCalls.push(since);
			if (since === 6) {
				// First notification: only seq 7 exists at this point.
				return { messages: [aPublicMessage("user_persona", { sequence: 7 })], latestSequence: 7, totalMessages: 7 };
			}
			if (since === 7) {
				// Second notification: 8 and 9 have arrived since.
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

		// Two notifications during the run with a gap (7, then 9).
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

		// Cursor advanced monotonically during the run: 6 → 7 → 9. The second
		// update coalesced into the single-flight refetch loop, never re-pulling
		// the already-delivered window.
		expect(fetchSinceCalls).toEqual([6, 7]);
		expect(runtime.saveCursor).toHaveBeenCalledTimes(2);
		expect(runtime.saveCursor).toHaveBeenNthCalledWith(1, 7);
		expect(runtime.saveCursor).toHaveBeenNthCalledWith(2, 9);

		// Two steer deliveries: [7] then [8, 9] — strictly increasing,
		// non-overlapping, no gaps, no duplicates.
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

		// Settle → the tail-window pull starts at 9 (already delivered): the
		// mock returns nothing new, so no extra fetch target, no delivery.
		runtime.isAgentActive = false;
		runtime.onAgentSettled?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchSinceCalls).toEqual([6, 7, 9]);
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);

		input.stop();
	});

	it("#38 T3: steer delivery never marks a group-chat-triggered turn (#14 boundary)", async () => {
		// #14 boundary: only an idle flush that actually starts a new turn may
		// mark the group-chat trigger (agent_start consumes it to light up
		// is_streaming). A steer delivery during a run must leave the mark
		// untouched — the running turn stays the only streaming source.
		vi.useFakeTimers();

		const runtime = createMockRuntime({
			getGroupChatState: async () => ({}),
		});
		runtime.markGroupChatTurnTriggered = vi.fn();
		const pi = createMockPi();

		// Idle delivery keeps the #14 semantic: flush marks the next turn as
		// group-chat triggered and uses the followUp channel.
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

		// Active run: steer delivery must NOT mark — no agent_start will be
		// consumed, so is_streaming stays lit by the running turn only.
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

		// Two updates while the first fetch is in flight.
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
		// One coalesced refetch after the first completes.
		expect(calls).toBe(2);

		input.stop();
	});
});
