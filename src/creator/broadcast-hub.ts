import WebSocket from "ws";
import type { CharacterSummary } from "../config/character-card.js";
import type { GroupChatState } from "../data/group-chat-state.js";
import { encodeMessage } from "../protocol/codec.js";
import { JSONRPC_VERSION, type ServerMessage } from "../protocol/messages.js";
import type { PublicMessageState } from "../protocol/public-message-state.js";
import { METHOD_GROUP_CHAT_UPDATE, METHOD_PUBLIC_MESSAGE, type ProtocolErrorCode } from "../shared/messages.js";

interface BroadcastHubOptions {
	/** 群聊状态对象（骨架持有实体，只读引用注入）。 */
	state: GroupChatState;
	/** 公共消息数组读取（骨架持有实体，getter 注入）。 */
	readPublicMessages: () => PublicMessageState[];
	/** 在线连接表遍历（骨架持有 Map 实体，只读引用注入）。 */
	iterateConnections: (visit: (socket: WebSocket) => void) => void;
	/** runtime 是否处于 active 生命周期（决定发送失败是否走断连清理）。 */
	isActive: () => boolean;
	/** 发送失败时的统一断连清理（runtime 注入，含 connectionBySocket 簿记）。 */
	onSendFailure: (socket: WebSocket) => void;
	toCharacterSummaryMessage: (character: CharacterSummary) => {
		character_id: string;
		name: string;
		description: string;
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
		};
	}

	sendFailure(socket: WebSocket, id: string | undefined, code: ProtocolErrorCode, message: string): void {
		this.send(socket, {
			...(id !== undefined ? { id } : {}),
			jsonrpc: JSONRPC_VERSION,
			error: {
				code,
				message,
			},
		});
	}

	send(socket: WebSocket, message: unknown): void {
		try {
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(encodeMessage(message));
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

	/**
	 * 组播（服务端通知通道）。载荷 = 完整 ServerMessage 通知帧（Arch 顺手优化：
	 * 对抗模式②实证过宽 unknown 类型逃逸 tsc——旧信封 4 处 wire 漂移；收窄后
	 * 调用点形状错误在编译期即被捕获）。
	 */
	broadcast(message: ServerMessage): void {
		let _count = 0;
		this.options.iterateConnections((socket) => {
			_count++;
			this.send(socket, message);
		});
	}

	/**
	 * 广播 group_chat_update 通知而非完整 public_message
	 * 事件。角色收到通知后经 fetch_messages_since 拉取真实增量。preview 携带
	 * 最近消息（微信风格）；内容与拉取路径同源（publicMessages），UI 与
	 * agent 上下文永不分叉。
	 */
	broadcastGroupChatUpdate(): void {
		const messages = this.options.readPublicMessages();
		const latest = messages[messages.length - 1];
		// 防御性保留空消息形态；正常调用点仅在公共消息成功持久化后到达，
		// 因此不会用本通知承载成员、流式状态或白板变化。
		if (!latest) {
			this.broadcast({
				jsonrpc: JSONRPC_VERSION,
				method: METHOD_GROUP_CHAT_UPDATE,
				params: {
					latest_sequence: 0,
					preview_messages: [],
					total_messages: 0,
				},
			});
			return;
		}
		this.broadcast({
			jsonrpc: JSONRPC_VERSION,
			method: METHOD_GROUP_CHAT_UPDATE,
			params: {
				latest_sequence: latest.sequence,
				preview_messages: messages.slice(-3).map((m) => ({
					jsonrpc: JSONRPC_VERSION,
					method: METHOD_PUBLIC_MESSAGE,
					params: {
						event_id: m.event_id,
						sequence: m.sequence,
						timestamp: m.timestamp,
						sender: m.sender,
						content: m.content,
						round: m.round,
					},
				})),
				total_messages: messages.length,
			},
		});
	}
}
