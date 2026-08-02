import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";

import type { CharacterCard, CharacterSummary } from "../config/character-card.js";
import { DEFAULT_CONFIG_MAX_MESSAGES } from "../config/load-config.js";
import {
	type BufferedFrame,
	type CreatorReloadHandoff,
	getReloadHandoffRegistry,
} from "../controller/reload-handoff-registry.js";
import { countPersistedEntries, decodeCursor } from "../data/cursor-store.js";
import {
	type ActiveGroupChatDescriptor,
	getActiveDescriptorPath,
	getGroupChatSessionDirectory,
	publishActiveDescriptor,
	readActiveDescriptor,
	removeOwnedActiveDescriptor,
	updateActiveDescriptorName,
} from "../data/discovery/active-descriptor.js";
import {
	assertValidMaxMessages,
	createGroupChatState,
	type GroupChatState,
	normalizeGroupChatName,
	setGroupChatName,
	setGroupMaxMessages,
} from "../data/group-chat-state.js";
import type { SessionHeaderLike, SessionStore } from "../data/session-store.js";
import { decodeClientMessage, encodeMessage, MAX_WEBSOCKET_FRAME_BYTES } from "../protocol/codec.js";
import type { ClientMessage } from "../protocol/messages.js";
import type { PublicMessageState } from "../protocol/public-message-state.js";
import {
	HEARTBEAT_PING_INTERVAL_MS,
	HEARTBEAT_TIMEOUT_MS,
	SHORT_COORDINATION_TIMEOUT_MS,
} from "../shared/constants.js";
import type { RuntimeCloseReason, RuntimeCloseResult } from "../shared/runtime-close.js";
import { BroadcastHub } from "./broadcast-hub.js";
import { type ConnectionContext, ConnectionManager } from "./connection-manager.js";
import { MemberBookkeeping } from "./member-bookkeeping.js";
import { buildCreatorDependencies, createNewRuntime, resumeRuntime } from "./creator-factory.js";
import { ClaimPipeline } from "./creator-pipelines/claim-pipeline.js";
import { JoinPipeline } from "./creator-pipelines/join-pipeline.js";
import { LeavePipeline } from "./creator-pipelines/leave-pipeline.js";
import { QueryPipeline } from "./creator-pipelines/query-pipeline.js";
import { ReadyPipeline } from "./creator-pipelines/ready-pipeline.js";
import { SubmitMessagePipeline } from "./creator-pipelines/submit-message-pipeline.js";
import { HeartbeatRegistry } from "./heartbeat-registry.js";
import { detachForReload as detachForReloadFlow, takeHandoff as takeHandoffFlow } from "./reload-flow.js";

export interface StartNewCreatorRuntimeOptions {
	cwd: string;
	agentDir: string;
	configMaxMessages?: number;
	characters?: CharacterCard[];
}

export interface ResumeCreatorRuntimeOptions {
	cwd: string;
	agentDir: string;
	sessionPath: string;
	configMaxMessages?: number;
	characters?: CharacterCard[];
}

interface PersistedRuntimeState {
	publicMessages: PublicMessageState[];
	persistedCount: number;
}

export interface CreatorRuntimeDependencies {
	createId: () => string;
	now: () => Date;
	pid: number;
	readyTimeoutMs: number;
	publishDescriptor: (agentDir: string, descriptor: ActiveGroupChatDescriptor) => Promise<string>;
	writeFile: (path: string, data: string) => Promise<void>;
	rm: (path: string) => Promise<void>;
	/** WebSocket 心跳 ping 间隔（默认 30s）。 */
	heartbeatIntervalMs: number;
	/** Pong 超时阈值（默认 120s）；超时成员被终止。 */
	heartbeatTimeoutMs: number;
	/** close()/detachForReload() 等待运行时队列排空的最长时间。 */
	drainTimeoutMs: number;
}

export class CreatorRuntime {
	readonly connections = new Map<string, WebSocket>();
	readonly characters: Map<string, CharacterCard>;

	/** @internal reload-flow 主机接口读取；语义不变。 */
	lifecycle: "active" | "detaching" | "disposed" = "active";
	private closePromise: Promise<RuntimeCloseResult> | null = null;
	private runtimeTail = Promise.resolve();
	/** @internal reload-flow 访问；语义不变。 */
	readonly deps: CreatorRuntimeDependencies;

