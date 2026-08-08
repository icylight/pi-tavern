import type { ServerMessage } from "../protocol/messages.js";
import {
	ERROR_UNEXPECTED_BOARD_QUERY_RESPONSE,
	ERROR_UNEXPECTED_BOARD_WRITE_RESPONSE,
	ERROR_UNEXPECTED_CHAT_HISTORY_FILE_RESPONSE,
	ERROR_UNEXPECTED_CLAIM_RESPONSE,
	ERROR_UNEXPECTED_FETCH_RESPONSE,
	ERROR_UNEXPECTED_HISTORY_RESPONSE,
	ERROR_UNEXPECTED_JOIN_RESPONSE,
	ERROR_UNEXPECTED_LEAVE_RESPONSE,
	ERROR_UNEXPECTED_READY_RESPONSE,
	ERROR_UNEXPECTED_SPEAK_RESPONSE,
	ERROR_UNEXPECTED_STATE_RESPONSE,
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
} from "../shared/messages.js";

/** vscode-jsonrpc dispose() 拒绝 pending 的本地错误码（PENDING_RESPONSE_REJECTED）。 */
export const PENDING_RESPONSE_REJECTED_CODE = -32097;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * 响应 result 形状判别（feed 前校验）：JSON-RPC response 无 method，库只按 id
 * 关联——同 id 错 result（board_query result 冒充 speak 等）必须 fail-close，
 * 不能 resolve 成错误形状让调用方踩 undefined/运行时异常。
 */
export const RESPONSE_RESULT_MATCHERS: Record<string, (result: unknown) => boolean> = {
	[METHOD_JOIN_GROUP_CHAT]: (result) => isRecord(result) && "available_characters" in result,
	[METHOD_CLAIM_CHARACTER]: (result) => isRecord(result) && "character" in result,
	[METHOD_CHARACTER_READY]: (result) =>
		result === null || (isRecord(result) && typeof result.latest_sequence === "number"),
	[METHOD_LEAVE_GROUP_CHAT]: (result) => result === null,
	[METHOD_GET_GROUP_CHAT_STATE]: (result) => isRecord(result) && "group_chat" in result,
	[METHOD_GET_MESSAGE_HISTORY]: (result) => isRecord(result) && "messages" in result && "has_more" in result,
	[METHOD_FETCH_MESSAGES_SINCE]: (result) => isRecord(result) && "messages" in result && "latest_sequence" in result,
	[METHOD_GET_CHAT_HISTORY_FILE]: (result) => isRecord(result) && "path" in result,
	[METHOD_BOARD_WRITE]: (result) => isRecord(result) && ("changed" in result || "code" in result || "note" in result),
	[METHOD_BOARD_QUERY]: (result) => isRecord(result) && "boards" in result,
	[METHOD_SPEAK]: (result) => isRecord(result) && "published" in result,
};

/** method → fail-close 错误文案（与 JoinAttempt 旧 RESPONSE_METHOD_ERRORS 同源）。 */
const RESPONSE_METHOD_ERRORS: Record<string, string> = {
	[METHOD_JOIN_GROUP_CHAT]: ERROR_UNEXPECTED_JOIN_RESPONSE,
	[METHOD_CLAIM_CHARACTER]: ERROR_UNEXPECTED_CLAIM_RESPONSE,
	[METHOD_CHARACTER_READY]: ERROR_UNEXPECTED_READY_RESPONSE,
	[METHOD_LEAVE_GROUP_CHAT]: ERROR_UNEXPECTED_LEAVE_RESPONSE,
	[METHOD_GET_GROUP_CHAT_STATE]: ERROR_UNEXPECTED_STATE_RESPONSE,
	[METHOD_GET_MESSAGE_HISTORY]: ERROR_UNEXPECTED_HISTORY_RESPONSE,
	[METHOD_FETCH_MESSAGES_SINCE]: ERROR_UNEXPECTED_FETCH_RESPONSE,
	[METHOD_GET_CHAT_HISTORY_FILE]: ERROR_UNEXPECTED_CHAT_HISTORY_FILE_RESPONSE,
	[METHOD_BOARD_WRITE]: ERROR_UNEXPECTED_BOARD_WRITE_RESPONSE,
	[METHOD_BOARD_QUERY]: ERROR_UNEXPECTED_BOARD_QUERY_RESPONSE,
	[METHOD_SPEAK]: ERROR_UNEXPECTED_SPEAK_RESPONSE,
};

/**
 * 请求 id → method 精确关联 + 响应 result 形状校验（feed 前 gate，owner =
 * JoinAttempt / CharacterRuntime 共用）。
 *
 * 精确关联：并发同 method 多请求互不干扰（T2 livelock 教训——集合近似在
 * 并发同 method 场景第一个 resolve 后清空 → 后续响应全丢 → pending 悬挂）。
 *
 * 丢弃决策 = 数据面操作，只允许精确关联：未知 id 响应（旧代际迟到帧）→ 喂
 * 库由库丢弃或结算旧 pending，不静默丢弃不误杀（连接跨 handoff 延续后 id
 * 单调，旧响应不可能撞新请求）。
 */
export class ResponseCorrelator {
	private readonly pendingMethodById = new Map<string | number, string>();

	/** writer 请求写出时登记（id → method）。 */
	register(id: string | number, method: string): void {
		this.pendingMethodById.set(id, method);
	}

	/** 响应已喂库（消费即删，防表膨胀；重复帧由库丢弃）。 */
	consume(id: string | number): void {
		this.pendingMethodById.delete(id);
	}

	clear(): void {
		this.pendingMethodById.clear();
	}

	/**
	 * 响应 gate：返回 null = 可喂 connection（正常路径）；返回 Error = 协议
	 * 错位 fail-close——喂入之前必须按 error 关闭连接（库内 pending 经
	 * dispose 立即拒绝，请求方拿到 ERROR_UNEXPECTED_*，不悬挂不静默）。
	 */
	gate(message: ServerMessage): Error | null {
		if (!("result" in message) || "error" in message) {
			// error 响应自描述（业务码 + 库标准码），无条件喂库。
			return null;
		}
		const expectedMethod = this.pendingMethodById.get(message.id);
		if (expectedMethod === undefined) {
			// 未知 id（旧代际迟到响应或服务端异常帧）：喂库——库按 id 找
			// pending（旧代际 = 结算死 pending；无 pending = 静默丢弃）。
			return null;
		}
		const matched = RESPONSE_RESULT_MATCHERS[expectedMethod]?.(message.result) ?? false;
		if (!matched) {
			return new Error(RESPONSE_METHOD_ERRORS[expectedMethod] ?? ERROR_UNEXPECTED_STATE_RESPONSE);
		}
		return null;
	}
}
