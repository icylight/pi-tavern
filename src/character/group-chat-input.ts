import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "../protocol/messages.js";
import type { CharacterRuntime } from "./character-runtime.js";

/**
 * Test-only observation channel for the acceptance suite (ISSUE-003
 * identity-line contract, cab1fd7). RPC mode has no input channel and
 * cannot invoke extension tools, so the identity line is re-emitted via
 * pi.ui.notify() (surfaces as extension_ui_request). The notify function is
 * injected from the session_start handler (the only place with UI access);
 * it is rebound on every session start, including reload.
 */
let testNotify: ((message: string) => void) | undefined;

export function setTestNotify(notify: ((message: string) => void) | undefined): void {
	testNotify = notify;
}

export interface GroupChatInputReloadSnapshot {
	pendingEvents: ServerMessage[];
	debounceDueAt: number | null;
}

/**
 * M7 (ISSUE-012/#24): how long to wait before submitting the environment
 * batch after a non-update event (join history, member changes). The old
 * 1s trailing-edge debounce is gone for group_chat_update — updates pull
 * immediately — but member/history batches still batch briefly so a join
 * never splits into multiple inputs.
 */
const JOIN_BATCH_DEBOUNCE_MS = 1000;

export class GroupChatInput {
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private debounceDueAt: number | null = null;
	/**
	 * ISSUE-013 A1/A2: pending delivery window. Holds join/member events
	 * (debounced so a join never splits) and any increment that had to wait
	 * for a running Agent turn. Public-message increments are NOT accumulated
	 * here while idle — they are fetched and delivered immediately (A1).
	 */
	private pendingEvents: ServerMessage[] = [];
	private handler: ((message: ServerMessage) => void) | undefined;
	private stopped = false;
	/** Single-flight lock: at most one fetch_messages_since in flight. */
	private fetchInFlight = false;
	/** Set when an update arrives while a fetch is in flight → refetch after. */
	private refetchRequested = false;
	/** Set when the Agent is mid-run and an increment must wait for settle. */
	private flushQueuedForSettle = false;
	/** Set when an update arrives while the Agent is mid-run (A2: no fetch). */
	private incrementPending = false;

	constructor(
		private readonly runtime: CharacterRuntime,
		private readonly pi: ExtensionAPI,
	) {
		// M7 A5 / ISSUE-013 A2/A4: when the Agent run settles, deliver what was
		// queued while the run was active ("不打断": never interrupt a running
		// turn). The increment is pulled ONCE at settle time, covering
		// everything after the cursor at that moment — no accumulated stale
		// batch (A2: delivery == latest at settle, no intermediate state).
		this.onSettled = () => {
			if (this.stopped) {
				return;
			}
			if (this.incrementPending) {
				this.incrementPending = false;
				void this.pullIncrement();
				return;
			}
			if (this.flushQueuedForSettle) {
				this.flushQueuedForSettle = false;
				void this.flush();
			}
		};
	}

	private readonly onSettled: () => void;

	start(): void {
		this.handler = (message: ServerMessage) => {
			if (message.type === "message_history" && Array.isArray(message.messages)) {
				// Join-time snapshot: expand into individual public_message events.
				// ISSUE-008: when has_more is set, page the remaining history via
				// the cursor so older messages are not lost. M7: the persisted
				// cursor takes precedence — a returning character diff-syncs
				// from its last delivered position instead of re-reading history.
				const before = this.pendingEvents.length;
				for (const m of message.messages) {
					if (m && typeof m === "object" && "type" in m && m.type === "public_message") {
						if (!this.isEnvironmentEvent(m as ServerMessage)) continue;
						this.pendingEvents.push(m as ServerMessage);
					}
				}
				// Only start debounce if messages were actually added
				if (this.pendingEvents.length > before) {
					this.resetJoinDebounce();
				}
				// Paging is deliberately fire-and-forget: the flush already
				// scheduled below carries the first page; the older pages are
				// appended as they arrive and flushed by a follow-up debounce.
				if (message.has_more) {
					this.pageOlderHistory(message.cursor).catch(() => undefined);
				}
				return;
			}
			if (message.type === "group_chat_update") {
				// M7: notification → immediate incremental pull (no debounce).
				// ISSUE-013 A1: the pull result is delivered straight away (no
				// batch accumulation); the preview is only for the TUI (same
				// source, so content never diverges).
				void this.pullIncrement();
				return;
			}
			if (!this.isEnvironmentEvent(message)) return;
			this.pendingEvents.push(message);
			this.resetJoinDebounce();
		};
		this.runtime.onEnvironmentMessage = this.handler;
		// Re-arm the settle hook on (re)start.
		this.runtime.onAgentSettled = this.onSettled;
	}

