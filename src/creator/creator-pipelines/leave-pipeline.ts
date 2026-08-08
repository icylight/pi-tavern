import { ResponseError } from "vscode-jsonrpc";
import type WebSocket from "ws";
import type { ClientMessage } from "../../protocol/messages.js";
import { ERROR_CODE_NOT_IN_GROUP, ERROR_LEFT_GROUP_CHAT, ERROR_NOT_IN_GROUP_CHAT } from "../../shared/messages.js";

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
}

/**
 * leave_group_chat 门面（短流程：粒度约束不建管线）。阶段：
 * validate（成员资格）→ offline（下线编排）→ respond + close（连接关闭）。
 */
export class LeavePipeline {
	constructor(private readonly deps: LeavePipelineDependencies) {}

	run(socket: WebSocket, connection: LeaveConnectionLike, _message: LeaveGroupChatMessage): null {
		// validate：非成员拒绝
		if (!connection.online) {
			throw new ResponseError(ERROR_CODE_NOT_IN_GROUP, ERROR_NOT_IN_GROUP_CHAT);
		}

		// offline：状态清理 + 广播（注入 runtime 编排）
		this.deps.removeOnlineCharacter(connection, "left");

		// 响应经 connection 返回（result: null）后关闭连接——close 延迟到宏任务，
		// 保证库 reply（微任务）先于 close 发出（close 后 writer 拒绝写）。
		setImmediate(() => socket.close(1000, ERROR_LEFT_GROUP_CHAT));
		return null;
	}
}
