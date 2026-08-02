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
import { legacyCursorPathFor, readCursorFile, writeCursorFile } from "../data/cursor-store.js";
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
	/**
	 * M7 (ISSUE-012/#24): absolute path of the per-group-chat cursor file
	 * ("last successfully delivered message sequence"), persisted across
	 * restarts. Omitted → incremental pulls are disabled (history-only mode).
	 */
	cursorStorePath?: string;
}

interface PendingRequest {
	resolve: (message: ServerMessage) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = SHORT_COORDINATION_TIMEOUT_MS;

/**
 * ISSUE-013 B5: maximum automatic stale-recovery pulls per round. Beyond
 * this budget the speak tool reports the refusal without auto-pulling, so a
 * message flood cannot loop the agent between reject and re-publish.
 */
const MAX_STALE_AUTO_RECOVERIES = 2;

export class CharacterRuntime {
	readonly groupChatId: string;
	readonly sessionId: string;
	readonly character: CharacterCard;
	readonly receivedMessages: ServerMessage[] = [];
	onEnvironmentMessage: ((message: ServerMessage) => void) | undefined;
	/** Latest group chat state snapshot (cached for read-only TUI projection). */
	lastGroupChatState: GroupChatStateMessage | null = null;
	/**
	 * ISSUE-014/#14: true when the most recent delivery into the pi Agent was
	 * group-chat triggered (GroupChatInput.flush). agent_start consumes this
	 * to decide whether to light up is_streaming — user-direct turns must
	 * NOT light it (semantic convergence, #14-A1/A2).
	 */
	groupChatTurnTriggered = false;
	/**
	 * ISSUE-014/#14: agent_end watchdog — resets is_streaming if
	 * agent_settled never arrives (aborted/errored runs must not hang the
	 * "正在发言" display). Cleared by agent_settled; reload re-arms via
	 * activateFromHandoff's explicit false re-send.
	 */
	private streamingResetWatchdog: NodeJS.Timeout | null = null;
	/** Fired after a fresh state snapshot arrives (TUI refresh trigger). */
	onStateSnapshot: ((snapshot: GroupChatStateMessage) => void) | undefined;
	/**
	 * M7 (ISSUE-012/#24): true while the pi Agent is mid-run (agent_start
	 * fired, agent_settled not yet). GroupChatInput queues the increment
	 * while active and flushes as soon as the run settles, so a pull never
	 * interrupts the current run.
	 */
	isAgentActive = false;
	/** Fired when the Agent run settles (agent_settled), so queued input can flush. */
	onAgentSettled: (() => void) | undefined;
	groupChatInput: GroupChatInput | undefined;

	private socket: WebSocket | null = null;
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly requestTimeoutMs: number;
	private readonly onDisconnected: (() => void) | undefined;
	private readonly heartbeatIntervalMs: number;
	private readonly heartbeatTimeoutMs: number;
	private readonly cursorStorePath: string | undefined;
	private cursorSequence: number | null = null;

	/**
	 * ISSUE-013 B5: per-round stale auto-recovery budget. Tracked against the
	 * round snapshot returned with each speak response; the key changes when
	 * the round does (new round or others publishing), which resets the
	 * budget. Beyond the budget the client stops flagging the A2 injection
	 * and reports the refusal for manual re-decision.
	 */
	private staleRecoveryKey: string | null = null;
	private staleRecoveryCount = 0;
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
		this.cursorStorePath = options.cursorStorePath;
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

	/**
	 * Mark that the next agent run is group-chat triggered (called right
	 * before GroupChatInput flushes a delivery into the pi Agent).
	 */
	markGroupChatTurnTriggered(): void {
		this.groupChatTurnTriggered = true;
	}

	/** Read and clear the group-chat-triggered flag (called on agent_start). */
	consumeGroupChatTurnTriggered(): boolean {
		const triggered = this.groupChatTurnTriggered;
		this.groupChatTurnTriggered = false;
		return triggered;
	}

	/**
	 * ISSUE-014/#14 watchdog: after agent_end, force is_streaming back to
	 * false if agent_settled does not arrive within the window. Node timers
	 * do not depend on agent state, so a wedged run still resets.
	 */
	armStreamingResetWatchdog(delayMs = 5_000): void {
		this.clearStreamingResetWatchdog();
		this.streamingResetWatchdog = setTimeout(() => {
			this.streamingResetWatchdog = null;
			this.updateStreaming(false);
		}, delayMs);
	}

