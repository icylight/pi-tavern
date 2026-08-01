import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import WebSocket from "ws";

import { type CharacterCard, loadCharacterCard } from "../config/character-card.js";
import {
	type BufferedFrame,
	type CharacterReloadHandoff,
	getReloadHandoffRegistry,
} from "../controller/reload-handoff-registry.js";
import { decodeServerMessage, encodeMessage, MAX_WEBSOCKET_FRAME_BYTES } from "../protocol/codec.js";
import type { GroupChatStateMessage, ServerMessage } from "../protocol/messages.js";
import {
	HEARTBEAT_PING_INTERVAL_MS,
	HEARTBEAT_TIMEOUT_MS,
	SHORT_COORDINATION_TIMEOUT_MS,
} from "../shared/constants.js";
import { GroupChatInput } from "./group-chat-input.js";

export interface CharacterConnectionTransfer {
	socket: WebSocket;
	bufferedMessages: ServerMessage[];
}

export interface PrepareCharacterRuntimeOptions {
	groupChatId: string;
	sessionId: string;
	character: CharacterCard;
	requestTimeoutMs?: number;
	onDisconnected?: () => void;
	/** Interval between heartbeat checks (defaults to 30s). */
	heartbeatIntervalMs?: number;
	/** Creator-ping timeout threshold (defaults to 120s); overdue → terminate. */
	heartbeatTimeoutMs?: number;
}

interface PendingRequest {
	resolve: (message: ServerMessage) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = SHORT_COORDINATION_TIMEOUT_MS;

export class CharacterRuntime {
	readonly groupChatId: string;
	readonly sessionId: string;
	readonly character: CharacterCard;
	readonly receivedMessages: ServerMessage[] = [];
	onEnvironmentMessage: ((message: ServerMessage) => void) | undefined;
	/** Latest group chat state snapshot (cached for read-only TUI projection). */
	lastGroupChatState: GroupChatStateMessage | null = null;
	/** Fired after a fresh state snapshot arrives (TUI refresh trigger). */
	onStateSnapshot: ((snapshot: GroupChatStateMessage) => void) | undefined;
	groupChatInput: GroupChatInput | undefined;

	private socket: WebSocket | null = null;
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly requestTimeoutMs: number;
	private readonly onDisconnected: (() => void) | undefined;
	private readonly heartbeatIntervalMs: number;
	private readonly heartbeatTimeoutMs: number;
	private closePromise: Promise<void> | null = null;
	private disconnected = false;
	private lastPingAt = 0;
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private lifecycle: "active" | "detaching" | "disposed" = "active";
	private bufferingHandlers: { message: (data: WebSocket.RawData) => void; close: () => void } | null = null;

	private readonly onPing = (): void => {
		this.lastPingAt = Date.now();
	};

	private readonly onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
		this.handleIncomingData(data, isBinary);
	};

	private handleIncomingData(data: WebSocket.RawData, isBinary: boolean): void {
		if (isBinary) {
			this.failConnection(new Error("Binary PiTavern frame received"));
			return;
		}
		let message: ServerMessage;
		try {
			message = decodeServerMessage(data);
		} catch (error) {
			this.failConnection(asError(error));
			return;
		}
		this.handleServerMessage(message);
	}

	private readonly onClose = (): void => {
		this.finishDisconnected(new Error("PiTavern connection closed"));
	};

	private readonly onError = (): void => undefined;

	private constructor(options: PrepareCharacterRuntimeOptions) {
		this.groupChatId = options.groupChatId;
		this.sessionId = options.sessionId;
		this.character = options.character;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.onDisconnected = options.onDisconnected;
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_PING_INTERVAL_MS;
		this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
	}

	static prepare(options: PrepareCharacterRuntimeOptions): CharacterRuntime {
		return new CharacterRuntime(options);
	}

	activate(transfer: CharacterConnectionTransfer, pi?: ExtensionAPI): void {
		if (this.socket || this.disconnected) {
			throw new Error("CharacterRuntime has already been activated or disposed");
		}
		this.socket = transfer.socket;
		this.socket.on("message", this.onMessage);
		this.socket.on("close", this.onClose);
		this.socket.on("error", this.onError);
		this.socket.on("ping", this.onPing);
		this.lastPingAt = Date.now();
		this.startHeartbeat();

		if (pi) {
			this.groupChatInput = new GroupChatInput(this, pi);
			this.groupChatInput.start();
		}

		for (const message of transfer.bufferedMessages) {
			this.handleServerMessage(message);
		}
	}

	async getGroupChatState(): Promise<GroupChatStateMessage> {
		const response = await this.request({ type: "get_group_chat_state" });
		if (response.type !== "response" || response.command !== "get_group_chat_state") {
			throw new Error("Unexpected PiTavern state response");
		}
		if (!response.success) {
			throw new Error(response.error);
		}
		this.lastGroupChatState = response.data;
		this.onStateSnapshot?.(response.data);
		return response.data;
	}

