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

export class GroupChatInput {
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private debounceDueAt: number | null = null;
	private batch: ServerMessage[] = [];
	private handler: ((message: ServerMessage) => void) | undefined;
	private stopped = false;

	constructor(
		private readonly runtime: CharacterRuntime,
		private readonly pi: ExtensionAPI,
	) {}

	start(): void {
		this.handler = (message: ServerMessage) => {
			if (message.type === "message_history" && Array.isArray(message.messages)) {
				// Expand message_history into individual public_message events
				const before = this.batch.length;
				for (const m of message.messages) {
					if (m && typeof m === "object" && "type" in m && m.type === "public_message") {
						if (!this.isEnvironmentEvent(m as ServerMessage)) continue;
						this.batch.push(m as ServerMessage);
					}
				}
				// Only start debounce if messages were actually added
				if (this.batch.length > before) {
					this.resetDebounce();
				}
				return;
			}
			if (!this.isEnvironmentEvent(message)) return;
			this.batch.push(message);
			this.resetDebounce();
		};
		this.runtime.onEnvironmentMessage = this.handler;
	}

	stop(): void {
		this.stopped = true;
		this.runtime.onEnvironmentMessage = undefined;
		this.handler = undefined;
		this.clearDebounce();
		this.batch = [];
	}

	/**
	 * Capture un-flushed environment events and the debounce deadline for a
	 * reload handoff. The snapshot is consumed exactly once by the new runtime.
	 */
	snapshotForReload(): GroupChatInputReloadSnapshot {
		return {
			pendingEvents: [...this.batch],
			debounceDueAt: this.debounceDueAt,
		};
	}

	/** Restore a snapshot taken before reload; must be called after start(). */
	restoreFromReload(snapshot: GroupChatInputReloadSnapshot): void {
		this.batch = [...snapshot.pendingEvents];
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

	private resetDebounce(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceDueAt = Date.now() + 1000;
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.debounceDueAt = null;
			void this.flush();
		}, 1000);
	}

	private clearDebounce(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
			this.debounceDueAt = null;
		}
	}

	private async flush(): Promise<void> {
		const events = [...this.batch];
		this.batch = [];

		if (events.length === 0 || this.stopped) return;

		let groupChatState: unknown = null;
		try {
			groupChatState = await this.runtime.getGroupChatState();
		} catch {
			// Submit even if state fetch fails
		}

		if (this.stopped) return;

		const content = this.buildContent(events, groupChatState);

		this.pi.sendMessage(
			{
				customType: "pi-tavern.group-chat-input",
				content,
				display: true,
				details: {
					group_chat_id: this.runtime.groupChatId,
					character_id: this.runtime.character.characterId,
					events,
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
