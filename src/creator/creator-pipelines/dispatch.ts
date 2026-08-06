import { NotificationType, RequestType } from "vscode-jsonrpc";
import type WebSocket from "ws";

import {
	METHOD_BOARD_QUERY,
	METHOD_BOARD_WRITE,
	METHOD_CHARACTER_READY,
	METHOD_CLAIM_CHARACTER,
	METHOD_FETCH_MESSAGES_SINCE,
	METHOD_GET_CHAT_HISTORY_FILE,
	METHOD_GET_GROUP_CHAT_STATE,
	METHOD_GET_MESSAGE_HISTORY,
	METHOD_JOIN_GROUP_CHAT,
	METHOD_LEAVE_GROUP_CHAT,
	METHOD_SPEAK,
	METHOD_UPDATE_CHARACTER_STATE,
} from "../../shared/messages.js";
import type { ClientMessage } from "../../protocol/messages.js";
import type { ConnectionContext } from "../connection-manager.js";
import { BoardPipeline } from "./board-pipeline.js";
import { ClaimPipeline } from "./claim-pipeline.js";
import type { JoinPipeline } from "./join-pipeline.js";
import type { LeavePipeline } from "./leave-pipeline.js";
import { QueryPipeline } from "./query-pipeline.js";
import { ReadyPipeline } from "./ready-pipeline.js";
import { SubmitMessagePipeline } from "./submit-message-pipeline.js";

/** 分发依赖面（runtime 装配注入的管线门面）。 */
export interface DispatchDependencies {
	joinPipeline: JoinPipeline;
	leavePipeline: LeavePipeline;
	submitMessageDeps: ConstructorParameters<typeof SubmitMessagePipeline>[0];
	claimDeps: ConstructorParameters<typeof ClaimPipeline>[0];
	readyDeps: ConstructorParameters<typeof ReadyPipeline>[0];
	queryDeps: ConstructorParameters<typeof QueryPipeline>[0];
	boardDeps: ConstructorParameters<typeof BoardPipeline>[0];
}

/**
 * 12 条请求/通知管线的 RequestType 注册（M2：#119 dispatch 注册表化，消手写 case
 * 分发）。method = F 类判别常量同源（#109 欠账消解）；缺 handler fail-close 由
 * dispatchClientMessage 查表兜底（codec schema 已拒未知 method，此层为防御不静默）。
 * update_character_state 为通知（NotificationType，无响应语义）。
 */
const JoinGroupChatRequest = new RequestType(METHOD_JOIN_GROUP_CHAT);
const ClaimCharacterRequest = new RequestType(METHOD_CLAIM_CHARACTER);
const CharacterReadyRequest = new RequestType(METHOD_CHARACTER_READY);
const LeaveGroupChatRequest = new RequestType(METHOD_LEAVE_GROUP_CHAT);
const GetGroupChatStateRequest = new RequestType(METHOD_GET_GROUP_CHAT_STATE);
const GetMessageHistoryRequest = new RequestType(METHOD_GET_MESSAGE_HISTORY);
const FetchMessagesSinceRequest = new RequestType(METHOD_FETCH_MESSAGES_SINCE);
const GetChatHistoryFileRequest = new RequestType(METHOD_GET_CHAT_HISTORY_FILE);
const UpdateCharacterStateNotification = new NotificationType(METHOD_UPDATE_CHARACTER_STATE);
const BoardWriteRequest = new RequestType(METHOD_BOARD_WRITE);
const BoardQueryRequest = new RequestType(METHOD_BOARD_QUERY);
const SpeakRequest = new RequestType(METHOD_SPEAK);

type DispatchHandler = (
	deps: DispatchDependencies,
	socket: WebSocket,
	connection: ConnectionContext,
	message: ClientMessage,
) => Promise<void> | void;

