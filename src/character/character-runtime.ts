import { randomUUID } from "node:crypto";

import WebSocket from "ws";

import type { CharacterCard } from "../config/character-card.js";
import { decodeServerMessage, encodeMessage, MAX_WEBSOCKET_FRAME_BYTES } from "../protocol/codec.js";
import type { GroupChatStateMessage, ServerMessage } from "../protocol/messages.js";

export interface CharacterConnectionTransfer {
	socket: WebSocket;
	bufferedMessages: ServerMessage[];
}

export interface PrepareCharacterRuntimeOptions {
	groupChatId: string;
	sessionId: string;
	character: CharacterCard;
	requestTimeoutMs?: number;
	onDisconnected?: () => void;
}

interface PendingRequest {
	resolve: (message: ServerMessage) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export class CharacterRuntime {
	readonly groupChatId: string;
	readonly sessionId: string;
	readonly character: CharacterCard;
	readonly receivedMessages: ServerMessage[] = [];

	private socket: WebSocket | null = null;
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly requestTimeoutMs: number;
	private readonly onDisconnected: (() => void) | undefined;
	private closePromise: Promise<void> | null = null;
	private disconnected = false;

	private readonly onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
		if (isBinary) {
			this.failConnection(new Error("Binary PiTavern frame received"));
			return;
		}
		let message: ServerMessage;
		try {
			message = decodeServerMessage(data);
		} catch (error) {
			this.failConnection(asError(error));
			return;
		}
		this.handleServerMessage(message);
	};

	private readonly onClose = (): void => {
		this.finishDisconnected(new Error("PiTavern connection closed"));
	};

	private readonly onError = (): void => undefined;

	private constructor(options: PrepareCharacterRuntimeOptions) {
		this.groupChatId = options.groupChatId;
		this.sessionId = options.sessionId;
		this.character = options.character;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.onDisconnected = options.onDisconnected;
	}

	static prepare(options: PrepareCharacterRuntimeOptions): CharacterRuntime {
		return new CharacterRuntime(options);
	}

	activate(transfer: CharacterConnectionTransfer): void {
		if (this.socket || this.disconnected) {
			throw new Error("CharacterRuntime has already been activated or disposed");
		}
		this.socket = transfer.socket;
		this.socket.on("message", this.onMessage);
		this.socket.on("close", this.onClose);
		this.socket.on("error", this.onError);
		for (const message of transfer.bufferedMessages) {
			this.handleServerMessage(message);
		}
	}

	async getGroupChatState(): Promise<GroupChatStateMessage> {
		const response = await this.request({ type: "get_group_chat_state" });
		if (response.type !== "response" || response.command !== "get_group_chat_state") {
			throw new Error("Unexpected PiTavern state response");
		}
		if (!response.success) {
			throw new Error(response.error);
		}
		return response.data;
	}

	updateStreaming(isStreaming: boolean): void {
		this.send({
			type: "update_character_state",
			is_streaming: isStreaming,
		});
	}

	async speak(content: string): Promise<{
		published: boolean;
		eventId?: string;
		sequence?: number;
		reason?: string;
		handRaised?: boolean;
		round?: { roundMaxMessages: number; usedMessages: number; remainingMessages: number };
	}> {
		const response = await this.request({ type: "speak", content });
		if (response.type !== "response" || response.command !== "speak") {
			throw new Error("Unexpected PiTavern speak response");
		}
		if (!response.success) {
			throw new Error(response.error);
		}
		return {
			published: response.data.published,
			...(response.data.published
				? {
						eventId: response.data.event_id,
						sequence: response.data.sequence,
					}
				: {
						reason: response.data.reason,
						handRaised: response.data.hand_raised,
					}),
			round: {
				roundMaxMessages: response.data.round.round_max_messages,
				usedMessages: response.data.round.used_messages,
				remainingMessages: response.data.round.remaining_messages,
			},
		};
	}

	close(): Promise<void> {
		this.closePromise ??= this.closePermanently();
		return this.closePromise;
	}

	private async closePermanently(): Promise<void> {
		if (!this.socket || this.disconnected) {
			this.finishDisconnected();
			return;
		}
		try {
			const response = await this.request({ type: "leave_group_chat" });
			if (response.type !== "response" || response.command !== "leave_group_chat" || !response.success) {
				throw new Error(
					response.type === "response" && !response.success ? response.error : "Unexpected PiTavern leave response",
				);
			}
		} finally {
			this.finishDisconnected();
		}
	}

	private request(message: Record<string, unknown>): Promise<ServerMessage> {
		const id = randomUUID();
		return new Promise<ServerMessage>((resolveRequest, rejectRequest) => {
			if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
				rejectRequest(new Error("PiTavern connection is not open"));
				return;
			}
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				const error = new Error("PiTavern request timed out");
				rejectRequest(error);
				this.failConnection(error);
			}, this.requestTimeoutMs);
			this.pendingRequests.set(id, {
				resolve: resolveRequest,
				reject: rejectRequest,
				timer,
			});
			this.send({ ...message, id });
		});
	}

	private send(message: unknown): void {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			throw new Error("PiTavern connection is not open");
		}
		const encoded = encodeMessage(message);
		if (Buffer.byteLength(encoded, "utf8") > MAX_WEBSOCKET_FRAME_BYTES) {
			throw new Error("PiTavern frame exceeds 1 MiB");
		}
		this.socket.send(encoded);
	}

	private handleServerMessage(message: ServerMessage): void {
		if (message.type === "response" && message.id !== undefined) {
			const pending = this.pendingRequests.get(message.id);
			if (pending) {
				clearTimeout(pending.timer);
				this.pendingRequests.delete(message.id);
				pending.resolve(message);
				return;
			}
		}

		this.receivedMessages.push(message);
		if (message.type === "group_chat_closed") {
			this.finishDisconnected();
		}
	}

	private failConnection(error: Error): void {
		const socket = this.socket;
		if (socket && socket.readyState !== WebSocket.CLOSED) {
			socket.terminate();
		}
		this.finishDisconnected(error);
	}

	private finishDisconnected(error?: Error): void {
		if (this.disconnected) {
			return;
		}
		this.disconnected = true;
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			socket.off("message", this.onMessage);
			socket.off("close", this.onClose);
			socket.off("error", this.onError);
			if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
				socket.close();
			}
		}
		const disconnectError = error ?? new Error("PiTavern connection has been closed");
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(disconnectError);
		}
		this.pendingRequests.clear();
		this.onDisconnected?.();
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
