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
	ERROR_UNEXPECTED_WHISPER_RESPONSE,
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

/** vscode-jsonrpc dispose() 拒绝 pending 的本地错误码（PENDING_RESPONSE_REJECTED）。 */
export const PENDING_RESPONSE_REJECTED_CODE = -32097;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * 响应 result 形状判别（#137 阻断② fail-close）：JSON-RPC 响应无 method，库
 * sendRequest 只按 id 关联、不校验 result 形状——同 id 错 result（board_query
 * result 冒充 speak 等）必须 fail-close，不能 resolve 成错误形状让调用方踩
 * undefined/运行时异常。方法在 request() 调用点已知，故校验在解析时执行
 * （#139 方案 B：feed 前拦截 + id→method 关联表删除，语义等价）。
 */
const RESPONSE_RESULT_MATCHERS: Record<string, (result: unknown) => boolean> = {
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
	// #152：whisper 三态（published / stale / round_limit_reached，与 speak 同构
	// ——published 字面量判别；复用语义核对表第 1 轮即补齐，防漏注册）。
	// PR #163 评审阻断 4 收紧：不仅判别字段，还验证 runtime 随后会读取的必需
	// 字段及基本类型（published: sequence 正整数 + round；stale: missing_sequences
	// 数值对 + round；round_limit: hand_raised === true + round）——畸形帧 fail-close
	// 抛 ERROR_UNEXPECTED_WHISPER_RESPONSE，而非进 runtime 后 TypeError。
	[METHOD_WHISPER]: (result) => {
		if (!isRecord(result)) return false;
		const roundOk = (r: unknown): boolean =>
			isRecord(r) && typeof r.round_max_messages === "number" && typeof r.used_messages === "number";
		if (result.published === true) {
			return (
				typeof result.sequence === "number" &&
				Number.isInteger(result.sequence) &&
				result.sequence > 0 &&
				roundOk(result.round)
			);
		}
		if (result.published === false && result.reason === "stale") {
			return (
				isRecord(result.missing_sequences) &&
				typeof result.missing_sequences.from === "number" &&
				typeof result.missing_sequences.to === "number" &&
				roundOk(result.round)
			);
		}
		if (result.published === false && result.reason === "round_limit_reached") {
			return result.hand_raised === true && roundOk(result.round);
		}
		return false;
	},
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
	[METHOD_WHISPER]: ERROR_UNEXPECTED_WHISPER_RESPONSE,
};

/**
 * 解析时形状校验（#139 方案 B：替代 ResponseCorrelator feed 前拦截）。
 * 返回 null = 形状匹配（正常 resolve）；返回 Error = 协议错位 fail-close
 * （调用方以 ERROR_UNEXPECTED_* reject + 断链，不悬挂不静默）。
 */
export function validateResult(method: string, result: unknown): Error | null {
	const matched = RESPONSE_RESULT_MATCHERS[method]?.(result) ?? false;
	if (!matched) {
		return new Error(RESPONSE_METHOD_ERRORS[method] ?? ERROR_UNEXPECTED_STATE_RESPONSE);
	}
	return null;
}