/** 分发注册表：method → handler（注册表 key 即 method 判别保证，handler 内按需收窄）。 */
const DISPATCH_TABLE: Readonly<Record<string, DispatchHandler>> = {
	[JoinGroupChatRequest.method]: (deps, socket, connection, message) => {
		if (message.method !== METHOD_JOIN_GROUP_CHAT) {
			throw new Error(`dispatch table key mismatch: ${message.method}`);
		}
		return deps.joinPipeline.run(socket, connection, message);
	},
	[ClaimCharacterRequest.method]: (deps, socket, connection, message) => {
		if (message.method !== METHOD_CLAIM_CHARACTER) {
			throw new Error(`dispatch table key mismatch: ${message.method}`);
		}
		return new ClaimPipeline(deps.claimDeps).run(socket, connection, message);
	},
	[CharacterReadyRequest.method]: (deps, socket, connection, message) => {
		if (message.method !== METHOD_CHARACTER_READY) {
			throw new Error(`dispatch table key mismatch: ${message.method}`);
		}
		return new ReadyPipeline(deps.readyDeps).run(socket, connection, message);
	},
	[GetGroupChatStateRequest.method]: (deps, socket, connection, message) => {
		if (message.method !== METHOD_GET_GROUP_CHAT_STATE) {
			throw new Error(`dispatch table key mismatch: ${message.method}`);
		}
		return new QueryPipeline(deps.queryDeps).runGetGroupChatState(socket, connection, message);
	},
	[GetMessageHistoryRequest.method]: (deps, socket, connection, message) => {
		if (message.method !== METHOD_GET_MESSAGE_HISTORY) {
			throw new Error(`dispatch table key mismatch: ${message.method}`);
		}
		return new QueryPipeline(deps.queryDeps).runGetMessageHistory(socket, connection, message);
	},
	[FetchMessagesSinceRequest.method]: (deps, socket, connection, message) => {
		if (message.method !== METHOD_FETCH_MESSAGES_SINCE) {
			throw new Error(`dispatch table key mismatch: ${message.method}`);
		}
		return new QueryPipeline(deps.queryDeps).runFetchMessagesSince(socket, connection, message);
	},
	[GetChatHistoryFileRequest.method]: (deps, socket, connection, message) => {
		if (message.method !== METHOD_GET_CHAT_HISTORY_FILE) {
			throw new Error(`dispatch table key mismatch: ${message.method}`);
		}
		return new QueryPipeline(deps.queryDeps).runGetChatHistoryFile(socket, connection, message);
	},
	[UpdateCharacterStateNotification.method]: (deps, socket, connection, message) => {
		if (message.method !== METHOD_UPDATE_CHARACTER_STATE) {
			throw new Error(`dispatch table key mismatch: ${message.method}`);
		}
		return new QueryPipeline(deps.queryDeps).runUpdateCharacterState(connection, message.params.is_streaming);
	},
	[LeaveGroupChatRequest.method]: (deps, socket, connection, message) => {
		if (message.method !== METHOD_LEAVE_GROUP_CHAT) {
			throw new Error(`dispatch table key mismatch: ${message.method}`);
		}
		return deps.leavePipeline.run(socket, connection, message);
	},
	[SpeakRequest.method]: (deps, socket, connection, message) => {
		if (message.method !== METHOD_SPEAK) {
			throw new Error(`dispatch table key mismatch: ${message.method}`);
		}
		// 请求级管线实例（ADR：一次协议消息 = 一个管线实例；依赖面由 runtime 装配注入）
		return new SubmitMessagePipeline(deps.submitMessageDeps).runSpeak(socket, connection, message);
	},
	[BoardWriteRequest.method]: (deps, socket, connection, message) => {
		if (message.method !== METHOD_BOARD_WRITE) {
			throw new Error(`dispatch table key mismatch: ${message.method}`);
		}
		// 白板模型（#114）：请求级管线实例（outcome → 响应四态 + applied 广播 board_update）
		return new BoardPipeline(deps.boardDeps).runBoardWrite(socket, connection, message);
	},
	[BoardQueryRequest.method]: (deps, socket, connection, message) => {
		if (message.method !== METHOD_BOARD_QUERY) {
			throw new Error(`dispatch table key mismatch: ${message.method}`);
		}
		return new BoardPipeline(deps.boardDeps).runBoardQuery(socket, connection, message);
	},
};

/** 客户端消息分发（PR-B 拆自 CreatorRuntime；管线门面装配；M2 注册表化）。 */
export async function dispatchClientMessage(
	deps: DispatchDependencies,
	socket: WebSocket,
	connection: ConnectionContext,
	message: ClientMessage,
): Promise<void> {
	const handler = DISPATCH_TABLE[message.method];
	if (!handler) {
		// 缺 handler fail-close（不静默）：codec schema 已拒未知 method，此层防御兜底。
		throw new Error(`No dispatch handler for method: ${message.method}`);
	}
	return handler(deps, socket, connection, message);
}
