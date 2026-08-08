import { type MessageConnection, NotificationType, RequestType, RequestType0 } from "vscode-jsonrpc";
import type WebSocket from "ws";
import type { ClientMessage } from "../../protocol/messages.js";
import { JSONRPC_VERSION } from "../../protocol/messages.js";
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
import type { ConnectionContext } from "../connection-manager.js";
import { BoardPipeline } from "./board-pipeline.js";
import { ClaimPipeline } from "./claim-pipeline.js";
import type { JoinPipeline } from "./join-pipeline.js";
import type { LeavePipeline } from "./leave-pipeline.js";
import { QueryPipeline } from "./query-pipeline.js";
import { ReadyPipeline } from "./ready-pipeline.js";
import { SubmitMessagePipeline } from "./submit-message-pipeline.js";

/** 分发依赖面（runtime 装配注入的管线门面）。 */
interface DispatchDependencies {
	joinPipeline: JoinPipeline;
	leavePipeline: LeavePipeline;
	submitMessageDeps: ConstructorParameters<typeof SubmitMessagePipeline>[0];
	claimDeps: ConstructorParameters<typeof ClaimPipeline>[0];
	readyDeps: ConstructorParameters<typeof ReadyPipeline>[0];
	queryDeps: ConstructorParameters<typeof QueryPipeline>[0];
	boardDeps: ConstructorParameters<typeof BoardPipeline>[0];
	/** 帧处理串行链（creator runtimeTail 注入）：connection 接线后 deliver()
	 * 不 await handler promise，并发执行会破坏帧序（claim 未完成预留、
	 * ready 先跑 → RESERVATION_INVALID，A6 flake 根因）；恢复旧实现全局
	 * 串行语义（每帧解码 + 管线执行完成才处理下一帧）。 */
	enqueue: <T>(operation: () => T | Promise<T>) => Promise<T>;
}

/**
 * 12 条请求/通知管线的 RequestType 注册（M2：#119 dispatch 注册表化，消手写 case
 * 分发）。method = F 类判别常量同源（#109 欠账消解）；缺 handler fail-close 由
 * dispatchClientMessage 查表兜底（codec schema 已拒未知 method，此层为防御不静默）。
 * update_character_state 为通知（NotificationType，无响应语义）。
 */
const JoinGroupChatRequest = new RequestType(METHOD_JOIN_GROUP_CHAT);
const ClaimCharacterRequest = new RequestType(METHOD_CLAIM_CHARACTER);
// 无参请求必须用 RequestType0（v9 默认 byName 结构声明 1 参数，无 params 会被
// 库判 InvalidParams 拒绝）。
const CharacterReadyRequest = new RequestType0(METHOD_CHARACTER_READY);
const LeaveGroupChatRequest = new RequestType0(METHOD_LEAVE_GROUP_CHAT);
const GetGroupChatStateRequest = new RequestType0(METHOD_GET_GROUP_CHAT_STATE);
const GetMessageHistoryRequest = new RequestType(METHOD_GET_MESSAGE_HISTORY);
const FetchMessagesSinceRequest = new RequestType(METHOD_FETCH_MESSAGES_SINCE);
const GetChatHistoryFileRequest = new RequestType0(METHOD_GET_CHAT_HISTORY_FILE);
const UpdateCharacterStateNotification = new NotificationType(METHOD_UPDATE_CHARACTER_STATE);
const BoardWriteRequest = new RequestType(METHOD_BOARD_WRITE);
// board_query 无参（同 RequestType0 规则）。
const BoardQueryRequest = new RequestType0(METHOD_BOARD_QUERY);
const SpeakRequest = new RequestType(METHOD_SPEAK);