	updateStreaming(isStreaming: boolean): void {
		this.send({
			type: "update_character_state",
			is_streaming: isStreaming,
		});
	}

	async speak(content: string): Promise<{
		published: boolean;
		eventId?: string;
		sequence?: number;
		reason?: string;
		handRaised?: boolean;
		round?: { roundMaxMessages: number; usedMessages: number; remainingMessages: number };
	}> {
		const response = await this.request({ type: "speak", content });
		if (response.type !== "response" || response.command !== "speak") {
			throw new Error("Unexpected PiTavern speak response");
		}
		if (!response.success) {
			throw new Error(response.error);
		}
		return {
			published: response.data.published,
			...(response.data.published
				? {
						eventId: response.data.event_id,
						sequence: response.data.sequence,
					}
				: {
						reason: response.data.reason,
						handRaised: response.data.hand_raised,
					}),
			round: {
				roundMaxMessages: response.data.round.round_max_messages,
				usedMessages: response.data.round.used_messages,
				remainingMessages: response.data.round.remaining_messages,
			},
		};
	}

	/**
	 * Detach the runtime for a reload: stop the input pipeline and heartbeat,
	 * buffer reload-window frames on the live socket, and publish a one-shot
	 * handoff. The connection, Character identity, un-flushed environment
	 * events, and the debounce deadline are preserved for the new runtime.
	 */
	async detachForReload(piSessionId: string): Promise<CharacterReloadHandoff> {
		if (this.lifecycle !== "active" || !this.socket || this.disconnected) {
			throw new Error("CharacterRuntime is not active");
		}
		this.lifecycle = "detaching";
		this.stopHeartbeat();
		const snapshot = this.groupChatInput?.snapshotForReload() ?? { pendingEvents: [], debounceDueAt: null };
		this.groupChatInput?.stop();
		this.groupChatInput = undefined;

		const socket = this.socket;
		const bufferedFrames: BufferedFrame[] = [];
		let socketClosed = false;
		const handlers = {
			message: (data: WebSocket.RawData) => {
				bufferedFrames.push({ receivedAt: Date.now(), data });
			},
			close: () => {
				socketClosed = true;
			},
		};
		this.bufferingHandlers = handlers;
		socket.off("message", this.onMessage);
		socket.off("close", this.onClose);
		socket.off("error", this.onError);
		socket.off("ping", this.onPing);
		socket.on("message", handlers.message);
		socket.on("close", handlers.close);

		const handoff: CharacterReloadHandoff = {
			kind: "character",
			piSessionId,
			expiresAt: Date.now() + this.requestTimeoutMs,
			groupChatId: this.groupChatId,
			socket,
			character: this.character,
			pendingEvents: snapshot.pendingEvents,
			debounceDueAt: snapshot.debounceDueAt,
			lastPingAt: this.lastPingAt,
			bufferedFrames,
			bufferingHandlers: handlers,
			socketClosed,
			cleanup: async () => {
				if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
					socket.close();
				}
			},
		};
		this.socket = null;
		getReloadHandoffRegistry().publish(handoff);
		return handoff;
	}

	/**
	 * Take over a character handoff: re-attach the live socket with fresh
	 * handlers, restore heartbeat tracking and the environment input pipeline
	 * (with its pending events and debounce deadline), then replay buffered
	 * frames in received order. A member that disconnected during the reload
	 * window is routed into the normal disconnected cleanup instead.
	 *
	 * ISSUE-005: the character card is re-read from disk on reload so a card
	 * edit while joined (e.g. the three-way 0.5 collaboration merge) is
	 * reflected in the injected persona after reload. If re-reading fails the
	 * previous card is kept and the warning is surfaced via the optional
	 * notify callback — the reload proceeds, never crashing the session.
	 */
	static async takeHandoff(
		handoff: CharacterReloadHandoff,
		pi?: ExtensionAPI,
		notify?: (message: string) => void,
	): Promise<CharacterRuntime> {
		if (handoff.socketClosed) {
			void handoff.cleanup();
			throw new Error("Character connection closed during reload");
		}
		let character = handoff.character;
		try {
			character = await loadCharacterCard(
				handoff.character.path,
				resolve(dirname(handoff.character.path), "tavern.json"),
			);
			// Keep the registered identity anchor: the card may have been edited
			// while joined, but the character_id is the join-time registration.
			// (Same pattern as loadClaimedCharacter.)
			character = { ...character, characterId: handoff.character.characterId };
		} catch (error) {
			// Keep the previous card; surface the failure so the user knows the
			// persona may be stale. The connection stays up either way.
			notify?.(
				`reload: failed to re-read character card ${handoff.character.path}, keeping the previous one: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const runtime = new CharacterRuntime({
			groupChatId: handoff.groupChatId,
			sessionId: handoff.piSessionId,
			character,
		});
		runtime.activateFromHandoff(handoff, pi);
		return runtime;
	}

	private activateFromHandoff(handoff: CharacterReloadHandoff, pi?: ExtensionAPI): void {
		if (this.socket || this.disconnected) {
			throw new Error("CharacterRuntime has already been activated or disposed");
		}
		const socket = handoff.socket;
		socket.off("message", handoff.bufferingHandlers.message);
		socket.off("close", handoff.bufferingHandlers.close);
		this.socket = socket;
		this.lastPingAt = handoff.lastPingAt;
		socket.on("message", this.onMessage);
		socket.on("close", this.onClose);
		socket.on("error", this.onError);
		socket.on("ping", this.onPing);
		this.startHeartbeat();

		if (pi) {
			this.groupChatInput = new GroupChatInput(this, pi);
			this.groupChatInput.start();
			this.groupChatInput.restoreFromReload({
				pendingEvents: handoff.pendingEvents,
				debounceDueAt: handoff.debounceDueAt,
			});
		}

		for (const frame of [...handoff.bufferedFrames].sort((a, b) => a.receivedAt - b.receivedAt)) {
			this.handleIncomingData(frame.data, false);
		}
	}

	get hasPublicMessages(): boolean {
		return this.receivedMessages.some((m) => {
			if (m.type === "public_message") return true;
			if (m.type === "message_history" && Array.isArray(m.messages) && m.messages.length > 0) {
				return true;
			}
			return false;
		});
	}

	close(): Promise<void> {
		this.closePromise ??= this.closePermanently();
		return this.closePromise;
	}

	private async closePermanently(): Promise<void> {
		if (this.lifecycle === "detaching") {
			// close() and detachForReload() are mutually exclusive paths.
			throw new Error("CharacterRuntime has been detached for reload and cannot be closed");
		}
		this.lifecycle = "disposed";
		if (!this.socket || this.disconnected) {
			this.finishDisconnected();
			return;
		}
		try {
			const response = await this.request({ type: "leave_group_chat" });
			if (response.type !== "response" || response.command !== "leave_group_chat" || !response.success) {
				throw new Error(
					response.type === "response" && !response.success ? response.error : "Unexpected PiTavern leave response",
				);
			}
		} finally {
			this.finishDisconnected();
		}
	}

	private request(message: Record<string, unknown>): Promise<ServerMessage> {
		const id = randomUUID();
		return new Promise<ServerMessage>((resolveRequest, rejectRequest) => {
			if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
				rejectRequest(new Error("PiTavern connection is not open"));
				return;
			}
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				const error = new Error("PiTavern request timed out");
				rejectRequest(error);
				this.failConnection(error);
			}, this.requestTimeoutMs);
			this.pendingRequests.set(id, {
				resolve: resolveRequest,
				reject: rejectRequest,
				timer,
			});
			this.send({ ...message, id });
		});
	}

	private send(message: unknown): void {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			throw new Error("PiTavern connection is not open");
		}
		const encoded = encodeMessage(message);
		if (Buffer.byteLength(encoded, "utf8") > MAX_WEBSOCKET_FRAME_BYTES) {
			throw new Error("PiTavern frame exceeds 1 MiB");
		}
		this.socket.send(encoded);
	}

	private handleServerMessage(message: ServerMessage): void {
		if (message.type === "response" && message.id !== undefined) {
			const pending = this.pendingRequests.get(message.id);
			if (pending) {
				clearTimeout(pending.timer);
				this.pendingRequests.delete(message.id);
				pending.resolve(message);
				return;
			}
		}

		this.receivedMessages.push(message);

		this.onEnvironmentMessage?.(message);

		if (message.type === "group_chat_closed") {
			this.finishDisconnected();
		}
	}

	private startHeartbeat(): void {
		if (this.heartbeatTimer) {
			return;
		}
		this.heartbeatTimer = setInterval(() => {
			if (Date.now() - this.lastPingAt > this.heartbeatTimeoutMs) {
				// No creator ping for the timeout window: the connection is half-open.
				this.failConnection(new Error("PiTavern heartbeat timeout"));
			}
		}, this.heartbeatIntervalMs);
		this.heartbeatTimer.unref?.();
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private failConnection(error: Error): void {
		const socket = this.socket;
		if (socket && socket.readyState !== WebSocket.CLOSED) {
			socket.terminate();
		}
		this.finishDisconnected(error);
	}

	private finishDisconnected(error?: Error): void {
		if (this.disconnected) {
			return;
		}
		this.disconnected = true;
		this.stopHeartbeat();
		this.groupChatInput?.stop();
		this.groupChatInput = undefined;
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			socket.off("message", this.onMessage);
			socket.off("close", this.onClose);
			socket.off("error", this.onError);
			socket.off("ping", this.onPing);
			if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
				socket.close();
			}
		}
		const disconnectError = error ?? new Error("PiTavern connection has been closed");
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(disconnectError);
		}
		this.pendingRequests.clear();
		this.onDisconnected?.();
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
