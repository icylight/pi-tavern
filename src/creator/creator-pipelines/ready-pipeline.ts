import type WebSocket from "ws";

import type { CharacterCard, CharacterSummary } from "../../config/character-card.js";
import { encodeCursor } from "../../data/cursor-store.js";
import type { GroupChatState } from "../../data/group-chat-state.js";
import type { ClientMessage } from "../../protocol/messages.js";
import type { PublicMessageState } from "../../protocol/public-message-state.js";
import { JOIN_HISTORY_LIMIT } from "../../shared/constants.js";
import type { HeartbeatRegistry } from "../heartbeat-registry.js";

type CharacterReadyMessage = Extract<ClientMessage, { type: "character_ready" }>;

/** 连接上下文窄接口（creator-runtime 的 ConnectionContext 结构子集）。 */
export interface ReadyConnectionLike {
	sessionId: string | null;
	online: boolean;
	reservedCharacterId: string | null;
}

/** 心跳簿记的本地窄接口（runtime HeartbeatState 结构子集）。 */
export interface ReadyPipelineDependencies {
	state: GroupChatState;
	connections: Map<string, WebSocket>;
	heartbeatRegistry: HeartbeatRegistry;
	publicMessages: PublicMessageState[];
	characters: ReadonlyMap<string, CharacterCard>;
	/** 预留定时器清理（runtime 方法注入，与超时释放同一归属）。 */
	clearReadyTimer: (connection: ReadyConnectionLike) => void;
	now: () => Date;
	toCharacterSummary: (character: CharacterCard) => CharacterSummary;
	toCharacterSummaryMessage: (character: CharacterSummary) => {
		character_id: string;
		name: string;
		description: string;
	};
	send: (socket: WebSocket, message: unknown) => void;
	sendFailure: (socket: WebSocket, id: string | undefined, command: "character_ready", reason: string) => void;
	broadcast: (message: unknown) => void;
	broadcastGroupChatUpdate: () => void;
	onMembersChanged: (() => void) | undefined;
}

/**
 * character_ready 门面（短流程：阶段多为发送顺序而非 IO 管线）。阶段：
 * validate（预留有效性）→ commit 在线态 → 响应 + 历史窗口 → 广播序列。
 * 历史窗口先于 character_joined 广播（新角色处理自己 join 事件时
 * hasPublicMessages 已为 true）；成员变化经 M7 通道通知（ISSUE-014/#14 方案 A）。
 */
export class ReadyPipeline {
	constructor(private readonly deps: ReadyPipelineDependencies) {}

	run(socket: WebSocket, connection: ReadyConnectionLike, message: CharacterReadyMessage): void {
		const { sessionId, reservedCharacterId } = connection;
		const character = reservedCharacterId ? this.deps.characters.get(reservedCharacterId) : undefined;
		if (
			sessionId === null ||
			reservedCharacterId === null ||
			!character ||
			connection.online ||
			this.deps.state.characterReservations.get(reservedCharacterId) !== sessionId
		) {
			this.deps.sendFailure(socket, message.id, "character_ready", "Character reservation is no longer valid");
			return;
		}
		if (this.deps.connections.has(sessionId)) {
			this.deps.sendFailure(socket, message.id, "character_ready", "This pi session is already in the group chat");
			return;
		}

		this.deps.clearReadyTimer(connection);
		this.deps.state.characterReservations.delete(reservedCharacterId);
		connection.reservedCharacterId = null;
		this.deps.connections.set(sessionId, socket);
		this.deps.heartbeatRegistry.register(sessionId);
		this.deps.state.onlineCharacters.set(sessionId, {
			sessionId,
			character: this.deps.toCharacterSummary(character),
			isStreaming: false,
			handRaised: false,
		});
		connection.online = true;

		this.deps.send(socket, {
			...(message.id !== undefined ? { id: message.id } : {}),
			type: "response",
			command: "character_ready",
			success: true,
		});

		// 在 join 广播前发送历史，使新 Character 处理自己的 character_joined
		// 事件时 hasPublicMessages 已为 true。
		// User 2026-08-01：join 推送窗口 10 → JOIN_HISTORY_LIMIT（100）。
		const recentMessages = this.deps.publicMessages.slice(-JOIN_HISTORY_LIMIT);
		const earliest = recentMessages[0];
		const hasMore = earliest !== undefined && earliest.sequence > 1;
		this.deps.send(socket, {
			type: "message_history",
			messages: recentMessages.map((m) => ({
				type: "public_message" as const,
				event_id: m.event_id,
				sequence: m.sequence,
				timestamp: m.timestamp,
				sender: m.sender,
				content: m.content,
				round: m.round,
			})),
			cursor: hasMore ? encodeCursor(earliest.sequence) : null,
			has_more: hasMore,
			total_messages: this.deps.publicMessages.length,
		});

		// 在 message_history 之后广播 character_joined，使新 Character 处理
		// 自己的 join 事件时 hasPublicMessages 已为 true。
		this.deps.broadcast({
			type: "character_joined",
			character: this.deps.toCharacterSummaryMessage(character),
		});
		this.deps.onMembersChanged?.();
		// ISSUE-014/#14（方案 A）：成员变化也经 M7 通知通道唤醒角色，使即使
		// 没有新消息到达时其 widget 快照也刷新。
		this.deps.broadcastGroupChatUpdate();
	}
}
