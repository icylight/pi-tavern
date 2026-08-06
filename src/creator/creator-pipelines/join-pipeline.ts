import type WebSocket from "ws";
import type { CharacterCard, CharacterSummary } from "../../config/character-card.js";
import { type ClientMessage, JSONRPC_VERSION } from "../../protocol/messages.js";
import {
	ERROR_ALREADY_IN_GROUP_CHAT,
	ERROR_CODE_ALREADY_IN_GROUP,
	type ProtocolErrorCode,
} from "../../shared/messages.js";

type JoinGroupChatMessage = Extract<ClientMessage, { method: "join_group_chat" }>;

/** 连接上下文的本地窄接口（creator-runtime 的 ConnectionContext 结构子集）。 */
export interface JoinConnectionLike {
	sessionId: string | null;
	online: boolean;
}

export interface JoinPipelineDependencies {
	/** 按 pi session id 索引的存活 socket 表（runtime 会话状态，管线只读）。 */
	connections: ReadonlyMap<string, WebSocket>;
	/** 可用角色查询（runtime 方法注入：预留表 + 在线表过滤）。 */
	getAvailableCharacters: () => CharacterCard[];
	toCharacterSummaryMessage: (character: CharacterSummary) => {
		character_id: string;
		name: string;
		description: string;
	};
	send: (socket: WebSocket, message: unknown) => void;
	sendFailure: (socket: WebSocket, id: string | undefined, code: ProtocolErrorCode, message: string) => void;
}

/**
 * join_group_chat 门面（短流程：粒度约束不建管线）。阶段：
 * validate（防重复加入/会话冲突）→ commit（会话归属）→ respond（可用角色快照）。
 * 只显式读写 runtime 会话状态（决策 7：跨消息状态唯一居所 = runtime），不缓存跨消息状态。
 */
export class JoinPipeline {
	constructor(private readonly deps: JoinPipelineDependencies) {}

	run(socket: WebSocket, connection: JoinConnectionLike, message: JoinGroupChatMessage): void {
		// validate：已在线 / 该会话已占 socket / 已归属其他会话 → 业务性拒绝
		if (
			connection.online ||
			this.deps.connections.has(message.params.session_id) ||
			(connection.sessionId !== null && connection.sessionId !== message.params.session_id)
		) {
			this.deps.sendFailure(socket, message.id, ERROR_CODE_ALREADY_IN_GROUP, ERROR_ALREADY_IN_GROUP_CHAT);
			return;
		}

		// commit：会话归属写入连接上下文（runtime 状态显式读写）
		connection.sessionId = message.params.session_id;

		// respond：可用角色快照（排除已预留 + 已在线）
		this.deps.send(socket, {
			...(message.id !== undefined ? { id: message.id } : {}),
			jsonrpc: JSONRPC_VERSION,
			result: {
				available_characters: this.deps.getAvailableCharacters().map(this.deps.toCharacterSummaryMessage),
			},
		});
	}
}
