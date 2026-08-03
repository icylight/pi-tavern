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
import { readCursorFile, writeCursorFile } from "../data/cursor-store.js";
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
	/**
	 * #66: run wedged watchdog 超时（agent_start 布防、agent_settled 清除；
	 * 超时 → 强制 settle，恢复增量投递）。默认 180s（3min，产品参数 PM 定值）；
	 * 测试可注入短值（QA 红钉 1/2 窗口用）。
	 */
	agentWedgedTimeoutMs?: number;
	/** 闲态触发窗口（Arch 提速项，注入化；undefined = 默认 1000ms）。 */
	triggerDebounceMs?: number;
}

interface PendingRequest {
	resolve: (message: ServerMessage) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = SHORT_COORDINATION_TIMEOUT_MS;

/** #66 产品参数（PM/User 定值 2026-08-02）：run wedged 判定阈值，默认 3 分钟。 */
const DEFAULT_AGENT_WEDGED_TIMEOUT_MS = 180_000;

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
	 * ISSUE-014/#14: agent_end watchdog — resets is_streaming if
	 * agent_settled never arrives (aborted/errored runs must not hang the
	 * "正在发言" display). Cleared by agent_settled; reload re-arms via
	 * activateFromHandoff's explicit false re-send.
	 */
	private streamingResetWatchdog: NodeJS.Timeout | null = null;
	/**
	 * #66: run wedged watchdog——agent_start 布防、agent_settled 清除。覆盖双
	 * wedged 窗口（Arch 2026-08-02）：① agent_start 后无 agent_end（完全卡死）
	 * ② agent_end 已到但 agent_settled 永不到（#14 只复位 is_streaming，不碰
	 * isAgentActive——② 为真洞）。v2 = #14 超集；超时 → 强制 settle（同路径
	 * 幂等：isAgentActive=false + 冲刷排队增量，incrementPending 防重入）。
	 */
	private runWedgedWatchdog: NodeJS.Timeout | null = null;
	private readonly agentWedgedTimeoutMs: number;
	/** 闲态触发窗口（Arch 提速项，注入化；undefined = 默认 1000ms）。 */
	private readonly triggerDebounceMs: number | undefined;
	/** Fired after a fresh state snapshot arrives (TUI refresh trigger). */
	onStateSnapshot: ((snapshot: GroupChatStateMessage) => void) | undefined;
	/**
	 * M7 (ISSUE-012/#24): true while the pi Agent is mid-run (agent_start
	 * fired, agent_settled not yet). GroupChatInput queues the increment
	 * while active and flushes as soon as the run settles, so a pull never
	 * interrupts the current run.
	 */
	isAgentActive = false;
	/**
	 * Fired when the Agent run settles (agent_settled), so queued input can flush.
	 * #66：wedged 强制收敛后（wedgedSettled=true）getter 返回 undefined——迟到的
	 * 真实 settle 经 onAgentSettled?.() 路径幂等跳过，不重复冲刷。
	 */
	private _onAgentSettled: (() => void) | undefined;
	get onAgentSettled(): (() => void) | undefined {
		if (this.wedgedSettled) {
			return undefined;
		}
		return this._onAgentSettled;
	}
	set onAgentSettled(callback: (() => void) | undefined) {
		this._onAgentSettled = callback;
	}
	/** #66：run wedged 强制收敛已执行标记（下一 run agent_start 时重置）。 */
	private wedgedSettled = false;
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
		this.agentWedgedTimeoutMs = options.agentWedgedTimeoutMs ?? DEFAULT_AGENT_WEDGED_TIMEOUT_MS;
		this.triggerDebounceMs = options.triggerDebounceMs;
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
			this.groupChatInput = new GroupChatInput(this, pi, this.triggerDebounceMs);
			this.groupChatInput.start();
		}

		for (const message of transfer.bufferedMessages) {
			this.handleServerMessage(message);
		}
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
	 * #66：agent_start 时布防 run wedged watchdog。agent_settled 正常到达由
	 * clearRunWedgedWatchdog 清除（happy path 零触发）；超时触发强制 settle——
	 * 与正常 settle 同路径幂等（isAgentActive 先判、触发自清、onAgentSettled
	 * 内部 incrementPending 防重入）。覆盖双窗口（① 无 agent_end ② #14 不碰
	 * isAgentActive），v2 = #14 超集。
	 */
	armRunWedgedWatchdog(delayMs?: number): void {
		this.clearRunWedgedWatchdog();
		this.wedgedSettled = false;
		this.runWedgedWatchdog = setTimeout(() => {
			this.runWedgedWatchdog = null;
			if (!this.isAgentActive) {
				return;
			}
			// 强制收敛 = agent_settled 处理路径：解除忙态、冲刷排队增量（游标
			// 差量拉全，不丢不重）；pi 原生 followUp 队列串行，无 run 重叠。
			this.wedgedSettled = true;
			this.isAgentActive = false;
			this.clearStreamingResetWatchdog();
			this.updateStreaming(false);
			this._onAgentSettled?.();
		}, delayMs ?? this.agentWedgedTimeoutMs);
	}

	clearRunWedgedWatchdog(): void {
		if (this.runWedgedWatchdog !== null) {
			clearTimeout(this.runWedgedWatchdog);
			this.runWedgedWatchdog = null;
		}
	}

	/**
	 * #66：agent_settled 统一处理（agent-lifecycle 接线）。与强制收敛幂等合并——
	 * wedged 已触发时迟到 settle 只复位显示，不重复冲刷；happy path 正常冲刷。
	 */
	settleRun(): void {
		this.isAgentActive = false;
		this.clearStreamingResetWatchdog();
		this.clearRunWedgedWatchdog();
		this.updateStreaming(false);
		if (this.wedgedSettled) {
			return;
		}
		this._onAgentSettled?.();
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
		// #77 候选①：守卫可观测化 + 自愈——状态拉取成功说明连接健康；若
		// run 仍活跃而此前的点亮上报因半开连接丢失（online 守卫静默丢弃），
		// 在此补偿重发（幂等，creator 重复置 true 无副作用）。
		if (this.isAgentActive) {
			this.updateStreaming(true);
		}
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

	/**
	 * 展示态上报，尽力而为（同 refreshGroupChatState 的 display-only 语义）：
	 * 连接已关闭/未建立时静默跳过，绝不 throw。调用面全是 fire-and-forget——
	 * agent_settled→settleRun（agent-lifecycle 接线）与两个 watchdog 定时器在
	 * 连接先断（pi 退出竞态/心跳超时）后仍可能触发，此处 throw 会把异常炸进
	 * ExtensionRunner.emit（settle 路径）或成为 uncaughtException 杀死整个 pi
	 * 进程（定时器路径，见线上两例崩溃堆栈）。展示状态随连接消失失去意义。
	 */
	updateStreaming(isStreaming: boolean): void {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			return;
		}
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
		// 游标跟随 Session：只读本 Session 文件。v1 群聊级共享游标无 Session 身份，
		// 可能由其他角色推进——若回退采用其值会跳过本 Session 从未看过的消息，故
		// 不采用（User 2026-08-02：新 Session 无独立游标 = 从完整历史重新拉取，
		// 最多重复、绝不跳过）。旧共享文件物理遗留但不读不写。
		let sequence: number | null = null;
		try {
			sequence = readCursorFile(this.cursorStorePath);
		} catch {
			// 本 Session 文件不存在（ENOENT/EISDIR 等）——无游标，走完整历史分页
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
			this.groupChatInput = new GroupChatInput(this, pi, this.triggerDebounceMs);
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
		// 死连接上的 watchdog 定时器必须一并拆除：否则 agent_end 布防的 5s
		// 流式复位定时器（或 run wedged 定时器）会在 socket 置空后点火，
		// 定时器上下文内 throw = uncaughtException = 杀死整个 pi 进程。
		this.clearStreamingResetWatchdog();
		this.clearRunWedgedWatchdog();
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
