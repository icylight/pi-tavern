import WebSocket from "ws";
import type { CharacterSummary } from "../config/character-card.js";
import type { GroupChatState } from "../data/group-chat-state.js";
import { encodeMessage } from "../protocol/codec.js";
import type { DecisionSnapshotWire } from "../protocol/messages.js";
import type { PublicMessageState } from "../protocol/public-message-state.js";

export type FailureCommand =
	| "join_group_chat"
	| "claim_character"
	| "character_ready"
	| "leave_group_chat"
	| "get_group_chat_state"
	| "get_message_history"
	| "fetch_messages_since"
	| "get_chat_history_file"
	| "speak"
	| "decision_declare";

export interface BroadcastHubOptions {
	/** 群聊状态对象（骨架持有实体，只读引用注入）。 */
	state: GroupChatState;
	/** 公共消息数组读取（骨架持有实体，getter 注入）。 */
	readPublicMessages: () => PublicMessageState[];
	/** #107：决策状态快照读取（getter 注入——快照归属组合根/骨架，hub 只装配）。 */
	readDecisionSnapshot: () => DecisionSnapshotWire | null;
	/** 在线连接表遍历（骨架持有 Map 实体，只读引用注入）。 */
	iterateConnections: (visit: (socket: WebSocket) => void) => void;
	/** runtime 是否处于 active 生命周期（决定发送失败是否走断连清理）。 */
	isActive: () => boolean;
	/** 发送失败时的统一断连清理（runtime 注入，含 connectionBySocket 簿记）。 */
	onSendFailure: (socket: WebSocket) => void;
	toCharacterSummaryMessage: (character: CharacterSummary) => {
		character_id: string;
		name: string;
		description: string | null;
	};
}

/**
 * 出站消息构造与组播（PR-B 拆自 CreatorRuntime）。
 * 无状态语义：状态/连接实体由骨架持有，经窄接口注入；不 import CreatorRuntime。
 */
export class BroadcastHub {
	private readonly options: BroadcastHubOptions;

	constructor(options: BroadcastHubOptions) {
		this.options = options;
	}

	getGroupChatStateMessage(requestingSessionId: string) {
		const { groupChat, round } = this.options.state;
		return {
			group_chat: {
				group_chat_id: groupChat.groupChatId,
				name: groupChat.name,
				created_at: groupChat.createdAt,
				group_max_messages: groupChat.groupMaxMessages,
			},
			round: round
				? {
						round_max_messages: round.roundMaxMessages,
						used_messages: round.usedMessages,
						remaining_messages: Math.max(0, round.roundMaxMessages - round.usedMessages),
					}
				: null,
			online_characters: [...this.options.state.onlineCharacters.values()].map((online) => ({
				...this.options.toCharacterSummaryMessage(online.character),
				is_self: online.sessionId === requestingSessionId,
				is_streaming: online.isStreaming,
				hand_raised: online.handRaised,
			})),
			// #107：决策状态快照（join/reload 重同步——C2/T14；空链 = null）。
			decision_snapshot: this.options.readDecisionSnapshot(),
		};
	}

	sendFailure(socket: WebSocket, id: string | undefined, command: FailureCommand, error: string): void {
		this.send(socket, {
			...(id !== undefined ? { id } : {}),
			type: "response",
			command,
			success: false,
			error,
		});
	}

	send(socket: WebSocket, message: unknown): void {
		let encoded: string;
		try {
			encoded = encodeMessage(message);
		} catch (error) {
			// G2（审查②）：编码失败（如超 1 MiB）= 消息问题，**不是 socket 问题**——
			// 记录并跳过该连接，绝不触发断连清理（防「一次坏消息毒死全群聊」）。
			console.error(
				`[pi-tavern] broadcast encode failed, skipping connection: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		try {
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(encoded);
				return;
			}
		} catch {
			// 落入下面：socket 不可用。
		}
		// close/detach 期间由运行时自行清理；发送失败不得与终止流程竞争。
		if (this.options.isActive()) {
			this.options.onSendFailure(socket);
		}
	}

	broadcast(message: unknown): void {
		this.options.iterateConnections((socket) => this.send(socket, message));
	}

	/**
	 * M7（ISSUE-012/#24）：广播 group_chat_update 通知而非完整 public_message
	 * 事件。角色收到通知后经 fetch_messages_since 拉取真实增量。preview 携带
	 * 最近消息（微信风格）；内容与拉取路径同源（publicMessages），UI 与
	 * agent 上下文永不分叉。
	 */
	broadcastGroupChatUpdate(): void {
		const messages = this.options.readPublicMessages();
		const latest = messages[messages.length - 1];
		// ISSUE-014/#14（方案 A）：成员/流式变化可能先于任何公开消息到达——
		// 仍广播（latest_sequence 0、空 preview），使角色唤醒并刷新快照。
		if (!latest) {
			this.broadcast({
				type: "group_chat_update",
				latest_sequence: 0,
				preview_messages: [],
				total_messages: 0,
				// #107（F3）：广播携带决策快照——角色快照变化即触发注入投递。
				decision_snapshot: this.options.readDecisionSnapshot(),
			});
			return;
		}
		this.broadcast({
			type: "group_chat_update",
			latest_sequence: latest.sequence,
			preview_messages: messages.slice(-3).map((m) => ({
				type: "public_message" as const,
				event_id: m.event_id,
				sequence: m.sequence,
				timestamp: m.timestamp,
				sender: m.sender,
				content: m.content,
				round: m.round,
			})),
			total_messages: messages.length,
			// #107（F3）：广播携带决策快照——角色快照变化即触发注入投递。
			decision_snapshot: this.options.readDecisionSnapshot(),
		});
	}
}
