import { RequestType, RequestType0 } from "vscode-jsonrpc";

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
	METHOD_WHISPER,
} from "../shared/messages.js";

/**
 *  connection 接线：character 侧请求类型注册表（method 与 creator dispatch
 * 注册表同源 F 常量；库按 id 关联响应）。JoinAttempt（join/claim/ready 三握手）
 * 与 CharacterRuntime（运行期 11 类）共用同一注册表——同一连接跨握手/运行期
 * 延续（connection 实例 + 序列跨 handoff 单调，代际 id 不撞车）。
 */
export const CHARACTER_REQUEST_TYPES: Record<
	string,
	RequestType0<unknown, unknown> | RequestType<unknown, unknown, unknown>
> = {
	[METHOD_JOIN_GROUP_CHAT]: new RequestType(METHOD_JOIN_GROUP_CHAT),
	[METHOD_CLAIM_CHARACTER]: new RequestType(METHOD_CLAIM_CHARACTER),
	[METHOD_CHARACTER_READY]: new RequestType0(METHOD_CHARACTER_READY),
	[METHOD_LEAVE_GROUP_CHAT]: new RequestType0(METHOD_LEAVE_GROUP_CHAT),
	[METHOD_GET_GROUP_CHAT_STATE]: new RequestType0(METHOD_GET_GROUP_CHAT_STATE),
	[METHOD_GET_MESSAGE_HISTORY]: new RequestType(METHOD_GET_MESSAGE_HISTORY),
	[METHOD_FETCH_MESSAGES_SINCE]: new RequestType(METHOD_FETCH_MESSAGES_SINCE),
	[METHOD_GET_CHAT_HISTORY_FILE]: new RequestType0(METHOD_GET_CHAT_HISTORY_FILE),
	[METHOD_BOARD_WRITE]: new RequestType(METHOD_BOARD_WRITE),
	[METHOD_BOARD_QUERY]: new RequestType0(METHOD_BOARD_QUERY),
	[METHOD_SPEAK]: new RequestType(METHOD_SPEAK),
	[METHOD_WHISPER]: new RequestType(METHOD_WHISPER),
};