	/**
	 * M7 + ISSUE-013 A1/A2: pull every message after the persisted cursor and
	 * deliver it straight away — no batch accumulation in between.
	 *
	 * Single-flight: a concurrent update only marks refetchRequested and is
	 * coalesced into one follow-up pull. While the Agent is mid-run the pull
	 * is deferred entirely (A2: zero fetches during a run); the settle hook
	 * pulls once, covering everything after the cursor at settle time — so
	 * delivery is "latest at settle", never a stale accumulation.
	 */
	private async pullIncrement(): Promise<void> {
		if (this.stopped || this.fetchInFlight) {
			this.refetchRequested = true;
			return;
		}
		if (this.runtime.isAgentActive) {
			this.incrementPending = true;
			return;
		}
		this.fetchInFlight = true;
		try {
			do {
				this.refetchRequested = false;
				const since = this.runtime.loadCursor() ?? 0;
				const page = await this.runtime.fetchMessagesSince(since);
				if (!page || this.stopped) {
					return;
				}
				const messages: ServerMessage[] = [];
				for (const m of page.messages) {
					if (m && typeof m === "object" && "type" in m && m.type === "public_message") {
						if (!this.isEnvironmentEvent(m as ServerMessage)) continue;
						messages.push(m as ServerMessage);
					}
				}
				if (messages.length > 0) {
					// Cursor advances only when the increment reaches the context
					// (A5: delivery failure must not move the cursor).
					this.runtime.saveCursor(page.latestSequence);
					this.deliver(messages);
				}
			} while (this.refetchRequested && !this.stopped);
		} catch {
			// Pull failure: keep the cursor; the next update or join re-pulls
			// the same window (idempotent by sequence).
		} finally {
			this.fetchInFlight = false;
		}
	}

	/**
	 * ISSUE-013 A1/A2: unified delivery window. Merges the increment with any
	 * pending join/member events so ordering is preserved (events arrive
	 * first, then newer messages). Never interrupts a running turn: while the
	 * Agent is mid-run the events are kept and the settle hook flushes.
	 */
	private deliver(messages: ServerMessage[]): void {
		if (this.stopped) {
			return;
		}
		const events = [...this.pendingEvents, ...messages];
		this.pendingEvents = [];
		if (events.length === 0) {
			return;
		}
		if (this.runtime.isAgentActive) {
			this.pendingEvents = events;
			this.flushQueuedForSettle = true;
			return;
		}
		void this.flush(events);
	}

	/**
	 * Walk the remaining group chat history page by page (oldest pages are
	 * last) and append every public message to the pending delivery window.
	 * Any failure aborts the walk: the first page is already queued, and a
	 * reconnect will resync history anyway. ISSUE-008.
	 */
	private async pageOlderHistory(cursor: string | null): Promise<void> {
		try {
			let nextCursor: string | null = cursor;
			// A1 guard: never re-request the same cursor twice. A server that
			// fails to advance (or echoes a stale cursor) must not loop forever.
			const seenCursors = new Set<string>();
			while (nextCursor !== null && !this.stopped) {
				if (seenCursors.has(nextCursor)) {
					break;
				}
				seenCursors.add(nextCursor);
				const page = await this.runtime.fetchMessageHistoryPage(nextCursor);
				if (!page) {
					return;
				}
				for (const m of page.messages) {
					if (m && typeof m === "object" && "type" in m && m.type === "public_message") {
						if (!this.isEnvironmentEvent(m as ServerMessage)) continue;
						this.pendingEvents.push(m as ServerMessage);
					}
				}
				this.resetJoinDebounce();
				nextCursor = page.cursor;
				if (!page.hasMore) {
					break;
				}
			}
		} catch {
			// Best effort: keep whatever history was already collected.
		}
	}

