import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CharacterRuntime } from "../../src/character/character-runtime.js";
import { GroupChatInput } from "../../src/character/group-chat-input.js";
import type { PublicMessage, ServerMessage } from "../../src/protocol/messages.js";

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
		expect(message.content).toContain("你是：Developer（dev）");

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
});