	/** 成员心跳簿记 + 定时器（PR-B：拆自 runtime 的 HeartbeatRegistry，构造器内装配）。 */
	readonly heartbeatRegistry: HeartbeatRegistry;
	/** 出站消息构造与组播（PR-B：拆自 runtime 的 BroadcastHub，构造器内装配）。 */
	private readonly broadcastHub: BroadcastHub;
	/** 成员簿记（PR-B：拆自 runtime 的 MemberBookkeeping，构造器内装配）。 */
	readonly memberBookkeeping: MemberBookkeeping;
	/** WebSocket 连接生命周期 + 消息分发（PR-B：拆自 runtime 的 ConnectionManager，构造器内装配）。 */
	readonly connectionManager: ConnectionManager;
	private readonly joinPipeline: JoinPipeline;
	private readonly leavePipeline: LeavePipeline;
	private readonly submitMessageDeps: ConstructorParameters<typeof SubmitMessagePipeline>[0];
	private readonly claimDeps: ConstructorParameters<typeof ClaimPipeline>[0];
	private readonly readyDeps: ConstructorParameters<typeof ReadyPipeline>[0];
	private readonly queryDeps: ConstructorParameters<typeof QueryPipeline>[0];
	/** @internal reload-flow 快照读取；语义不变。 */
	persistedCount = 0;

	/** 当前 SessionManager 实例（由 session-store 持有；回滚重建后返回新实例）。 */
	/** @internal reload-flow 访问；语义不变。 */
	get groupSessionManager(): SessionManager {
		return this.sessionStore.getSessionManager() as SessionManager;
	}

	onPublicMessage:
		| ((msg: {
				sender: { type: "user_persona" } | { type: "character"; character_id: string; name: string };
				content: string;
				event_id: string;
				sequence: number;
				timestamp: string;
				round: { round_max_messages: number; used_messages: number; remaining_messages: number };
		  }) => void)
		| undefined;

	onPublicMessageError: ((error: string, sequence: number, timestamp: string) => void) | undefined;

	/** 在线成员或流式状态变化时触发（TUI 刷新信号）。 */
	onMembersChanged: (() => void) | undefined;

	/** @internal reload-flow 快照读取；对外读走 publicMessageList getter。 */
	publicMessages: PublicMessageState[] = [];

	/**
	 * #42：消息列表只读访问（返回拷贝，防外部变异）。resume 历史投影使用；
	 * 增量路径仍走内部引用，语义零变化。
	 */
	get publicMessageList(): PublicMessageState[] {
		return [...this.publicMessages];
	}