	stop(): void {
		this.stopped = true;
		this.runtime.onEnvironmentMessage = undefined;
		if (this.runtime.onAgentSettled === this.onSettled) {
			this.runtime.onAgentSettled = undefined;
		}
		this.handler = undefined;
		this.clearDebounce();
		this.pendingEvents = [];
	}

	/**
	 * Capture un-flushed environment events and the debounce deadline for a
	 * reload handoff. The snapshot is consumed exactly once by the new runtime.
	 */
	snapshotForReload(): GroupChatInputReloadSnapshot {
		return {
			pendingEvents: [...this.pendingEvents],
			debounceDueAt: this.debounceDueAt,
		};
	}

	/** Restore a snapshot taken before reload; must be called after start(). */
	restoreFromReload(snapshot: GroupChatInputReloadSnapshot): void {
		this.pendingEvents = [...snapshot.pendingEvents];
		if (snapshot.debounceDueAt !== null) {
			const remaining = snapshot.debounceDueAt - Date.now();
			if (remaining <= 0) {
				// Already due: process immediately after the current tick.
				setTimeout(() => {
					if (!this.stopped) void this.flush();
				}, 0);
			} else {
				this.debounceTimer = setTimeout(() => {
					this.debounceTimer = null;
					void this.flush();
				}, remaining);
			}
		}
	}

	hasPendingBatch(): boolean {
		return this.debounceTimer !== null;
	}

	private isEnvironmentEvent(message: ServerMessage): boolean {
		switch (message.type) {
			case "public_message":
				return !this.isOwnEcho(message);
			case "character_joined":
			case "character_left":
				return this.runtime.hasPublicMessages;
			case "message_history":
				return true;
			default:
				return false;
		}
	}

	private isOwnEcho(message: ServerMessage & { type: "public_message" }): boolean {
		return message.sender.type === "character" && message.sender.character_id === this.runtime.character.characterId;
	}

