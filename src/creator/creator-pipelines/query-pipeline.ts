import type WebSocket from "ws";
import { decodeCursor, encodeCursor } from "../../data/cursor-store.js";
import type { GroupChatState } from "../../data/group-chat-state.js";
import type { SessionStore } from "../../data/session-store.js";
import type { ClientMessage } from "../../protocol/messages.js";
import type { PublicMessageState } from "../../protocol/public-message-state.js";

/** 查询族消息类型（门面方法各自收窄）。 */
export type QueryConnectionLike = {
	sessionId: string | null;
	online: boolean;
	decisionStateCapable: boolean;
};

export interface QueryPipelineDependencies {
	state: GroupChatState;
	publicMessages: PublicMessageState[];
	sessionStore: SessionStore;
	getPersistedCount: () => number;
	/** 群聊状态快照构造（runtime 方法注入：group_chat/round/online_characters 装配）。 */
	getGroupChatStateMessage: (requestingSessionId: string, includeDecisionSnapshot: boolean) => unknown;
	send: (socket: WebSocket, message: unknown) => void;
	sendFailure: (
		socket: WebSocket,
		id: string | undefined,
		command: "get_group_chat_state" | "get_message_history" | "fetch_messages_since" | "get_chat_history_file",
		reason: string,
	) => void;
	broadcastGroupChatUpdate: () => void;
	onMembersChanged: (() => void) | undefined;
}

/**
 * 查询族门面（短流程：校验 → 快照读 → 响应，≤3 阶段无共享中间态，粒度约束
 * 不建管线）。五个协议消息各对应一个方法；update_character_state 为状态翻转
 * 门面（校验 → 提交 → 广播通知）。只读/显式写 runtime 会话状态（决策 7）。
 */
export class QueryPipeline {
	constructor(private readonly deps: QueryPipelineDependencies) {}

	runGetGroupChatState(
		socket: WebSocket,
		connection: QueryConnectionLike,
		message: Extract<ClientMessage, { type: "get_group_chat_state" }>,
	): void {
		if (!connection.online || connection.sessionId === null) {
			this.deps.sendFailure(socket, message.id, "get_group_chat_state", "Character is not in the group chat");
			return;
		}
		this.deps.send(socket, {
			...(message.id !== undefined ? { id: message.id } : {}),
			type: "response",
			command: "get_group_chat_state",
			success: true,
			data: this.deps.getGroupChatStateMessage(connection.sessionId, connection.decisionStateCapable),
		});
	}

	runGetMessageHistory(
		socket: WebSocket,
		connection: QueryConnectionLike,
		message: Extract<ClientMessage, { type: "get_message_history" }>,
	): void {
		if (!connection.online || connection.sessionId === null) {
			this.deps.sendFailure(socket, message.id, "get_message_history", "Character is not in the group chat");
			return;
		}

		// 游标是绝对 sequence 边界：返回 sequence < cursorSeq 的最近 10 条。
		// 新消息不会使其移位。
		// 注：分页大小保持 10（增量分页粒度）；只有 join 推送窗口用
		// JOIN_HISTORY_LIMIT（User 2026-08-01）。
		const cursorSeq = message.cursor === undefined || message.cursor === null ? null : decodeCursor(message.cursor);
		const page =
			cursorSeq === null
				? this.deps.publicMessages.slice(-10)
				: this.deps.publicMessages.filter((m) => m.sequence < cursorSeq).slice(-10);
		const earliest = page[0];
		const hasMore = earliest !== undefined && earliest.sequence > 1;

		this.deps.send(socket, {
			...(message.id !== undefined ? { id: message.id } : {}),
			type: "response",
			command: "get_message_history",
			success: true,
			data: {
				messages: page.map((m) => ({
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
			},
		});
	}

	runFetchMessagesSince(
		socket: WebSocket,
		connection: QueryConnectionLike,
		message: Extract<ClientMessage, { type: "fetch_messages_since" }>,
	): void {
		if (!connection.online || connection.sessionId === null) {
			this.deps.sendFailure(socket, message.id, "fetch_messages_since", "Character is not in the group chat");
			return;
		}

		// 增量拉取（M7/ISSUE-012）：返回客户端游标之后的全部消息。sequence
		// 过滤天然补洞——漏掉的通知由下一次拉取自愈。
		const since = message.since_sequence;
		const increment = this.deps.publicMessages.filter((m) => m.sequence > since);
		const latest = this.deps.publicMessages[this.deps.publicMessages.length - 1];

		this.deps.send(socket, {
			...(message.id !== undefined ? { id: message.id } : {}),
			type: "response",
			command: "fetch_messages_since",
			success: true,
			data: {
				messages: increment.map((m) => ({
					type: "public_message" as const,
					event_id: m.event_id,
					sequence: m.sequence,
					timestamp: m.timestamp,
					sender: m.sender,
					content: m.content,
					round: m.round,
				})),
				latest_sequence: latest?.sequence ?? since,
				total_messages: this.deps.publicMessages.length,
			},
		});
	}

	runGetChatHistoryFile(
		socket: WebSocket,
		connection: QueryConnectionLike,
		message: Extract<ClientMessage, { type: "get_chat_history_file" }>,
	): void {
		if (!connection.online || connection.sessionId === null) {
			this.deps.sendFailure(socket, message.id, "get_chat_history_file", "Character is not in the group chat");
			return;
		}

		let path: string;
		try {
			path = this.deps.sessionStore.getSessionFilePath();
		} catch {
			this.deps.sendFailure(socket, message.id, "get_chat_history_file", "Group chat has no chat history file yet");
			return;
		}
		// 文件在首次持久化后才存在；SessionManager 在文件写入前可能已知路径。
		if (this.deps.getPersistedCount() === 0) {
			this.deps.sendFailure(socket, message.id, "get_chat_history_file", "Group chat has no chat history file yet");
			return;
		}
		this.deps.send(socket, {
			...(message.id !== undefined ? { id: message.id } : {}),
			type: "response",
			command: "get_chat_history_file",
			success: true,
			data: { path },
		});
	}

	/** update_character_state：流式状态翻转门面（无响应；失败静默——原语义保持）。 */
	runUpdateCharacterState(connection: QueryConnectionLike, isStreaming: boolean): void {
		if (!connection.online || connection.sessionId === null) {
			return;
		}
		const onlineCharacter = this.deps.state.onlineCharacters.get(connection.sessionId);
		// #83（User 2026-08-03 根因）：状态未变化（true→true / false→false）
		// 直接返回——原实现无条件广播，与 character 侧 getGroupChatState 补偿
		// 重发构成自激循环（updateStreaming → 广播 → 拉状态 → updateStreaming），
		// 风暴致 5s 请求超时 failConnection 掉线。状态翻转才广播（TUI 实时性
		// 不受影响：翻转时仍广播）。
		if (!onlineCharacter || onlineCharacter.isStreaming === isStreaming) {
			return;
		}
		onlineCharacter.isStreaming = isStreaming;
		this.deps.onMembersChanged?.();
		// ISSUE-014/#14（方案 A）：流式翻转是最频繁的成员状态变化——广播更新
		// 通知使每个角色刷新快照（widget「正在发言」保持实时）。
		this.deps.broadcastGroupChatUpdate();
	}
}
