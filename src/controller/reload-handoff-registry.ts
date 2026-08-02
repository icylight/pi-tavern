import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type WebSocket from "ws";
import type { WebSocketServer } from "ws";

import type { CharacterCard } from "../config/character-card.js";
import type { GroupChatState } from "../creator/group-chat-state.js";
import type { ActiveGroupChatDescriptor } from "../data/discovery/active-descriptor.js";
import type { ServerMessage } from "../protocol/messages.js";
import type { PublicMessageState } from "../protocol/public-message-state.js";

/** Private globalThis key so reloaded extension code can find the slot. */
export const RELOAD_HANDOFF_SYMBOL: unique symbol = Symbol.for("pi-tavern.reload-handoff");

export interface BufferedFrame {
	receivedAt: number;
	data: WebSocket.RawData;
}

interface HeartbeatStateSnapshot {
	lastPongAt: number;
}

/**
 * Resources moved from the old Extension Runtime to the reloaded one.
 * One-shot: take() succeeds exactly once; on 5s expiry the handoff's own
 * cleanup releases everything.
 */
export interface CreatorReloadHandoff {
	kind: "creator";
	piSessionId: string;
	expiresAt: number;

	webSocketServer: WebSocketServer;
	groupSessionManager: SessionManager;
	groupChatState: GroupChatState;
	connections: Map<string, WebSocket>;
	heartbeatStates: Map<string, HeartbeatStateSnapshot>;
	activeDescriptor: ActiveGroupChatDescriptor;
	activeDescriptorPath: string;
	configMaxMessages: number;
	characters: CharacterCard[];
	publicMessages: PublicMessageState[];
	persistedCount: number;

	bufferedFrames: Map<string, BufferedFrame[]>;
	bufferingHandlers: Map<string, { message: (data: WebSocket.RawData) => void; close: () => void }>;
	closedSessionIds: Set<string>;

	/** Releases the server, member sockets, and the active descriptor. */
	cleanup: () => Promise<void>;
}

export interface CharacterReloadHandoff {
	kind: "character";
	piSessionId: string;
	expiresAt: number;

	groupChatId: string;
	socket: WebSocket;
	character: CharacterCard;
	/** M7 (ISSUE-012/#24): cursor file path, carried across reloads. */
	cursorStorePath?: string;
	pendingEvents: ServerMessage[];
	debounceDueAt: number | null;
	lastPingAt: number;

	bufferedFrames: BufferedFrame[];
	bufferingHandlers: { message: (data: WebSocket.RawData) => void; close: () => void };
	socketClosed: boolean;

	/** Closes the socket and drops un-flushed pending events. */
	cleanup: () => Promise<void>;
}

export type ReloadHandoff = CreatorReloadHandoff | CharacterReloadHandoff;

class ReloadHandoffRegistry {
	private handoff: ReloadHandoff | null = null;
	private expireTimer: NodeJS.Timeout | null = null;

	/** Publish a handoff; a previously untaken handoff is expired first. */
	publish(handoff: ReloadHandoff): void {
		this.clearExpireTimer();
		const previous = this.handoff;
		this.handoff = handoff;
		if (previous) {
			void previous.cleanup();
		}
		const delay = Math.max(0, handoff.expiresAt - Date.now());
		this.expireTimer = setTimeout(() => this.expire(), delay);
		this.expireTimer.unref?.();
	}

	/**
	 * Take the handoff. Only the same pi session may take it; a mismatched
	 * session returns null and leaves the slot for the rightful owner.
	 */
	take(piSessionId: string): ReloadHandoff | null {
		const handoff = this.handoff;
		if (!handoff || handoff.piSessionId !== piSessionId) {
			return null;
		}
		this.clearExpireTimer();
		this.handoff = null;
		return handoff;
	}

	/** Expire the current handoff if one is still held (used by tests too). */
	expireNow(): Promise<void> {
		this.clearExpireTimer();
		const handoff = this.handoff;
		this.handoff = null;
		if (handoff) {
			return handoff.cleanup();
		}
		return Promise.resolve();
	}

	private expire(): void {
		this.expireTimer = null;
		const handoff = this.handoff;
		this.handoff = null;
		if (handoff) {
			void handoff.cleanup();
		}
	}

	private clearExpireTimer(): void {
		if (this.expireTimer) {
			clearTimeout(this.expireTimer);
			this.expireTimer = null;
		}
	}
}

/**
 * Process-wide registry keyed by Symbol.for so the reloaded extension code
 * (a fresh module instance) finds the slot published by the old runtime.
 */
export function getReloadHandoffRegistry(): ReloadHandoffRegistry {
	const holder = globalThis as Record<symbol, ReloadHandoffRegistry | undefined>;
	const existing = holder[RELOAD_HANDOFF_SYMBOL];
	if (existing) {
		return existing;
	}
	const registry = new ReloadHandoffRegistry();
	holder[RELOAD_HANDOFF_SYMBOL] = registry;
	return registry;
}
