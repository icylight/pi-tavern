import { ResponseError } from "vscode-jsonrpc";
import type WebSocket from "ws";
import { decodeCursor, encodeCursor } from "../../data/cursor-store.js";
import type { GroupChatState } from "../../data/group-chat-state.js";
import type { SessionStore } from "../../data/session-store.js";
import { type ClientMessage, JSONRPC_VERSION } from "../../protocol/messages.js";
import type { PublicMessageState } from "../../protocol/public-message-state.js";
import {
	ERROR_CODE_NO_CHAT_HISTORY,
	ERROR_CODE_NOT_IN_GROUP,
	ERROR_NO_CHAT_HISTORY_FILE,
	ERROR_NOT_IN_GROUP_CHAT,
	METHOD_PUBLIC_MESSAGE,
} from "../../shared/messages.js";

/** 查询族消息类型（门面方法各自收窄）。 */
export type QueryConnectionLike = {
	sessionId: string | null;
	online: boolean;
};

export interface QueryPipelineDependencies {
	state: GroupChatState;
	publicMessages: PublicMessageState[];
	sessionStore: SessionStore;
	getPersistedCount: () => number;
	/** 群聊状态快照构造（runtime 方法注入：group_chat/round/online_characters 装配）。 */
	getGroupChatStateMessage: (requestingSessionId: string) => unknown;
	onMembersChanged: (() => void) | undefined;
}

/**
 * 查询族门面（短流程：校验 → 快照读 → 响应，≤3 阶段无共享中间态，粒度约束
 * 不建管线）。五个协议消息各对应一个方法；update_character_state 为状态翻转
 * 门面（校验 → 提交）。只读/显式写 runtime 会话状态（决策 7）。
 */
export class QueryPipeline {
	constructor(private readonly deps: QueryPipelineDependencies) {}

	runGetGroupChatState(
		socket: WebSocket,
		connection: QueryConnectionLike,
		message: Extract<ClientMessage, { method: "get_group_chat_state" }>,
	): unknown {
		void socket;
		if (!connection.online || connection.sessionId === null) {
			throw new ResponseError(ERROR_CODE_NOT_IN_GROUP, ERROR_NOT_IN_GROUP_CHAT);
		}
		return this.deps.getGroupChatStateMessage(connection.sessionId);
	}

	runGetMessageHistory(
		socket: WebSocket,
		connection: QueryConnectionLike,
		message: Extract<ClientMessage, { method: "get_message_history" }>,
	): {
		messages: {
			jsonrpc: "2.0";
			method: "public_message";
			params: {
				event_id: string;
				sequence: number;
				timestamp: string;
				sender: { type: "user_persona" } | { type: "character"; character_id: string; name: string };
				content: string;
				round: { round_max_messages: number; used_messages: number; remaining_messages: number };
			};
		}[];
		cursor: string | null;
		has_more: boolean;
		total_messages: number;
	} {
		void socket;
		if (!connection.online || connection.sessionId === null) {
			throw new ResponseError(ERROR_CODE_NOT_IN_GROUP, ERROR_NOT_IN_GROUP_CHAT);
		}

		// 游标是绝对 sequence 边界：返回 sequence < cursorSeq 的最近 10 条。
		// 新消息不会使其移位。
		// 注：分页大小保持 10（增量分页粒度）；只有 join 推送窗口用
		// JOIN_HISTORY_LIMIT（User 2026-08-01）。
		const cursorSeq =
			message.params.cursor === undefined || message.params.cursor === null
				? null
				: decodeCursor(message.params.cursor);
		const page =
			cursorSeq === null
				? this.deps.publicMessages.slice(-10)
				: this.deps.publicMessages.filter((m) => m.sequence < cursorSeq).slice(-10);
		const earliest = page[0];
		const hasMore = earliest !== undefined && earliest.sequence > 1;

		return {
			messages: page.map((m) => ({
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
			cursor: hasMore ? encodeCursor(earliest.sequence) : null,
			has_more: hasMore,
			total_messages: this.deps.publicMessages.length,
		};
	}

	runFetchMessagesSince(
		socket: WebSocket,
		connection: QueryConnectionLike,
		message: Extract<ClientMessage, { method: "fetch_messages_since" }>,
	): {
		messages: {
			jsonrpc: "2.0";
			method: "public_message";
			params: {
				event_id: string;
				sequence: number;
				timestamp: string;
				sender: { type: "user_persona" } | { type: "character"; character_id: string; name: string };
				content: string;
				round: { round_max_messages: number; used_messages: number; remaining_messages: number };
			};
		}[];
		latest_sequence: number;
		total_messages: number;
	} {
		void socket;
		if (!connection.online || connection.sessionId === null) {
			throw new ResponseError(ERROR_CODE_NOT_IN_GROUP, ERROR_NOT_IN_GROUP_CHAT);
		}

		// 增量拉取（M7/ISSUE-012）：返回客户端游标之后的全部消息。sequence
		// 过滤天然补洞——漏掉的通知由下一次拉取自愈。
		const since = message.params.since_sequence;
		const increment = this.deps.publicMessages.filter((m) => m.sequence > since);
		const latest = this.deps.publicMessages[this.deps.publicMessages.length - 1];

		return {
			messages: increment.map((m) => ({
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
			latest_sequence: latest?.sequence ?? since,
			total_messages: this.deps.publicMessages.length,
		};
	}

	runGetChatHistoryFile(
		socket: WebSocket,
		connection: QueryConnectionLike,
		message: Extract<ClientMessage, { method: "get_chat_history_file" }>,
	): { path: string } {
		void socket;
		if (!connection.online || connection.sessionId === null) {
			throw new ResponseError(ERROR_CODE_NOT_IN_GROUP, ERROR_NOT_IN_GROUP_CHAT);
		}

		let path: string;
		try {
			path = this.deps.sessionStore.getSessionFilePath();
		} catch {
			throw new ResponseError(ERROR_CODE_NO_CHAT_HISTORY, ERROR_NO_CHAT_HISTORY_FILE);
		}
		// 文件在首次持久化后才存在；SessionManager 在文件写入前可能已知路径。
		if (this.deps.getPersistedCount() === 0) {
			throw new ResponseError(ERROR_CODE_NO_CHAT_HISTORY, ERROR_NO_CHAT_HISTORY_FILE);
		}
		return { path };
	}

	/** update_character_state：流式状态翻转门面（无响应；失败静默——原语义保持）。 */
	runUpdateCharacterState(connection: QueryConnectionLike, isStreaming: boolean): void {
		if (!connection.online || connection.sessionId === null) {
			return;
		}
		const onlineCharacter = this.deps.state.onlineCharacters.get(connection.sessionId);
		// 状态未变化（true→true / false→false）直接返回。
		if (!onlineCharacter || onlineCharacter.isStreaming === isStreaming) {
			return;
		}
		onlineCharacter.isStreaming = isStreaming;
		this.deps.onMembersChanged?.();
	}
}