	/**
	 * @internal 装配职责归 CreatorFactory（PR-B）：外部经 startNew/resume 工厂构造。
	 */
	constructor(
		readonly webSocketServer: WebSocketServer,
		/** @internal reload-flow 访问；语义不变。 */
		readonly sessionStore: SessionStore,
		readonly state: GroupChatState,
		readonly activeDescriptor: ActiveGroupChatDescriptor,
		readonly activeDescriptorPath: string,
		readonly configMaxMessages: number,
		characters: CharacterCard[],
		private readonly readyTimeoutMs: number,
		deps: CreatorRuntimeDependencies,
		initialPersistedState?: PersistedRuntimeState,
	) {
		this.deps = deps;
		this.heartbeatRegistry = new HeartbeatRegistry({
			intervalMs: deps.heartbeatIntervalMs,
			timeoutMs: deps.heartbeatTimeoutMs,
			now: () => deps.now(),
			getSocket: (sessionId) => this.connections.get(sessionId),
			onStale: (sessionId) => this.connections.get(sessionId)?.terminate(),
		});
		this.broadcastHub = new BroadcastHub({
			state: this.state,
			readPublicMessages: () => this.publicMessages,
			iterateConnections: (visit) => {
				for (const socket of this.connections.values()) {
					visit(socket);
				}
			},
			isActive: () => this.lifecycle === "active",
			onSendFailure: (socket) => this.handleSendFailure(socket),
			toCharacterSummaryMessage,
		});
		this.memberBookkeeping = new MemberBookkeeping({
			state: this.state,
			connections: this.connections,
			characters: this.characters,
			heartbeatRegistry: this.heartbeatRegistry,
			broadcastHub: this.broadcastHub,
			enqueue: (operation) => this.enqueue(operation),
			readyTimeoutMs: this.readyTimeoutMs,
			onMembersChanged: this.onMembersChanged,
			toCharacterSummaryMessage,
		});
		this.connectionManager = new ConnectionManager({
			isActive: () => this.lifecycle === "active",
			enqueue: (operation) => this.enqueue(operation),
			onClientMessage: (socket, connection, message) => this.handleClientMessage(socket, connection, message),
			onPong: (connection) => {
				if (connection.sessionId !== null) {
					this.heartbeatRegistry.recordPong(connection.sessionId);
				}
			},
			onClosed: (connection) => {
				this.memberBookkeeping.releaseReservation(connection);
				this.memberBookkeeping.removeOnlineCharacter(connection, "disconnected");
			},
		});
		this.characters = new Map(characters.map((character) => [character.characterId, character]));
		if (initialPersistedState) {
			this.publicMessages = initialPersistedState.publicMessages;
			this.persistedCount = initialPersistedState.persistedCount;
		}
		// 门面装配（application 层从 runtime 拿能力实例，不自建；application→runtime 下行依赖合法）
		this.joinPipeline = new JoinPipeline({
			connections: this.connections,
			getAvailableCharacters: () => this.memberBookkeeping.getAvailableCharacters(),
			toCharacterSummaryMessage,
			send: (socket, message) => this.broadcastHub.send(socket, message),
			sendFailure: (socket, id, command, reason) => this.broadcastHub.sendFailure(socket, id, command, reason),
		});
		this.leavePipeline = new LeavePipeline({
			removeOnlineCharacter: (connection, reason) =>
				this.removeOnlineCharacter(connection as ConnectionContext, reason),
			send: (socket, message) => this.broadcastHub.send(socket, message),
			sendFailure: (socket, id, command, reason) => this.broadcastHub.sendFailure(socket, id, command, reason),
		});
		// submit-message 管线依赖面（跨消息状态经闭包显式读写，决策 7）
		this.submitMessageDeps = {
			state: this.state,
			publicMessages: this.publicMessages,
			persistedCount: {
				get: () => this.persistedCount,
				add: (delta) => {
					this.persistedCount += delta;
				},
			},
			sessionStore: this.sessionStore,
			broadcastGroupChatUpdate: () => this.broadcastHub.broadcastGroupChatUpdate(),
			onPublicMessage: (msg) => this.onPublicMessage?.(msg),
			onPublicMessageError: (error, sequence, timestamp) => this.onPublicMessageError?.(error, sequence, timestamp),
			send: (socket, message) => this.broadcastHub.send(socket, message),
			sendFailure: (socket, id, command, reason) => this.broadcastHub.sendFailure(socket, id, command, reason),
		};
		// claim/ready/query 门面依赖面（跨消息状态经注入引用显式读写，决策 7）
		this.claimDeps = {
			state: this.state,
			characters: this.characters,
			isCharacterAvailable: (characterId) => this.memberBookkeeping.isCharacterAvailable(characterId),
			startReadyTimer: (socket, connection) => this.memberBookkeeping.startReadyTimer(socket, connection as ConnectionContext),
			toCharacterSummaryMessage,
			send: (socket, message) => this.broadcastHub.send(socket, message),
			sendFailure: (socket, id, command, reason) => this.broadcastHub.sendFailure(socket, id, command, reason),
		};
		this.readyDeps = {
			state: this.state,
			connections: this.connections,
			heartbeatRegistry: this.heartbeatRegistry,
			publicMessages: this.publicMessages,
			characters: this.characters,
			clearReadyTimer: (connection) => this.memberBookkeeping.clearReadyTimer(connection as ConnectionContext),
			now: () => this.deps.now(),
			toCharacterSummary,
			toCharacterSummaryMessage,
			send: (socket, message) => this.broadcastHub.send(socket, message),
			sendFailure: (socket, id, command, reason) => this.broadcastHub.sendFailure(socket, id, command, reason),
			broadcast: (message) => this.broadcastHub.broadcast(message),
			broadcastGroupChatUpdate: () => this.broadcastHub.broadcastGroupChatUpdate(),
			onMembersChanged: () => this.onMembersChanged?.(),
		};
		this.queryDeps = {
			state: this.state,
			publicMessages: this.publicMessages,
			sessionStore: this.sessionStore,
			getPersistedCount: () => this.persistedCount,
			getGroupChatStateMessage: (requestingSessionId) =>
				this.broadcastHub.getGroupChatStateMessage(requestingSessionId),
			send: (socket, message) => this.broadcastHub.send(socket, message),
			sendFailure: (socket, id, command, reason) => this.broadcastHub.sendFailure(socket, id, command, reason),
			broadcastGroupChatUpdate: () => this.broadcastHub.broadcastGroupChatUpdate(),
			onMembersChanged: () => this.onMembersChanged?.(),
		};
		this.heartbeatRegistry.start();
	}

