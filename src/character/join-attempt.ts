import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMessageConnection, type MessageConnection, ResponseError } from "vscode-jsonrpc";
import WebSocket from "ws";

import { type ClaimedCharacter, loadClaimedCharacter } from "../config/character-card.js";
import type { ActiveGroupChatDescriptor } from "../data/discovery/active-descriptor.js";
import { decodeServerMessage, MAX_WEBSOCKET_FRAME_BYTES } from "../protocol/codec.js";
import { type CharacterSummaryWire, JSONRPC_VERSION, type ServerMessage } from "../protocol/messages.js";
import { WebSocketMessageReader, WebSocketMessageWriter } from "../protocol/ws-message-io.js";
import { SHORT_COORDINATION_TIMEOUT_MS } from "../shared/constants.js";
import {
	ERROR_BINARY_FRAME_RECEIVED,
	ERROR_CONNECT_FAILED,
	ERROR_CONNECTION_HAS_BEEN_CLOSED,
	ERROR_CONNECTION_TIMED_OUT,
	ERROR_JOIN_ATTEMPT_TRANSFERRED,
	ERROR_JOIN_CONNECTION_CLOSED,
	ERROR_JOIN_CONNECTION_NOT_OPEN,
	ERROR_REQUEST_TIMED_OUT,
	ERROR_UNEXPECTED_CLAIM_RESPONSE,
	ERROR_UNEXPECTED_JOIN_RESPONSE,
	ERROR_UNEXPECTED_READY_RESPONSE,
	METHOD_CHARACTER_READY,
	METHOD_CLAIM_CHARACTER,
	METHOD_JOIN_GROUP_CHAT,
} from "../shared/messages.js";
import { type CharacterConnectionTransfer, CharacterRuntime } from "./character-runtime.js";
import { CHARACTER_REQUEST_TYPES } from "./request-types.js";
import { PENDING_RESPONSE_REJECTED_CODE, ResponseCorrelator } from "./response-gate.js";

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
	/** #138：增量拉取上下文窗口 getter（getter 闭包，每轮实时取值），转发给 CharacterRuntime。 */
	getFetchContextWindow?: () => number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = SHORT_COORDINATION_TIMEOUT_MS;

/**
 * join 三阶段握手（#119 #139 完整迁移）：join/claim/ready 经 vscode-jsonrpc
 * connection 发送（库内建 id 关联/超时取消），手工 pending/matcher 由
 * RequestManager 替代；响应 feed 前仍走 ResponseCorrelator 形状 gate——
 * 同 id 错 result fail-close（与 CharacterRuntime 同机制，阻断②回归保持）。
 */
export class JoinAttempt {
	readonly availableCharacters: CharacterSummaryWire[];

	private socket: WebSocket | null;
	private readonly bufferedMessages: ServerMessage[] = [];
	/** 请求 id → method 精确关联 + 形状校验（feed 前 gate，fail-close）。 */
	private readonly responseCorrelator = new ResponseCorrelator();
	private jsonrpcConnection: MessageConnection | null = null;
	private jsonrpcReader: WebSocketMessageReader | null = null;
	private jsonrpcWriter: WebSocketMessageWriter | null = null;
	/** 关闭原因（request() 映射库 dispose 拒绝码 -32097 → 以关闭原因 reject）。 */
	private closeError: Error | undefined;
	private readonly requestTimeoutMs: number;
	private readonly onDisconnected: (() => void) | undefined;
	private readonly heartbeatIntervalMs: number | undefined;
	private readonly heartbeatTimeoutMs: number | undefined;
	private readonly cursorStorePath: string | undefined;
	private readonly triggerDebounceMs: number | undefined;
	private readonly getFetchContextWindow: (() => number) | undefined;
	private transferred = false;
	private closed = false;

	get isActive(): boolean {
		return !this.closed && !this.transferred && this.socket?.readyState === WebSocket.OPEN;
	}

