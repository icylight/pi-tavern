import { randomUUID } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import WebSocket from "ws";

import { type ClaimedCharacter, loadClaimedCharacter } from "../config/character-card.js";
import type { ActiveGroupChatDescriptor } from "../data/discovery/active-descriptor.js";
import { decodeServerMessage, encodeMessage, MAX_WEBSOCKET_FRAME_BYTES } from "../protocol/codec.js";
import type { CharacterSummaryWire, ServerMessage } from "../protocol/messages.js";
import { SHORT_COORDINATION_TIMEOUT_MS } from "../shared/constants.js";
import { type CharacterConnectionTransfer, CharacterRuntime } from "./character-runtime.js";

export interface JoinAttemptOptions {
	requestTimeoutMs?: number;
	onDisconnected?: () => void;
	/** 移交后的 Character 连接上的心跳检查间隔。 */
	heartbeatIntervalMs?: number;
	/** 移交后的 Character 连接上的 creator ping 超时阈值。 */
	heartbeatTimeoutMs?: number;
	/**
	 * M7 (ISSUE-012/#24)：群聊级游标文件绝对路径，转发给
	 * CharacterRuntime，让增量拉取跨重启与 reload 续接。
	 */
	cursorStorePath?: string;
	/** 闲态触发窗口（Arch 提速项，注入化；undefined = 默认 1000ms）。 */
	triggerDebounceMs?: number;
}

interface PendingRequest {
	resolve: (message: ServerMessage) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = SHORT_COORDINATION_TIMEOUT_MS;

export class JoinAttempt {
	readonly availableCharacters: CharacterSummaryWire[];

	private socket: WebSocket | null;
	private readonly bufferedMessages: ServerMessage[] = [];
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly requestTimeoutMs: number;
	private readonly onDisconnected: (() => void) | undefined;
	private readonly heartbeatIntervalMs: number | undefined;
	private readonly heartbeatTimeoutMs: number | undefined;
	private readonly cursorStorePath: string | undefined;
	private readonly triggerDebounceMs: number | undefined;
	private transferred = false;
	private closed = false;

	get isActive(): boolean {
		return !this.closed && !this.transferred && this.socket?.readyState === WebSocket.OPEN;
	}

	private readonly onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
		if (isBinary) {
			void this.closeWithError(new Error("Binary PiTavern frame received"));
			return;
		}
		let message: ServerMessage;
		try {
			message = decodeServerMessage(data);
		} catch (error) {
			void this.closeWithError(asError(error));
			return;
		}
		if (message.type === "response" && message.id !== undefined) {
			const pending = this.pendingRequests.get(message.id);
			if (pending) {
				clearTimeout(pending.timer);
				this.pendingRequests.delete(message.id);
				pending.resolve(message);
				return;
			}
		}
		this.bufferedMessages.push(message);
	};

	private readonly onClose = (): void => {
		void this.closeWithError(new Error("PiTavern join connection closed"));
	};

	private readonly onError = (): void => undefined;

	private constructor(
		private readonly descriptor: ActiveGroupChatDescriptor,
		private readonly sessionId: string,
		socket: WebSocket,
		availableCharacters: CharacterSummaryWire[],
		options: JoinAttemptOptions,
	) {
		this.socket = socket;
		this.availableCharacters = availableCharacters;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.onDisconnected = options.onDisconnected;
		this.heartbeatIntervalMs = options.heartbeatIntervalMs;
		this.heartbeatTimeoutMs = options.heartbeatTimeoutMs;
		this.cursorStorePath = options.cursorStorePath;
		this.triggerDebounceMs = options.triggerDebounceMs;
		this.socket.on("message", this.onMessage);
		this.socket.on("close", this.onClose);
		this.socket.on("error", this.onError);
	}