	static async startNew(
		options: StartNewCreatorRuntimeOptions,
		dependencyOverrides: Partial<CreatorRuntimeDependencies> = {},
	): Promise<CreatorRuntime> {
		return createNewRuntime(options, buildCreatorDependencies(dependencyOverrides));
	}

	static async resume(
		options: ResumeCreatorRuntimeOptions,
		dependencyOverrides: Partial<CreatorRuntimeDependencies> = {},
	): Promise<CreatorRuntime> {
		return resumeRuntime(options, buildCreatorDependencies(dependencyOverrides));
	}

	/** reload 分离（PR-B：流程移至 reload-flow，骨架保留门面）。 */
	async detachForReload(piSessionId: string): Promise<CreatorReloadHandoff> {
		return detachForReloadFlow(this, piSessionId);
	}

	/** reload 接管（PR-B：流程移至 reload-flow，骨架保留门面）。 */
	static async takeHandoff(
		handoff: CreatorReloadHandoff,
		dependencyOverrides: Partial<CreatorRuntimeDependencies> = {},
	): Promise<CreatorRuntime> {
		return takeHandoffFlow(handoff, dependencyOverrides);
	}

	async setName(name: string): Promise<string | null> {
		return this.enqueue(async () => {
			const normalizedName = normalizeGroupChatName(name);

			// 空群聊：仅更新内存（尚无文件）
			if (!this.persistedCount) {
				await updateActiveDescriptorName(this.activeDescriptorPath, this.activeDescriptor.instanceId, normalizedName);
				setGroupChatName(this.state, name);
				this.activeDescriptor.name = normalizedName;
				return normalizedName;
			}

			this.sessionStore.assertWritable();

			// 活跃群聊：经 session-store 持久化条目
			try {
				this.sessionStore.appendSessionInfo(normalizedName ?? "");
			} catch (error) {
				this.sessionStore.recoverFromFailedAppend(error);
			}
			this.persistedCount++;

			// 持久化成功后提交内存状态（权威）
			setGroupChatName(this.state, name);
			this.activeDescriptor.name = normalizedName;

			// 尽力而为的 descriptor 更新（发现投影；失败非致命）
			try {
				await updateActiveDescriptorName(this.activeDescriptorPath, this.activeDescriptor.instanceId, normalizedName);
			} catch {
				// descriptor 更新失败，但内存与 JSONL 一致
			}

			return normalizedName;
		});
	}

	setMaxMessages(maxMessages: number): Promise<void> {
		return this.enqueue(async () => {
			// 在任何持久化/状态变更之前校验：非法值绝不能写入 JSONL 或推进
			// persistedCount（BC-18）。
			assertValidMaxMessages(maxMessages);

			// 空群聊：仅更新内存
			if (!this.persistedCount) {
				setGroupMaxMessages(this.state, maxMessages);
				return;
			}

			this.sessionStore.assertWritable();

			// 活跃群聊：经 session-store 持久化条目
			try {
				this.sessionStore.appendCustomEntry("pi-tavern.group-settings", {
					group_max_messages: maxMessages,
				});
			} catch (error) {
				this.sessionStore.recoverFromFailedAppend(error);
			}
			this.persistedCount++;

			setGroupMaxMessages(this.state, maxMessages);
		});
	}

	submitUserPersonaMessage(content: string): Promise<string> {
		// 请求级管线实例：校验 → 持久化（first-persist/append）→ 提交 → 广播/投影
		return this.enqueue(() => new SubmitMessagePipeline(this.submitMessageDeps).runUserPersona(content));
	}

	/**
	 * 永久终止运行时。幂等：并发调用共享同一结果。先排空运行时队列（受协调
	 * 超时约束）；队列永不排空时，本地清理仍强制完成。
	 */
	close(reason: RuntimeCloseReason = "user_leave"): Promise<RuntimeCloseResult> {
		this.closePromise ??= this.performClose(reason);
		return this.closePromise;
	}

	private async performClose(_reason: RuntimeCloseReason): Promise<RuntimeCloseResult> {
		if (this.lifecycle === "detaching") {
			// close() 与 detachForReload() 是互斥路径。
			throw new Error("CreatorRuntime has been detached for reload and cannot be closed");
		}
		const errors: Error[] = [];
		this.lifecycle = "disposed";
		this.heartbeatRegistry.stop();
		const timedOut = await this.drainRuntimeQueue(this.deps.drainTimeoutMs);

		try {
			this.broadcastHub.broadcast({
				type: "group_chat_closed",
				group_chat_id: this.state.groupChat.groupChatId,
			});
		} catch (error) {
			errors.push(asError(error));
		}
		for (const socket of this.webSocketServer.clients) {
			socket.close(1001, "Group chat closed");
		}
		await closeWebSocketServer(this.webSocketServer);
		this.connections.clear();
		this.state.onlineCharacters.clear();
		this.state.characterReservations.clear();
		this.heartbeatRegistry.clear();
		try {
			await removeOwnedActiveDescriptor(this.activeDescriptorPath, this.activeDescriptor.instanceId);
		} catch (error) {
			errors.push(asError(error));
		}
		return { timedOut, errors };
	}

