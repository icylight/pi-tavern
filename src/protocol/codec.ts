import { Compile } from "typebox/compile";
import type { RawData } from "ws";

import { type ClientMessage, ClientMessageSchema, type ServerMessage, ServerMessageSchema } from "./messages.js";

export const MAX_WEBSOCKET_FRAME_BYTES = 1024 * 1024;

export class ProtocolError extends Error {}

const checkClientMessage = Compile(ClientMessageSchema);
const checkServerMessage = Compile(ServerMessageSchema);

export function decodeClientMessage(data: RawData): ClientMessage {
	const value = parseJson(data);
	if (!checkClientMessage.Check(value)) {
		throw new ProtocolError("Invalid PiTavern client message");
	}
	return value;
}

export function decodeServerMessage(data: RawData): ServerMessage {
	const value = parseJson(data);
	if (!checkServerMessage.Check(value)) {
		throw new ProtocolError("Invalid PiTavern server message");
	}
	return value;
}

export function encodeMessage(message: unknown): string {
	let encoded: string;
	try {
		encoded = JSON.stringify(message);
	} catch (error) {
		throw new ProtocolError("Failed to encode PiTavern message", { cause: error });
	}
	if (Buffer.byteLength(encoded, "utf8") > MAX_WEBSOCKET_FRAME_BYTES) {
		throw new ProtocolError("PiTavern WebSocket frame exceeds 1 MiB");
	}
	return encoded;
}

function parseJson(data: RawData): unknown {
	let value: unknown;
	try {
		value = JSON.parse(rawDataToString(data));
	} catch (error) {
		throw new ProtocolError("Failed to parse PiTavern JSON", { cause: error });
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
