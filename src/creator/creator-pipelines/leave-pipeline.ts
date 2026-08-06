import type WebSocket from "ws";
import { JSONRPC_VERSION, type ClientMessage } from "../../protocol/messages.js";
import {
	ERROR_CODE_NOT_IN_GROUP,
	ERROR_LEFT_GROUP_CHAT,
	ERROR_NOT_IN_GROUP_CHAT,
	type ProtocolErrorCode,
} from "../../shared/messages.js";

type LeaveGroupChatMessage = Extract<ClientMessage, { method: "leave_group_chat" }>;

/** 连接上下文的本地窄接口（creator-runtime 的 ConnectionContext 结构子集）。 */
export interface LeaveConnectionLike {
	online: boolean;
	sessionId: string | null;
}

export interface LeavePipelineDependencies {
	/**
	 * 下线编排（runtime 方法注入）：清理连接表/心跳/在线表 + character_left
	 * 广播 + 成员变更通知。跨消息状态编排归 runtime（决策 7），管线只安排时序。
	 */
	removeOnlineCharacter: (connection: LeaveConnectionLike, reason: "left" | "disconnected") => void;
	send: (socket: WebSocket, message: unknown) => void;
	sendFailure: (socket: WebSocket, id: string | undefined, code: ProtocolErrorCode, message: string) => void;
}

/**
 * leave_group_chat 门面（短流程：粒度约束不建管线）。阶段：
 * validate（成员资格）→ offline（下线编排）→ respond + close（连接关闭）。
 */
export class LeavePipeline {
	constructor(private readonly deps: LeavePipelineDependencies) {}

	run(socket: WebSocket, connection: LeaveConnectionLike, message: LeaveGroupChatMessage): void {
		// validate：非成员拒绝
		if (!connection.online) {
			this.deps.sendFailure(socket, message.id, ERROR_CODE_NOT_IN_GROUP, ERROR_NOT_IN_GROUP_CHAT);
			return;
		}

		// offline：状态清理 + 广播（注入 runtime 编排）
		this.deps.removeOnlineCharacter(connection, "left");

		// 响应 + 关闭
		this.deps.send(socket, {
			...(message.id !== undefined ? { id: message.id } : {}),
			jsonrpc: JSONRPC_VERSION,
			result: null,
		});
		socket.close(1000, ERROR_LEFT_GROUP_CHAT);
	}
}
