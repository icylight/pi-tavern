import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type WebSocket from "ws";
import type { WebSocketServer } from "ws";

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
import { decodeClientMessage, encodeMessage } from "../protocol/codec.js";
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
import { buildCreatorDependencies, createNewRuntime, resumeRuntime } from "./creator-factory.js";
import type { ClaimPipeline } from "./creator-pipelines/claim-pipeline.js";
import { dispatchClientMessage as dispatchClientMessageFlow } from "./creator-pipelines/dispatch.js";
import type { JoinPipeline } from "./creator-pipelines/join-pipeline.js";
import type { LeavePipeline } from "./creator-pipelines/leave-pipeline.js";
import type { QueryPipeline } from "./creator-pipelines/query-pipeline.js";
import type { ReadyPipeline } from "./creator-pipelines/ready-pipeline.js";
import type { SubmitMessagePipeline } from "./creator-pipelines/submit-message-pipeline.js";
import { HeartbeatRegistry } from "./heartbeat-registry.js";
import { MemberBookkeeping } from "./member-bookkeeping.js";
import { assemblePipelineDeps } from "./pipeline-assembly.js";
import { detachForReload as detachForReloadFlow, takeHandoff as takeHandoffFlow } from "./reload-flow.js";
import { RuntimeFacades } from "./runtime-facades.js";
import { RuntimeLifecycle } from "./runtime-lifecycle.js";
import { closeWebSocketServer, listenOnLocalhost } from "./ws-utils.js";

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
	/** 永久终止流程（PR-B：拆自 runtime 的 RuntimeLifecycle，构造器内装配）。 */
	private readonly runtimeLifecycle: RuntimeLifecycle;
	/** 公开门面 API（PR-B：拆自 runtime 的 RuntimeFacades，构造器内装配）。 */
	private readonly runtimeFacades: RuntimeFacades;
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

		this.connectionManager = new ConnectionManager({
			isActive: () => this.lifecycle === "active",
			enqueue: (operation) => this.enqueue(operation),
			onClientMessage: (socket, connection, message) => this.dispatchClientMessage(socket, connection, message),
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
		this.memberBookkeeping = new MemberBookkeeping({
			state: this.state,
			connections: this.connections,
			characters: this.characters,
			heartbeatRegistry: this.heartbeatRegistry,
			broadcastHub: this.broadcastHub,
			enqueue: (operation) => this.enqueue(operation),
			readyTimeoutMs: this.readyTimeoutMs,
			readOnMembersChanged: () => this.onMembersChanged,
			toCharacterSummaryMessage,
		});

		if (initialPersistedState) {
			this.publicMessages = initialPersistedState.publicMessages;
			this.persistedCount = initialPersistedState.persistedCount;
		}
		this.runtimeLifecycle = new RuntimeLifecycle({
			readLifecycle: () => this.lifecycle,
			setLifecycle: (value) => {
				this.lifecycle = value;
			},
			heartbeatRegistry: this.heartbeatRegistry,
			broadcastHub: this.broadcastHub,
			state: this.state,
			webSocketServer: this.webSocketServer,
			connections: this.connections,
			activeDescriptor: this.activeDescriptor,
			activeDescriptorPath: this.activeDescriptorPath,
			deps: this.deps,
			readRuntimeTail: () => this.runtimeTail,
			enqueue: (operation) => this.enqueue(operation),
		});
		// 管线门面装配（PR-B：拆至 pipeline-assembly，窄接口 host 注入）
		const assembly = assemblePipelineDeps({
			state: this.state,
			connections: this.connections,
			heartbeatRegistry: this.heartbeatRegistry,
			publicMessages: this.publicMessages,
			characters: this.characters,
			sessionStore: this.sessionStore,
			persistedCount: {
				get: () => this.persistedCount,
				add: (delta) => {
					this.persistedCount += delta;
				},
			},
			broadcastHub: this.broadcastHub,
			memberBookkeeping: this.memberBookkeeping,
			enqueue: (operation) => this.enqueue(operation),
			readOnPublicMessage: () => this.onPublicMessage,
			readOnPublicMessageError: () => this.onPublicMessageError,
			readOnMembersChanged: () => this.onMembersChanged,
			now: () => this.deps.now(),
			toCharacterSummary,
			toCharacterSummaryMessage,
		});
		this.joinPipeline = assembly.joinPipeline;
		this.leavePipeline = assembly.leavePipeline;
		this.submitMessageDeps = assembly.submitMessageDeps;
		this.claimDeps = assembly.claimDeps;
		this.readyDeps = assembly.readyDeps;
		this.queryDeps = assembly.queryDeps;

		this.runtimeFacades = new RuntimeFacades({
			state: this.state,
			sessionStore: this.sessionStore,
			activeDescriptor: this.activeDescriptor,
			activeDescriptorPath: this.activeDescriptorPath,
			persistedCount: {
				get: () => this.persistedCount,
				add: (delta) => {
					this.persistedCount += delta;
				},
			},
			submitMessageDeps: this.submitMessageDeps,
			enqueue: (operation) => this.enqueue(operation),
		});
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

	/** 公开门面 API（PR-B：流程移至 runtime-facades，骨架保留门面）。 */
	setName(name: string): Promise<string | null> {
		return this.runtimeFacades.setName(name);
	}

	setMaxMessages(maxMessages: number): Promise<void> {
		return this.runtimeFacades.setMaxMessages(maxMessages);
	}

	submitUserPersonaMessage(content: string): Promise<string> {
		return this.runtimeFacades.submitUserPersonaMessage(content);
	}

	/** 永久终止运行时（PR-B：流程移至 runtime-lifecycle，骨架保留门面；幂等语义随迁）。 */
	close(reason: RuntimeCloseReason = "user_leave"): Promise<RuntimeCloseResult> {
		return this.runtimeLifecycle.close(reason);
	}

	/** reload-flow 主机接口的生命周期读取（ReloadFlowHost.readLifecycle）。 */
	readLifecycle(): "active" | "detaching" | "disposed" {
		return this.lifecycle;
	}

	/** reload-flow 主机接口的生命周期写入（ReloadFlowHost.setLifecycle）。 */
	setLifecycle(value: "active" | "detaching" | "disposed"): void {
		this.lifecycle = value;
	}

	/** @internal reload-flow 主机接口委托；业务语义不变。 */
	releaseReservation(connection: ConnectionContext): void {
		this.memberBookkeeping.releaseReservation(connection);
	}

	/** @internal reload-flow 主机接口委托；业务语义不变。 */
	removeOnlineCharacter(connection: ConnectionContext, reason: "left" | "disconnected"): void {
		this.memberBookkeeping.removeOnlineCharacter(connection, reason);
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

	/** 客户端消息分发（PR-B：流程移至 creator-pipelines/dispatch）。 */
	private dispatchClientMessage(
		socket: WebSocket,
		connection: ConnectionContext,
		message: ClientMessage,
	): Promise<void> {
		return dispatchClientMessageFlow(
			{
				joinPipeline: this.joinPipeline,
				leavePipeline: this.leavePipeline,
				submitMessageDeps: this.submitMessageDeps,
				claimDeps: this.claimDeps,
				readyDeps: this.readyDeps,
				queryDeps: this.queryDeps,
			},
			socket,
			connection,
			message,
		);
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