	clearStreamingResetWatchdog(): void {
		if (this.streamingResetWatchdog !== null) {
			clearTimeout(this.streamingResetWatchdog);
			this.streamingResetWatchdog = null;
		}
	}

	/**
	 * ISSUE-014/#14 / #21: refresh the cached group chat state snapshot.
	 * Keeps the TUI widget current even when no new messages arrive (member
	 * changes, streaming flips, hand-raises). Failures are display-only.
	 */
	async refreshGroupChatState(): Promise<void> {
		try {
			await this.getGroupChatState();
		} catch {
			// Display-only refresh; never affects protocol or membership.
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

	/**
	 * Fetch one page of group chat history from the creator, ordered newest
	 * first. The cursor (opaque server-provided sequence boundary) advances
	 * towards older messages; pass the cursor from a message_history event or
	 * a previous page response to page further back. Returns null when the
	 * server rejects the request (e.g. connection dropped mid-window).
	 * ISSUE-008: the join-time message_history only carries the 10 most
	 * recent messages; this is how the client walks the remaining history.
	 */
	async fetchMessageHistoryPage(cursor: string | null): Promise<{
		messages: ServerMessage[];
		cursor: string | null;
		hasMore: boolean;
		totalMessages: number;
	} | null> {
		let response: ServerMessage;
		try {
			response = await this.request({
				type: "get_message_history",
				...(cursor !== null ? { cursor } : {}),
			});
		} catch (error) {
			// The connection may have dropped while paging; the caller keeps
			// whatever history it already has rather than failing the turn.
			if (this.disconnected) {
				return null;
			}
			throw error;
		}
		if (response.type !== "response" || response.command !== "get_message_history") {
			throw new Error("Unexpected PiTavern history response");
		}
		if (!response.success) {
			throw new Error(response.error);
		}
		const data = response.data as {
			messages: ServerMessage[];
			cursor: string | null;
			has_more: boolean;
			total_messages: number;
		};
		return {
			messages: data.messages,
			cursor: data.cursor,
			hasMore: data.has_more,
			totalMessages: data.total_messages,
		};
	}

	/**
	 * M7 (ISSUE-012/#24): pull every message with sequence > since from the
	 * creator. The server filters by sequence, so a missed notification
	 * (gap) is healed by the next pull. Returns null if the connection
	 * dropped mid-request.
	 */
	async fetchMessagesSince(sinceSequence: number): Promise<{
		messages: ServerMessage[];
		latestSequence: number;
		totalMessages: number;
	} | null> {
		let response: ServerMessage;
		try {
			response = await this.request({
				type: "fetch_messages_since",
				since_sequence: sinceSequence,
			});
		} catch (error) {
			if (this.disconnected) {
				return null;
			}
			throw error;
		}
		if (response.type !== "response" || response.command !== "fetch_messages_since") {
			throw new Error("Unexpected PiTavern fetch_messages_since response");
		}
		if (!response.success) {
			throw new Error(response.error);
		}
		const data = response.data as {
			messages: ServerMessage[];
			latest_sequence: number;
			total_messages: number;
		};
		return {
			messages: data.messages,
			latestSequence: data.latest_sequence,
			totalMessages: data.total_messages,
		};
	}

	updateStreaming(isStreaming: boolean): void {
		this.send({
			type: "update_character_state",
			is_streaming: isStreaming,
		});
	}

	/**
	 * M7: load the persisted cursor (last successfully delivered message
	 * sequence) for this group chat. Returns null when no cursor exists yet
	 * (first join) or the store is unavailable — the caller then falls back
	 * to the full-history paging path.
	 */
	loadCursor(): number | null {
		if (!this.cursorStorePath) {
			return null;
		}
		if (this.cursorSequence !== null) {
			return this.cursorSequence;
		}
		// 游标跟随 Session：优先读本 Session 文件；v1 群聊级单文件作兼容回退
		// （保守起点：最多重复拉取、绝不跳过消息；只读旧文件不迁移，防多进程竞态）。
		// 本文件损坏（null 非抛）同样落旧文件回退——旧文件冻结于修复前且 ≤ 本文件
		// 创建时位置，采纳旧值仍保守。
		let sequence: number | null = null;
		try {
			sequence = readCursorFile(this.cursorStorePath);
		} catch {
			// 本 Session 文件不存在（ENOENT/EISDIR 等）——尝试旧格式
		}
		if (sequence === null) {
			try {
				sequence = readCursorFile(legacyCursorPathFor(this.cursorStorePath));
			} catch {
				// 旧格式也不存在——无游标
			}
		}
		if (sequence !== null) {
			this.cursorSequence = sequence;
		}
		return this.cursorSequence;
	}

	/**
	 * M7: persist the cursor after a successful delivery. Writing is atomic
	 * (tmp file + rename) so a crash mid-write never corrupts the cursor;
	 * delivery failures must NOT advance the cursor (retry semantics).
	 */
	saveCursor(sequence: number): void {
		if (!this.cursorStorePath) {
			return;
		}
		// 内存先推进（保持：写失败时同进程 loadCursor 仍回读新值——QA 场景 7 钉）
		this.cursorSequence = sequence;
		try {
			writeCursorFile(this.cursorStorePath, sequence);
		} catch {
			// Persistence is best-effort: losing a cursor write only means the
			// next join re-pulls from an older position (idempotent by sequence).
		}
	}

	async speak(content: string): Promise<{
		published: boolean;
		eventId?: string;
		sequence?: number;
		reason?: string;
		handRaised?: boolean;
		missingFrom?: number;
		missingTo?: number;
		autoRecover?: boolean;
		round?: { roundMaxMessages: number; usedMessages: number; remainingMessages: number };
	}> {
		// ISSUE-013 B1: the client always carries its delivery cursor (the
		// last successfully delivered sequence — A5: advanced only by the
		// delivery path). The client never advances it on its own; the server
		// excludes the requester's own messages from the staleness check (B6),
		// so the cursor sitting before one's own published message never
		// causes a false rejection. Legacy servers ignore the field.
		const basedOnSequence = this.loadCursor() ?? 0;
		const response = await this.request({ type: "speak", content, based_on_sequence: basedOnSequence });
		if (response.type !== "response" || response.command !== "speak") {
			throw new Error("Unexpected PiTavern speak response");
		}
		if (!response.success) {
			throw new Error(response.error);
		}
		const round = {
			roundMaxMessages: response.data.round.round_max_messages,
			usedMessages: response.data.round.used_messages,
			remainingMessages: response.data.round.remaining_messages,
		};
		if (response.data.published) {
			this.staleRecoveryKey = null;
			this.staleRecoveryCount = 0;
			return {
				published: true,
				eventId: response.data.event_id,
				sequence: response.data.sequence,
				round,
			};
		}
		if (response.data.reason === "stale") {
			const key = `${round.roundMaxMessages}:${round.usedMessages}`;
			if (this.staleRecoveryKey !== key) {
				this.staleRecoveryKey = key;
				this.staleRecoveryCount = 0;
			}
			this.staleRecoveryCount += 1;
			return {
				published: false,
				reason: "stale",
				missingFrom: response.data.missing_sequences.from,
				missingTo: response.data.missing_sequences.to,
				autoRecover: this.staleRecoveryCount <= MAX_STALE_AUTO_RECOVERIES,
				round,
			};
		}
		return {
			published: false,
			reason: "round_limit_reached",
			handRaised: response.data.hand_raised,
			round,
		};
	}

	/**
	 * ISSUE-013 B3: flag the A2 "increment pending" mark so the settle hook
	 * pulls the missed increment through the unified delivery pipeline.
	 * Called by the speak tool when a stale refusal needs auto-recovery; the
	 * tool itself returns only a short notice (no message text — the full
	 * increment arrives in the next turn via the normal group chat input).
	 */
	markIncrementPending(): void {
		this.groupChatInput?.markIncrementPending();
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
			...(this.cursorStorePath !== undefined ? { cursorStorePath: this.cursorStorePath } : {}),
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
			...(handoff.cursorStorePath !== undefined ? { cursorStorePath: handoff.cursorStorePath } : {}),
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

		// ISSUE-014/#14 reload corner: the old runtime's streaming watchdog
		// timer dies with the old Extension Runtime. If the previous agent
		// run was interrupted mid-flight (streaming stuck true), explicitly
		// reset — the run is dead, the display must not stay hung. This is
		// the only deterministic coverage of the reload path (M5 handoff).
		this.updateStreaming(false);
	}

	get hasPublicMessages(): boolean {
		return this.receivedMessages.some((m) => {
			if (m.type === "public_message") return true;
			if (m.type === "message_history" && Array.isArray(m.messages) && m.messages.length > 0) {
				return true;
			}
			if (m.type === "group_chat_update" && Array.isArray(m.preview_messages) && m.preview_messages.length > 0) {
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
		this.clearStreamingResetWatchdog();
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
