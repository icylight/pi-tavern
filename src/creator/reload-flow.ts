import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type WebSocket from "ws";
import type { WebSocketServer } from "ws";

import type { CharacterCard } from "../config/character-card.js";
import type { CreatorReloadHandoff } from "../controller/reload-handoff-registry.js";
import { getReloadHandoffRegistry } from "../controller/reload-handoff-registry.js";
import type { BoardStore } from "../data/board-store.js";
import type { ActiveGroupChatDescriptor } from "../data/discovery/active-descriptor.js";
import { removeOwnedActiveDescriptor } from "../data/discovery/active-descriptor.js";
import type { GroupChatState } from "../data/group-chat-state.js";
import type { SessionStore } from "../data/session-store.js";
import type { PublicMessageState } from "../protocol/public-message-state.js";
import type { ConnectionContext, ConnectionManager } from "./connection-manager.js";
import { createFromHandoff } from "./creator-factory.js";
import type { CreatorRuntime, CreatorRuntimeDependencies } from "./creator-runtime.js";
import type { HeartbeatRegistry } from "./heartbeat-registry.js";
import { closeWebSocketServer } from "./ws-utils.js";

/** reload 流程访问的骨架窄接口（结构类型；模块不 import CreatorRuntime 类本身）。 */
export interface ReloadFlowHost {
	/** 生命周期 getter（构造期值拷贝会冻结判定——Arch A.2 同根因，须调用时读取）。 */
	readLifecycle: () => "active" | "detaching" | "disposed";
	webSocketServer: WebSocketServer;
	connections: Map<string, WebSocket>;
	connectionManager: ConnectionManager;
	heartbeatRegistry: HeartbeatRegistry;
	state: GroupChatState;
	activeDescriptor: ActiveGroupChatDescriptor;
	activeDescriptorPath: string;
	configMaxMessages: number;
	characters: ReadonlyMap<string, CharacterCard>;
	publicMessages: PublicMessageState[];
	persistedCount: number;
	sessionStore: SessionStore;
	groupSessionManager: SessionManager;
	boardStore: BoardStore;
	deps: {
		drainTimeoutMs: number;
		writeFile: (path: string, data: string) => Promise<void>;
		rm: (path: string) => Promise<void>;
	};
	enqueue: <T>(operation: () => T | Promise<T>) => Promise<T>;
	drainRuntimeQueue: (timeoutMs: number) => Promise<boolean>;
	releaseReservation: (connection: ConnectionContext) => void;
	removeOnlineCharacter: (connection: ConnectionContext, reason: "left" | "disconnected") => void;
	setLifecycle: (value: "active" | "detaching" | "disposed") => void;
}

interface BufferedFrame {
	receivedAt: number;
	data: WebSocket.RawData;
}

/**
 * 为 reload 分离运行时：保持稳定成员与 WebSocket 服务器存活，缓冲
 * reload 窗口内的帧，发布一次性 handoff。未完成上线的连接被释放并关闭；
 * reload 窗口内到达的新连接立即被拒绝。
 */
