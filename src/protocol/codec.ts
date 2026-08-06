import { Compile } from "typebox/compile";
import type { Message } from "vscode-jsonrpc";
import type { RawData } from "ws";
import {
	ERROR_ENCODE_FAILED,
	ERROR_INVALID_CLIENT_MESSAGE,
	ERROR_INVALID_SERVER_MESSAGE,
	ERROR_PARSE_JSON_FAILED,
	ERROR_WS_FRAME_TOO_LARGE,
} from "../shared/messages.js";
import { type ClientMessage, ClientMessageSchema, type ServerMessage, ServerMessageSchema } from "./messages.js";

export const MAX_WEBSOCKET_FRAME_BYTES = 1024 * 1024;

export class ProtocolError extends Error {}

const checkClientMessage = Compile(ClientMessageSchema);
const checkServerMessage = Compile(ServerMessageSchema);

/**
 * 解码客户端消息（#119 M1：JSON-RPC 2.0 标准信封）。
 * 信封层校验：JSON 解析 → vscode-jsonrpc Message 骨架 → TypeBox 判别结构
 * （method 判别 + params 形状 + 10 码业务枚举收窄，未知 code fail-close）。
 */
export function decodeClientMessage(data: RawData): ClientMessage {
	const value = parseJson(data);
	if (!isMessageEnvelope(value)) {
		throw new ProtocolError(ERROR_INVALID_CLIENT_MESSAGE);
	}
	if (!checkClientMessage.Check(value)) {
		throw new ProtocolError(ERROR_INVALID_CLIENT_MESSAGE);
	}
	return value;
}

export function decodeServerMessage(data: RawData): ServerMessage {
	const value = parseJson(data);
	if (!isMessageEnvelope(value)) {
		throw new ProtocolError(ERROR_INVALID_SERVER_MESSAGE);
	}
	if (!checkServerMessage.Check(value)) {
		throw new ProtocolError(ERROR_INVALID_SERVER_MESSAGE);
	}
	return value;
}

export function encodeMessage(message: unknown): string {
	let encoded: string;
	try {
		encoded = JSON.stringify(message);
	} catch (error) {
		throw new ProtocolError(ERROR_ENCODE_FAILED, { cause: error });
	}
	if (Buffer.byteLength(encoded, "utf8") > MAX_WEBSOCKET_FRAME_BYTES) {
		throw new ProtocolError(ERROR_WS_FRAME_TOO_LARGE);
	}
	return encoded;
}

/** id 合法性：JSON-RPC 2.0 标准 string | number（vscode-jsonrpc 库 sendRequest 自增数字 id）。 */
function isId(value: unknown): boolean {
	return value === undefined || typeof value === "string" || typeof value === "number";
}

/** 信封骨架校验：jsonrpc"2.0" 必带 + method 或 id/result/error 判别形状。 */
function isMessageEnvelope(value: unknown): value is Message {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	if (record["jsonrpc"] !== "2.0") {
		return false;
	}
	if (typeof record["method"] === "string") {
		// 请求或通知：id 可选（string|number），params 可选
		return isId(record["id"]);
	}
	// 响应：id（可选）+ result 或 error 二选一
	const hasResult = "result" in record;
	const hasError = "error" in record;
	if (hasResult === hasError) {
		return false;
	}
	return isId(record["id"]);
}

function parseJson(data: RawData): unknown {
	let value: unknown;
	try {
		value = JSON.parse(rawDataToString(data));
	} catch (error) {
		throw new ProtocolError(ERROR_PARSE_JSON_FAILED, { cause: error });
	}
	return value;
}

function rawDataToString(data: RawData): string {
	if (Buffer.isBuffer(data)) {
		return data.toString("utf8");
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data).toString("utf8");
	}
	if (Array.isArray(data)) {
		return Buffer.concat(data).toString("utf8");
	}
	return Buffer.from(data).toString("utf8");
}