	private resetJoinDebounce(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceDueAt = Date.now() + JOIN_BATCH_DEBOUNCE_MS;
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.debounceDueAt = null;
			void this.flush();
		}, JOIN_BATCH_DEBOUNCE_MS);
	}

	private clearDebounce(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
			this.debounceDueAt = null;
		}
	}

	/**
	 * ISSUE-013 B3: flag the increment mark (A2) from outside — used when a
	 * stale-rejected speak wants the missed increment delivered through the
	 * unified pipeline after the current run settles. No new mechanism: the
	 * settle hook pulls once and covers everything after the cursor.
	 */
	markIncrementPending(): void {
		if (this.stopped) {
			return;
		}
		this.incrementPending = true;
	}

	/**
	 * Deliver a batch of events to the agent context. When called with no
	 * arguments the pending window is delivered. Never interrupts a running
	 * turn: while the Agent is mid-run the events stay pending and the settle
	 * hook flushes them.
	 */
	private async flush(events?: ServerMessage[]): Promise<void> {
		const toDeliver = events ?? this.pendingEvents;
		if (events === undefined) {
			this.pendingEvents = [];
		}

		if (toDeliver.length === 0 || this.stopped) return;

		if (this.runtime.isAgentActive) {
			// M7 A5 / ISSUE-013 A4: never interrupt a running turn — the settle
			// hook flushes once the run is done.
			this.pendingEvents = [...this.pendingEvents, ...toDeliver];
			this.flushQueuedForSettle = true;
			return;
		}

		let groupChatState: unknown = null;
		try {
			groupChatState = await this.runtime.getGroupChatState();
		} catch {
			// Submit even if state fetch fails
		}

		if (this.stopped) return;

		const content = this.buildContent(toDeliver, groupChatState);

		if (process.env.PITAVERN_TEST === "1") {
			// M7 A6 observation channel: re-emit the delivered increment via
			// notify so the acceptance suite can assert that what reached the
			// agent context equals the notification source (same data).
			const sequences = toDeliver
				.filter((e) => e.type === "public_message")
				.map((e) => e.sequence)
				.sort((a, b) => a - b);
			if (sequences.length > 0) {
				testNotify?.(
					`[tavern-inject] group=${this.runtime.groupChatId} latest_seq=${sequences[sequences.length - 1]} count=${sequences.length}`,
				);
			}
		}

		this.pi.sendMessage(
			{
				customType: "pi-tavern.group-chat-input",
				content,
				display: true,
				details: {
					group_chat_id: this.runtime.groupChatId,
					character_id: this.runtime.character.characterId,
					events: toDeliver,
					group_chat_state: groupChatState,
				},
			},
			{
				triggerTurn: true,
				deliverAs: "followUp",
			},
		);
	}

	private buildContent(events: ServerMessage[], state: unknown): string {
		const parts: string[] = ["PiTavern 群聊环境更新"];

		// Identity anchor (ISSUE-003 three-field contract, cab1fd7): always
		// state which Character this session is, so the model never has to
		// guess its role from context or available skills. Format:
		// 你的当前角色：<persona 名>（character_id=<characterId>，注册名=<name>）
		const identity =
			`你的当前角色：${this.runtime.character.name}` +
			`（character_id=${this.runtime.character.characterId}，注册名=${this.runtime.character.name}）`;
		parts.push(`\n${identity}`);

		if (process.env.PITAVERN_TEST === "1") {
			// Observation channel for acceptance tests (RPC mode surfaces
			// notify as extension_ui_request; see identity-consistency.test.ts)
			testNotify?.(`[tavern-test-injection] ${identity}`);
		}

		// Group chat name
		const stateObj = state as {
			group_chat?: { name?: string | null };
			round?: { round_max_messages: number; used_messages: number; remaining_messages: number };
			online_characters?: Array<{ name: string }>;
		} | null;
		const name = stateObj?.group_chat?.name;
		if (name) {
			parts.push(`\n群聊：${name}`);
		}

		// New messages
		const messages = events.filter((e) => e.type === "public_message" || e.type === "message_history");
		if (messages.length > 0) {
			parts.push("\n新消息：");
			for (const message of messages) {
				if (message.type === "public_message") {
					const sender = message.sender.type === "user_persona" ? "User Persona" : message.sender.name;
					parts.push(`${sender}:\n${message.content}`);
				}
			}
		}

		// Member changes
		const memberChanges = events.filter((e) => e.type === "character_joined" || e.type === "character_left");
		if (memberChanges.length > 0) {
			parts.push("\n成员变化：");
			for (const event of memberChanges) {
				if (event.type === "character_joined") {
					parts.push(`${event.character.name} 加入了群聊。`);
				} else if (event.type === "character_left") {
					parts.push(`${event.character.name} 离开了群聊。`);
				}
			}
		}

		// Current state
		const round = stateObj?.round;
		if (round) {
			parts.push("\n当前状态：");
			const onlineChars = stateObj?.online_characters?.map((c) => c.name).join("、");
			if (onlineChars) {
				parts.push(`- 在线 Character：${onlineChars}`);
			}
			parts.push(`- Round 发言次数：${round.used_messages} / ${round.round_max_messages}`);
			parts.push(`- 剩余发言次数：${round.remaining_messages}`);
		}

		parts.push(
			"\n请根据这些群聊变化继续当前工作。",
			"如果需要公开回复，请调用 tavern_speak；",
			"普通回复不会自动进入群聊。",
			"公开回复应简洁，通常不超过 2000 个字符；",
			"较长的完整分析应保留在当前私有 pi session，",
			"只向群聊发布结论、关键理由和需要其他成员知道的信息。",
		);

		return parts.join("\n");
	}
}
