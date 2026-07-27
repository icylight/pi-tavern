import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "../protocol/messages.js";
import type { CharacterRuntime } from "./character-runtime.js";

export class GroupChatInput {
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
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
				for (const m of message.messages) {
					if (m && typeof m === "object" && "type" in m && m.type === "public_message") {
						if (!this.isEnvironmentEvent(m as ServerMessage)) continue;
						this.batch.push(m as ServerMessage);
					}
				}
				this.resetDebounce();
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
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			void this.flush();
		}, 1000);
	}

	private clearDebounce(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
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