	static async connect(
		descriptor: ActiveGroupChatDescriptor,
		sessionId: string,
		options: JoinAttemptOptions = {},
	): Promise<JoinAttempt> {
		const socket = new WebSocket(
			`ws://${descriptor.host}:${descriptor.port}/` +
				`${encodeURIComponent(descriptor.groupChatId)}/${encodeURIComponent(descriptor.instanceId)}`,
			{ maxPayload: MAX_WEBSOCKET_FRAME_BYTES },
		);
		const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		try {
			await waitForOpen(socket, requestTimeoutMs);
			const attempt = new JoinAttempt(descriptor, sessionId, socket, [], options);
			const response = await attempt.request({
				type: "join_group_chat",
				session_id: sessionId,
				capabilities: ["decision_state_v1"],
			});
			if (response.type !== "response" || response.command !== "join_group_chat") {
				throw new Error("Unexpected PiTavern join response");
			}
			if (!response.success) {
				throw new Error(response.error);
			}
			attempt.availableCharacters.push(...response.data.available_characters);
			return attempt;
		} catch (error) {
			if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
				socket.terminate();
			}
			throw error;
		}
	}

	async claimCharacter(characterId: string, pi?: ExtensionAPI): Promise<CharacterRuntime> {
		const claimResponse = await this.request({
			type: "claim_character",
			character_id: characterId,
		});
		if (claimResponse.type !== "response" || claimResponse.command !== "claim_character") {
			throw new Error("Unexpected PiTavern Character claim response");
		}
		if (!claimResponse.success) {
			throw new Error(claimResponse.error);
		}

		try {
			const claimed = toClaimedCharacter(claimResponse.data.character);
			const character = await loadClaimedCharacter(claimed);
			const runtime = CharacterRuntime.prepare({
				groupChatId: this.descriptor.groupChatId,
				sessionId: this.sessionId,
				character,
				requestTimeoutMs: this.requestTimeoutMs,
				...(this.onDisconnected ? { onDisconnected: this.onDisconnected } : {}),
				...(this.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: this.heartbeatIntervalMs } : {}),
				...(this.heartbeatTimeoutMs !== undefined ? { heartbeatTimeoutMs: this.heartbeatTimeoutMs } : {}),
				...(this.cursorStorePath !== undefined ? { cursorStorePath: this.cursorStorePath } : {}),
				...(this.triggerDebounceMs !== undefined ? { triggerDebounceMs: this.triggerDebounceMs } : {}),
			});
			const readyResponse = await this.request({ type: "character_ready" });
			if (readyResponse.type !== "response" || readyResponse.command !== "character_ready") {
				throw new Error("Unexpected PiTavern Character ready response");
			}
			if (!readyResponse.success) {
				throw new Error(readyResponse.error);
			}
			runtime.activate(this.takeConnection(), pi);
			// ISSUE-014/#21：join 后立即拉取群聊状态快照，
			// 让 widget 马上显示真实成员数——在第一条公共消息
			// 到达之前（不再有“成员数未知”窗口期）。
			void runtime.refreshGroupChatState();
			return runtime;
		} catch (error) {
			await this.close();
			throw error;
		}
	}

	async refreshAvailableCharacters(): Promise<CharacterSummaryWire[]> {
		const response = await this.request({
			type: "join_group_chat",
			session_id: this.sessionId,
		});
		if (response.type !== "response" || response.command !== "join_group_chat") {
			throw new Error("Unexpected PiTavern join response");
		}
		if (!response.success) {
			throw new Error(response.error);
		}
		this.availableCharacters.splice(0, this.availableCharacters.length, ...response.data.available_characters);
		return this.availableCharacters;
	}

	takeConnection(): CharacterConnectionTransfer {
		if (!this.socket || this.transferred || this.closed) {
			throw new Error("JoinAttempt connection has already transferred or closed");
		}
		const socket = this.socket;
		this.socket = null;
		this.transferred = true;
		socket.off("message", this.onMessage);
		socket.off("close", this.onClose);
		socket.off("error", this.onError);
		return {
			socket,
			bufferedMessages: this.bufferedMessages.splice(0),
		};
	}

	async close(): Promise<void> {
		if (this.closed || this.transferred) {
			return;
		}
		this.closed = true;
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			socket.off("message", this.onMessage);
			socket.off("close", this.onClose);
			socket.off("error", this.onError);
			if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
				socket.terminate();
			}
		}
		this.rejectPending(new Error("PiTavern join attempt closed"));
		this.onDisconnected?.();
	}

	private request(message: Record<string, unknown>): Promise<ServerMessage> {
		const id = randomUUID();
		return new Promise<ServerMessage>((resolveRequest, rejectRequest) => {
			if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
				rejectRequest(new Error("PiTavern join connection is not open"));
				return;
			}
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				const error = new Error("PiTavern request timed out");
				rejectRequest(error);
				void this.closeWithError(error);
			}, this.requestTimeoutMs);
			this.pendingRequests.set(id, {
				resolve: resolveRequest,
				reject: rejectRequest,
				timer,
			});
			this.socket.send(encodeMessage({ ...message, id }));
		});
	}

	private async closeWithError(error: Error): Promise<void> {
		if (this.closed || this.transferred) {
			return;
		}
		await this.close();
		this.rejectPending(error);
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}
}

async function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
	await new Promise<void>((resolveOpen, rejectOpen) => {
		const timer = setTimeout(() => {
			cleanup();
			rejectOpen(new Error("PiTavern connection timed out"));
		}, timeoutMs);
		const onOpen = (): void => {
			cleanup();
			resolveOpen();
		};
		const onError = (): void => {
			cleanup();
			rejectOpen(new Error("Failed to connect to PiTavern group chat"));
		};
		const cleanup = (): void => {
			clearTimeout(timer);
			socket.off("open", onOpen);
			socket.off("error", onError);
		};
		socket.once("open", onOpen);
		socket.once("error", onError);
	});
}

function toClaimedCharacter(character: {
	character_id: string;
	name: string;
	description: string;
	path: string;
}): ClaimedCharacter {
	return {
		characterId: character.character_id,
		name: character.name,
		description: character.description,
		path: character.path,
	};
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