	private readonly onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
		if (isBinary) {
			void this.closeWithError(new Error(ERROR_BINARY_FRAME_RECEIVED));
			return;
		}
		let message: ServerMessage;
		try {
			message = decodeServerMessage(data);
		} catch (error) {
			void this.closeWithError(asError(error));
			return;
		}
		if (("result" in message || "error" in message) && message.id !== undefined) {
			// feed 前 gate：同 id 错 result 形状 = 协议错位 fail-close（立即拒绝 +
			// 关闭，不悬挂）；error 自描述、未知 id 响应 → 喂库（库按 id 结算或丢弃）。
			const failCloseError = this.responseCorrelator.gate(message);
			if (failCloseError) {
				void this.closeWithError(failCloseError);
				return;
			}
			this.responseCorrelator.consume(message.id);
			this.jsonrpcReader?.deliver(message);
			return;
		}
		this.bufferedMessages.push(message);
	};

	private readonly onClose = (): void => {
		void this.closeWithError(new Error(ERROR_JOIN_CONNECTION_CLOSED));
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
		this.getFetchContextWindow = options.getFetchContextWindow;
		this.socket.on("message", this.onMessage);
		this.socket.on("close", this.onClose);
		this.socket.on("error", this.onError);
		// #119 connection 接线：握手连接实例随 takeConnection 移交 runtime 延续
		// （不重建 = 库内序列单调，代际 id 不撞车）。
		const reader = new WebSocketMessageReader();
		const writer = new WebSocketMessageWriter(socket);
		writer.setRequestWrittenHandler((id, method) => this.responseCorrelator.register(id, method));
		const jsonrpcConnection = createMessageConnection(reader, writer);
		this.jsonrpcConnection = jsonrpcConnection;
		this.jsonrpcReader = reader;
		this.jsonrpcWriter = writer;
		jsonrpcConnection.listen();
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
				method: METHOD_JOIN_GROUP_CHAT,
				params: { session_id: sessionId },
			});
			if ("error" in response) {
				throw new Error(response.error.message);
			}
			if (!("result" in response)) {
				throw new Error(ERROR_UNEXPECTED_JOIN_RESPONSE);
			}
			attempt.availableCharacters.push(
				...(response.result as { available_characters: CharacterSummaryWire[] }).available_characters,
			);
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
			method: METHOD_CLAIM_CHARACTER,
			params: { character_id: characterId },
		});
		if ("error" in claimResponse) {
			throw new Error(claimResponse.error.message);
		}
		if (!("result" in claimResponse)) {
			throw new Error(ERROR_UNEXPECTED_CLAIM_RESPONSE);
		}

		try {
			const claimed = toClaimedCharacter(
				(
					claimResponse.result as {
						character: { character_id: string; name: string; description: string; path: string };
					}
				).character,
			);
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
				...(this.getFetchContextWindow !== undefined ? { getFetchContextWindow: this.getFetchContextWindow } : {}),
			});
			const readyResponse = await this.request({ method: METHOD_CHARACTER_READY, params: {} });
			if ("error" in readyResponse) {
				throw new Error(readyResponse.error.message);
			}
			if (!("result" in readyResponse)) {
				throw new Error(ERROR_UNEXPECTED_READY_RESPONSE);
			}
			// P1-4 方案 a：ready 响应携带进入时刻水位（latest_sequence，新帧 Optional）——
			// 游标预置精确锚点（误差窗口归零）；旧帧 result=null 保持 readyLatestSequence=null
			// → GroupChatInput 回退查询预置（双路径兼容）。
			if (
				readyResponse.result !== null &&
				typeof (readyResponse.result as { latest_sequence?: unknown }).latest_sequence === "number"
			) {
				runtime.readyLatestSequence = (readyResponse.result as { latest_sequence: number }).latest_sequence;
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
			method: METHOD_JOIN_GROUP_CHAT,
			params: { session_id: this.sessionId },
		});
		if ("error" in response) {
			throw new Error(response.error.message);
		}
		if (!("result" in response)) {
			throw new Error(ERROR_UNEXPECTED_JOIN_RESPONSE);
		}
		this.availableCharacters.splice(
			0,
			this.availableCharacters.length,
			...(response.result as { available_characters: CharacterSummaryWire[] }).available_characters,
		);
		return this.availableCharacters;
	}

	takeConnection(): CharacterConnectionTransfer {
		if (!this.socket || this.transferred || this.closed) {
			throw new Error(ERROR_JOIN_ATTEMPT_TRANSFERRED);
		}
		const socket = this.socket;
		this.socket = null;
		this.transferred = true;
		socket.off("message", this.onMessage);
		socket.off("close", this.onClose);
		socket.off("error", this.onError);
		const transfer: CharacterConnectionTransfer = {
			socket,
			bufferedMessages: this.bufferedMessages.splice(0),
		};
		// #119 connection 延续：握手连接随移交（runtime adoptJsonRpc 接管，
		// 序列单调——旧代际响应撞不上新请求 id）。
		if (this.jsonrpcConnection && this.jsonrpcReader && this.jsonrpcWriter) {
			transfer.jsonrpc = {
				connection: this.jsonrpcConnection,
				reader: this.jsonrpcReader,
				writer: this.jsonrpcWriter,
			};
			this.jsonrpcConnection = null;
			this.jsonrpcReader = null;
			this.jsonrpcWriter = null;
		}
		return transfer;
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
		this.responseCorrelator.clear();
		// 断线终态 dispose connection：库内 pending 立即拒绝（-32097 →
		// request 映射 closeError 收敛，不悬挂到超时）。
		const jsonrpcConnection = this.jsonrpcConnection;
		this.jsonrpcConnection = null;
		this.jsonrpcReader = null;
		this.jsonrpcWriter = null;
		jsonrpcConnection?.dispose();
		this.onDisconnected?.();
	}

	/** #119 connection 接线：sendRequest 替代手写 pending（响应关联/取消由库承担）。
	 * 超时语义保留（Promise.race + closeWithError）；ResponseError 包装回
	 * {error:{code,message}} 响应形状——调用方 `"error" in response` 判别语法不变。 */
	private request(message: { method: string; params: unknown }): Promise<ServerMessage> {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error(ERROR_JOIN_CONNECTION_NOT_OPEN));
		}
		const type = CHARACTER_REQUEST_TYPES[message.method];
		if (!type || !this.jsonrpcConnection) {
			return Promise.reject(new Error(`No request type for method: ${message.method}`));
		}
		const pending = (this.jsonrpcConnection as MessageConnection).sendRequest(type as never, message.params as never);
		const withTimeout = new Promise<unknown>((resolveRequest, rejectRequest) => {
			const timer = setTimeout(() => {
				const error = new Error(ERROR_REQUEST_TIMED_OUT);
				rejectRequest(error);
				void this.closeWithError(error);
			}, this.requestTimeoutMs);
			timer.unref?.();
			void pending.then(
				(result) => {
					clearTimeout(timer);
					resolveRequest(result);
				},
				(error) => {
					clearTimeout(timer);
					rejectRequest(error);
				},
			);
		});
		return withTimeout.then(
			(result) => {
				return { jsonrpc: JSONRPC_VERSION, id: "", result } as ServerMessage;
			},
			(error) => {
				if (error instanceof ResponseError && error.code === PENDING_RESPONSE_REJECTED_CODE) {
					// 关闭 dispose 的库内拒绝（-32097）：以关闭原因立即 reject。
					return Promise.reject(this.closeError ?? new Error(ERROR_CONNECTION_HAS_BEEN_CLOSED));
				}
				if (error instanceof ResponseError) {
					return {
						jsonrpc: JSONRPC_VERSION,
						id: "",
						error: { code: error.code, message: error.message },
					} as ServerMessage;
				}
				return Promise.reject(error);
			},
		);
	}

	private async closeWithError(error: Error): Promise<void> {
		if (this.closed || this.transferred) {
			return;
		}
		this.closeError = error;
		await this.close();
	}
}

async function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
	await new Promise<void>((resolveOpen, rejectOpen) => {
		const timer = setTimeout(() => {
			cleanup();
			rejectOpen(new Error(ERROR_CONNECTION_TIMED_OUT));
		}, timeoutMs);
		const onOpen = (): void => {
			cleanup();
			resolveOpen();
		};
		const onError = (): void => {
			cleanup();
			rejectOpen(new Error(ERROR_CONNECT_FAILED));
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