export async function detachForReload(host: ReloadFlowHost, piSessionId: string): Promise<CreatorReloadHandoff> {
	if (host.readLifecycle() !== "active") {
		throw new Error("CreatorRuntime is not active");
	}
	host.setLifecycle("detaching");
	host.heartbeatRegistry.stop();
	await host.drainRuntimeQueue(host.deps.drainTimeoutMs);

	// 释放从未完成 character_ready 的连接。
	for (const socket of host.webSocketServer.clients) {
		const connection = host.connectionManager.getConnection(socket);
		if (connection && (!connection.online || connection.sessionId === null)) {
			host.releaseReservation(connection);
			socket.close(1001, "Group chat closed");
		}
	}

	// 服务器保持在同一端口监听；reload 窗口内到达的新连接被立即拒绝。
	host.connectionManager.reject(host.webSocketServer);

	// 缓冲 reload 窗口内的帧并按成员记录断连。
	const bufferedFrames = new Map<string, BufferedFrame[]>();
	const bufferingHandlers = new Map<string, { message: (data: WebSocket.RawData) => void; close: () => void }>();
	const closedSessionIds = new Set<string>();
	for (const [sessionId, socket] of host.connections) {
		const connection = host.connectionManager.getConnection(socket);
		if (connection) {
			host.connectionManager.detachSocketHandlers(socket, connection);
		}
		const handlers = {
			message: (data: WebSocket.RawData) => {
				const frames = bufferedFrames.get(sessionId) ?? [];
				frames.push({ receivedAt: Date.now(), data });
				bufferedFrames.set(sessionId, frames);
			},
			close: () => {
				closedSessionIds.add(sessionId);
			},
		};
		bufferingHandlers.set(sessionId, handlers);
		socket.on("message", handlers.message);
		socket.on("close", handlers.close);
	}

	const handoff: CreatorReloadHandoff = {
		kind: "creator",
		piSessionId,
		expiresAt: Date.now() + host.deps.drainTimeoutMs,
		webSocketServer: host.webSocketServer,
		groupSessionManager: host.groupSessionManager,
		groupChatState: host.state,
		boardStore: host.boardStore,
		connections: host.connections,
		heartbeatStates: host.heartbeatRegistry.snapshot(),
		activeDescriptor: host.activeDescriptor,
		activeDescriptorPath: host.activeDescriptorPath,
		configMaxMessages: host.configMaxMessages,
		characters: [...host.characters.values()],
		publicMessages: [...host.publicMessages],
		persistedCount: host.persistedCount,
		bufferedFrames,
		bufferingHandlers,
		closedSessionIds,
		cleanup: async () => {
			for (const socket of host.connections.values()) {
				socket.close(1001, "Group chat closed");
			}
			await closeWebSocketServer(host.webSocketServer);
			await removeOwnedActiveDescriptor(host.activeDescriptorPath, host.activeDescriptor.instanceId);
			host.connections.clear();
			host.heartbeatRegistry.clear();
		},
	};
	getReloadHandoffRegistry().publish(handoff);
	return handoff;
}

/**
 * 接管前一 Extension Runtime 发布的 creator handoff：以全新处理器重新
 * 挂接成员 socket，按接收顺序回放缓冲帧，清理窗口期间断连的成员，恢复
 * 心跳。群聊身份与监听端口保持不变。
 */
export async function takeHandoff(
	handoff: CreatorReloadHandoff,
	dependencyOverrides: Partial<CreatorRuntimeDependencies> = {},
): Promise<CreatorRuntime> {
	const runtime = createFromHandoff(handoff, dependencyOverrides);

	// 把连接表与心跳状态移入新运行时。
	runtime.connections.clear();
	for (const [sessionId, socket] of handoff.connections) {
		runtime.connections.set(sessionId, socket);
	}
	runtime.heartbeatRegistry.clear();
	runtime.heartbeatRegistry.restore(handoff.heartbeatStates);

	// 以全新连接上下文与处理器重新挂接成员 socket。
	for (const [sessionId, socket] of runtime.connections) {
		const buffering = handoff.bufferingHandlers.get(sessionId);
		if (buffering) {
			socket.off("message", buffering.message);
			socket.off("close", buffering.close);
		}
		const connection: ConnectionContext = {
			sessionId,
			reservedCharacterId: null,
			online: true,
			readyTimer: null,
			handlers: null,
		};
		runtime.connectionManager.register(socket, connection);
	}

	// 按接收顺序回放 reload 窗口内的帧，然后清理窗口期间断连的成员。
	for (const [sessionId, frames] of handoff.bufferedFrames) {
		const socket = runtime.connections.get(sessionId);
		const connection = socket ? runtime.connectionManager.getConnection(socket) : undefined;
		if (!socket || !connection) {
			continue;
		}
		for (const frame of [...frames].sort((a, b) => a.receivedAt - b.receivedAt)) {
			await runtime.connectionManager.handleFrame(socket, connection, frame.data, false);
		}
	}
	for (const sessionId of handoff.closedSessionIds) {
		const socket = runtime.connections.get(sessionId);
		const connection = socket ? runtime.connectionManager.getConnection(socket) : undefined;
		if (socket && connection) {
			runtime.removeOnlineCharacter(connection, "disconnected");
		}
	}

	runtime.connectionManager.attach(runtime.webSocketServer);
	return runtime;
}
