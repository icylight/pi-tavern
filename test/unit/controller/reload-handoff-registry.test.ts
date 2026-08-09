import { describe, expect, it, vi } from "vitest";

import type { CharacterCard } from "../../../src/config/character-card.js";
import {
	type CharacterReloadHandoff,
	type CreatorReloadHandoff,
	getReloadHandoffRegistry,
} from "../../../src/controller/reload-handoff-registry.js";
import type { ActiveGroupChatDescriptor } from "../../../src/data/discovery/active-descriptor.js";
import { createGroupChatState } from "../../../src/data/group-chat-state.js";

const descriptor: ActiveGroupChatDescriptor = {
	instanceId: "instance-1",
	groupChatId: "group-1",
	name: null,
	cwd: "/project",
	pid: 1234,
	host: "127.0.0.1",
	port: 54321,
	startedAt: "2026-07-27T00:00:00.000Z",
};

function creatorHandoff(piSessionId: string, expiresAt: number, cleanup: () => Promise<void>): CreatorReloadHandoff {
	return {
		kind: "creator",
		piSessionId,
		expiresAt,
		webSocketServer: undefined as never,
		groupSessionManager: undefined as never,
		groupChatState: createGroupChatState({
			groupChatId: "group-1",
			createdAt: "2026-07-27T00:00:00.000Z",
			groupMaxMessages: 10,
		}),
		boardStore: undefined as never,
		connections: new Map(),
		heartbeatStates: new Map(),
		activeDescriptor: descriptor,
		activeDescriptorPath: "/agent/chats/group-1.jsonl",
		configMaxMessages: 10,
		// #123：欢迎文案（配置快照随 handoff 传递）。
		welcomeMessage: "welcome-default",
		// #154：群聊文案模板集（配置快照随 handoff 传递）。
		messageTemplates: {
			public_message: "{sender}:\\n{content}",
			whisper_full: "{sender} 向 {receiver} 悄悄说：{content}",
			whisper_placeholder: "{sender} 向 {receiver} 悄悄说了一句话",
			seconds_ago: "{count} 秒前",
			minutes_ago: "{count} 分钟前",
		},
		characters: [],
		publicMessages: [],
		persistedCount: 0,
		bufferedFrames: new Map(),
		bufferingHandlers: new Map(),
		closedSessionIds: new Set(),
		cleanup,
	};
}

function characterHandoff(
	piSessionId: string,
	expiresAt: number,
	cleanup: () => Promise<void>,
): CharacterReloadHandoff {
	return {
		kind: "character",
		piSessionId,
		expiresAt,
		groupChatId: "group-1",
		socket: undefined as never,
		character: {} as CharacterCard,
		pendingEvents: [],
		debounceDueAt: null,
		idleWindowDueAt: null,
		idleWindowAbortEligible: false,
		incrementPending: false,
		lastPingAt: 0,
		bufferedFrames: [],
		bufferingHandlers: { message: () => undefined, close: () => undefined },
		socketClosed: false,
		cleanup,
	};
}

describe("ReloadHandoffRegistry", () => {
	it("takes a handoff exactly once and only for the matching pi session", () => {
		const registry = getReloadHandoffRegistry();
		const cleanup = vi.fn(async () => undefined);
		registry.publish(creatorHandoff("pi-session-1", Date.now() + 60_000, cleanup));

		// 其他 pi session 无法接管。
		expect(registry.take("pi-session-other")).toBeNull();

		// 合法属主只接管一次……
		const taken = registry.take("pi-session-1");
		expect(taken?.kind).toBe("creator");

		// …and a second take returns nothing.
		expect(registry.take("pi-session-1")).toBeNull();
		expect(cleanup).not.toHaveBeenCalled();
	});

	it("expires an untaken handoff and runs its cleanup exactly once", async () => {
		const registry = getReloadHandoffRegistry();
		const cleanup = vi.fn(async () => undefined);
		registry.publish(characterHandoff("pi-session-2", Date.now() + 40, cleanup));

		await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
		expect(registry.take("pi-session-2")).toBeNull();
	});
});