	/** reload-flow 主机接口的生命周期写入（ReloadFlowHost.setLifecycle）。 */
	setLifecycle(value: "active" | "detaching" | "disposed"): void {
		this.lifecycle = value;
	}

	/** 等待运行时队列排空，最长 timeoutMs；超时返回 true。 */
	async drainRuntimeQueue(timeoutMs: number): Promise<boolean> {
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				this.runtimeTail.then(() => false),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(true), timeoutMs);
					timer.unref?.();
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/** 解码后的客户端消息分发（ConnectionManager 注入回调；管线门面装配）。 */
	private async handleClientMessage(
		socket: WebSocket,
		connection: ConnectionContext,
		message: ClientMessage,
	): Promise<void> {
		switch (message.type) {
			case "join_group_chat":
				this.joinPipeline.run(socket, connection, message);
				return;
			case "claim_character":
				new ClaimPipeline(this.claimDeps).run(socket, connection, message);
				return;
			case "character_ready":
				new ReadyPipeline(this.readyDeps).run(socket, connection, message);
				return;
			case "get_group_chat_state":
				new QueryPipeline(this.queryDeps).runGetGroupChatState(socket, connection, message);
				return;
			case "get_message_history":
				new QueryPipeline(this.queryDeps).runGetMessageHistory(socket, connection, message);
				return;
			case "fetch_messages_since":
				new QueryPipeline(this.queryDeps).runFetchMessagesSince(socket, connection, message);
				return;
			case "get_chat_history_file":
				new QueryPipeline(this.queryDeps).runGetChatHistoryFile(socket, connection, message);
				return;
			case "update_character_state":
				new QueryPipeline(this.queryDeps).runUpdateCharacterState(connection, message.is_streaming);
				return;
			case "leave_group_chat":
				this.leavePipeline.run(socket, connection, message);
				return;
			case "speak":
				// 请求级管线实例（ADR：一次协议消息 = 一个管线实例；依赖面由 runtime 装配注入）
				await new SubmitMessagePipeline(this.submitMessageDeps).runSpeak(socket, connection, message);
				return;
		}
	}

	/**
	 * 把失败的发送引入统一断连清理。先从连接表移除 socket，使 character_left
	 * 广播不会递归命中同一个死 socket。
	 */
	private handleSendFailure(socket: WebSocket): void {
		const connection = this.connectionManager.getConnection(socket);
		if (!connection || !connection.online || connection.sessionId === null) {
			return;
		}
		this.connections.delete(connection.sessionId);
		this.heartbeatRegistry.remove(connection.sessionId);
		void this.enqueue(() => {
			this.memberBookkeeping.removeOnlineCharacter(connection, "disconnected");
		});
	}

	/** @internal reload-flow 串行入队；语义不变。 */
	enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
		const task = this.runtimeTail.then(operation);
		this.runtimeTail = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function toCharacterSummary(character: CharacterCard): CharacterSummary {
	return {
		characterId: character.characterId,
		name: character.name,
		description: character.description,
	};
}

function toCharacterSummaryMessage(character: CharacterSummary) {
	return {
		character_id: character.characterId,
		name: character.name,
		description: character.description,
	};
}

export async function listenOnLocalhost(path: string): Promise<WebSocketServer> {
	const server = new WebSocketServer({
		host: "127.0.0.1",
		port: 0,
		path,
		maxPayload: MAX_WEBSOCKET_FRAME_BYTES,
	});

	try {
		await new Promise<void>((resolveListening, rejectListening) => {
			const onListening = (): void => {
				server.off("error", onError);
				resolveListening();
			};
			const onError = (error: Error): void => {
				server.off("listening", onListening);
				rejectListening(error);
			};

			server.once("listening", onListening);
			server.once("error", onError);
		});
		return server;
	} catch (error) {
		await closeWebSocketServer(server);
		throw error;
	}
}

export async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
	if (server.address() === null) {
		return;
	}

	await new Promise<void>((resolveClose, rejectClose) => {
		server.close((error) => {
			if (error) {
				rejectClose(error);
			} else {
				resolveClose();
			}
		});
	});
}