type DispatchHandler = (
	deps: DispatchDependencies,
	socket: WebSocket,
	connection: ConnectionContext,
	message: ClientMessage,
) => Promise<unknown> | unknown;

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
	[UpdateCharacterStateNotification.method]: (deps, _socket, connection, message) => {
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

/** 客户端消息分发（PR-B 拆自 CreatorRuntime；管线门面装配；M2 注册表化）。
 * 返回管线 result（connection 接线后由库发响应；错误 = ResponseError 传播）。 */
export async function dispatchClientMessage(
	deps: DispatchDependencies,
	socket: WebSocket,
	connection: ConnectionContext,
	message: ClientMessage,
): Promise<unknown> {
	const handler = DISPATCH_TABLE[message.method];
	if (!handler) {
		// 缺 handler fail-close（不静默）：codec schema 已拒未知 method，此层防御兜底。
		throw new Error(`No dispatch handler for method: ${message.method}`);
	}
	return handler(deps, socket, connection, message);
}

/**
 * #119 connection 接线：把 dispatch 注册表挂到 per-socket MessageConnection。
 * onRequest/onNotification 按 RequestType.method 分发（库内建关联），handler
 * 仍走 dispatchClientMessage（key-mismatch 双保险 + refreshCharacters 前置由
 * 调用方包装）。params 原样透传（管线按 message.params 访问）。
 */
export function registerJsonRpcConnection(
	deps: DispatchDependencies,
	socket: WebSocket,
	connection: ConnectionContext,
	jsonrpcConnection: MessageConnection,
	beforeRequest?: (method: string) => Promise<void> | void,
): void {
	/** 单帧分发操作（请求与通知共用）：beforeRequest 前置 + 注册表查表。 */
	const dispatchOperation = (method: string, params: unknown) => {
		return async (): Promise<unknown> => {
			await beforeRequest?.(method);
			const r = await dispatchClientMessage(deps, socket, connection, {
				jsonrpc: JSONRPC_VERSION,
				id: "",
				method,
				params: (params ?? {}) as Record<string, unknown>,
			} as ClientMessage);
			return r;
		};
	};
	/** 请求 handler：经 creator 串行链执行（帧序恢复，防并发竞态）。 */
	const requestHandler = (method: string) => {
		return (params: unknown): Promise<unknown> => deps.enqueue(dispatchOperation(method, params));
	};
	/** RequestType0（无参请求）注册包装：params 恒空对象（管线不读 params 的 method）。 */
	const requestHandler0 = (method: string) => {
		return (): Promise<unknown> => requestHandler(method)({});
	};
	jsonrpcConnection.onRequest(JoinGroupChatRequest, requestHandler(METHOD_JOIN_GROUP_CHAT));
	jsonrpcConnection.onRequest(ClaimCharacterRequest, requestHandler(METHOD_CLAIM_CHARACTER));
	jsonrpcConnection.onRequest(CharacterReadyRequest, requestHandler0(METHOD_CHARACTER_READY));
	jsonrpcConnection.onRequest(LeaveGroupChatRequest, requestHandler0(METHOD_LEAVE_GROUP_CHAT));
	jsonrpcConnection.onRequest(GetGroupChatStateRequest, requestHandler0(METHOD_GET_GROUP_CHAT_STATE));
	jsonrpcConnection.onRequest(GetMessageHistoryRequest, requestHandler(METHOD_GET_MESSAGE_HISTORY));
	jsonrpcConnection.onRequest(FetchMessagesSinceRequest, requestHandler(METHOD_FETCH_MESSAGES_SINCE));
	jsonrpcConnection.onRequest(GetChatHistoryFileRequest, requestHandler0(METHOD_GET_CHAT_HISTORY_FILE));
	jsonrpcConnection.onRequest(BoardWriteRequest, requestHandler(METHOD_BOARD_WRITE));
	jsonrpcConnection.onRequest(BoardQueryRequest, requestHandler0(METHOD_BOARD_QUERY));
	jsonrpcConnection.onRequest(SpeakRequest, requestHandler(METHOD_SPEAK));
	jsonrpcConnection.onNotification(UpdateCharacterStateNotification, (params) => {
		void deps.enqueue(dispatchOperation(METHOD_UPDATE_CHARACTER_STATE, params));
	});
}
