import type WebSocket from "ws";
import type { WebSocketServer } from "ws";

import { decodeClientMessage } from "../protocol/codec.js";
import type { ClientMessage } from "../protocol/messages.js";
import { ERROR_BINARY_FRAMES_NOT_SUPPORTED, ERROR_GROUP_CHAT_CLOSED, ERROR_PROTOCOL } from "../shared/messages.js";

export interface ConnectionContext {
	sessionId: string | null;
	reservedCharacterId: string | null;
	online: boolean;
	readyTimer: NodeJS.Timeout | null;
	/** 事件处理器引用，供 detachForReload 换入缓冲处理器。 */
	handlers: {
		message: (data: WebSocket.RawData, isBinary: boolean) => void;
		pong: () => void;
		close: () => void;
		error: () => void;
	} | null;
}

export interface ConnectionManagerOptions {
	/** runtime 是否处于 active 生命周期（决定消息接受与错误关闭策略）。 */
	isActive: () => boolean;
	/** 运行时串行队列（socket 事件处理入队，防并发交错）。 */
	enqueue: <T>(operation: () => T | Promise<T>) => Promise<T>;
	/** 解码后的客户端消息分发（runtime 注入：管线门面）。 */
	onClientMessage: (socket: WebSocket, connection: ConnectionContext, message: ClientMessage) => Promise<void>;
	/** pong 心跳簿记（runtime 注入：HeartbeatRegistry）。 */
	onPong: (connection: ConnectionContext) => void;
	/** socket 关闭后的统一清理（runtime 注入：预留释放 + 在线角色移除）。 */
	onClosed: (connection: ConnectionContext) => void;
}

/**
 * WebSocket 连接生命周期 + 消息分发（PR-B 拆自 CreatorRuntime）。
 * 连接上下文簿记（connectionBySocket）随本类；业务处置经回调注入，不 import CreatorRuntime。
 */
export class ConnectionManager {
	private readonly options: ConnectionManagerOptions;
	private readonly connectionBySocket = new WeakMap<WebSocket, ConnectionContext>();
	private serverHandler: ((socket: WebSocket) => void) | null = null;
	private rejectHandler: ((socket: WebSocket) => void) | null = null;

	constructor(options: ConnectionManagerOptions) {
		this.options = options;
	}

	/** 安装服务器连接处理器（reload 接管后也使用）。 */
	attach(server: WebSocketServer): void {
		server.removeAllListeners("connection");
		this.rejectHandler = null;
		this.serverHandler = (socket) => this.handleConnection(socket);
		server.on("connection", this.serverHandler);
	}

	/** 拆离期间拒绝新连接（detachForReload 使用；attach 时被 removeAllListeners 清除）。 */
	reject(server: WebSocketServer): void {
		this.serverHandler = null;
		this.rejectHandler = (socket) => socket.close(1001, ERROR_GROUP_CHAT_CLOSED);
		server.on("connection", this.rejectHandler);
	}

	getConnection(socket: WebSocket): ConnectionContext | null {
		return this.connectionBySocket.get(socket) ?? null;
	}

	/** reload handoff 恢复：登记既有 socket 并绑定处理器。 */
	register(socket: WebSocket, connection: ConnectionContext): void {
		this.connectionBySocket.set(socket, connection);
		this.attachSocketHandlers(socket, connection);
	}

	detachSocketHandlers(socket: WebSocket, connection: ConnectionContext): void {
		const handlers = connection.handlers;
		connection.handlers = null;
		if (!handlers) {
			return;
		}
		socket.off("message", handlers.message);
		socket.off("pong", handlers.pong);
		socket.off("close", handlers.close);
		socket.off("error", handlers.error);
	}

	private handleConnection(socket: WebSocket): void {
		const connection: ConnectionContext = {
			sessionId: null,
			reservedCharacterId: null,
			online: false,
			readyTimer: null,
			handlers: null,
		};
		this.connectionBySocket.set(socket, connection);
		this.attachSocketHandlers(socket, connection);
	}

	private attachSocketHandlers(socket: WebSocket, connection: ConnectionContext): void {
		const handlers = {
			message: (data: WebSocket.RawData, isBinary: boolean) => {
				void this.options.enqueue(() => this.handleFrame(socket, connection, data, isBinary));
			},
			pong: () => this.handleSocketPong(connection),
			close: () => this.handleSocketClose(connection),
			error: () => undefined,
		};
		connection.handlers = handlers;
		socket.on("message", handlers.message);
		socket.on("pong", handlers.pong);
		socket.on("close", handlers.close);
		socket.on("error", handlers.error);
	}

	/** 处理一帧（reload 窗口回放与实时消息同路径）。 */
	async handleFrame(
		socket: WebSocket,
		connection: ConnectionContext,
		data: WebSocket.RawData,
		isBinary: boolean,
	): Promise<void> {
		if (isBinary) {
			socket.close(1002, ERROR_BINARY_FRAMES_NOT_SUPPORTED);
			return;
		}
		if (!this.options.isActive()) {
			socket.close(1001, ERROR_GROUP_CHAT_CLOSED);
			return;
		}
		let message: ClientMessage;
		try {
			message = decodeClientMessage(data);
		} catch {
			socket.close(1002, ERROR_PROTOCOL);
			return;
		}
		try {
			await this.options.onClientMessage(socket, connection, message);
		} catch (error) {
			if (this.options.isActive()) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				socket.close(1011, errorMessage);
			}
		}
	}

	private handleSocketPong(connection: ConnectionContext): void {
		this.options.onPong(connection);
	}

	private handleSocketClose(connection: ConnectionContext): void {
		void this.options.enqueue(() => {
			this.options.onClosed(connection);
		});
	}
}
