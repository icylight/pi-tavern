import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type WebSocket from "ws";
import type { WebSocketServer } from "ws";

import type { CharacterCard, CharacterSummary } from "../config/character-card.js";
import type { CreatorReloadHandoff } from "../controller/reload-handoff-registry.js";
import { computeSnapshot } from "../data/decision-store.js";
import type { ActiveGroupChatDescriptor } from "../data/discovery/active-descriptor.js";
import type { GroupChatState } from "../data/group-chat-state.js";
import type { SessionStore } from "../data/session-store.js";
import type { ClientMessage, DecisionRecordWire } from "../protocol/messages.js";
import type { PublicMessageState } from "../protocol/public-message-state.js";
import { CHARACTER_REFRESH_TIMEOUT_MS } from "../shared/constants.js";
import type { RuntimeCloseReason, RuntimeCloseResult } from "../shared/runtime-close.js";
import { BroadcastHub } from "./broadcast-hub.js";
import { type ConnectionContext, ConnectionManager } from "./connection-manager.js";
import { buildCreatorDependencies, createNewRuntime, resumeRuntime } from "./creator-factory.js";
import type { ClaimPipeline } from "./creator-pipelines/claim-pipeline.js";
import type { DecisionPipeline, DecisionStoreAccess } from "./creator-pipelines/decision-pipeline.js";
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

export interface StartNewCreatorRuntimeOptions {
	cwd: string;
	agentDir: string;
	configMaxMessages?: number;
	characters?: CharacterCard[];
	/**
	 * #25：角色清单按需刷新（懒刷新）——join/claim/query 前重扫磁盘。
	 * 注入磁盘重扫实现（组合根提供，默认 = 重新 loadTavernConfig）；
	 * 未注入 = 启动快照行为（零变化）。刷新失败/空结果回退旧快照。
	 */
	loadCharacters?: () => Promise<CharacterCard[]>;
}

export interface ResumeCreatorRuntimeOptions {
	cwd: string;
	agentDir: string;
	sessionPath: string;
	configMaxMessages?: number;
	characters?: CharacterCard[];
	/** #25：同 StartNewCreatorRuntimeOptions.loadCharacters。 */
	loadCharacters?: () => Promise<CharacterCard[]>;
}

interface PersistedRuntimeState {
	publicMessages: PublicMessageState[];
	persistedCount: number;
	/** #107：决策状态链（resume/handoff 恢复，C2/T14）。 */
	decisionRecords: DecisionRecordWire[];
	/** #107（F4）：决策声明配额计数（handoff 传递；resume 无 = 空，与 round 不恢复同语义）。 */
	declareCounts?: Map<string, number>;
}

export interface CreatorRuntimeDependencies {
	createId: () => string;
	now: () => Date;
	pid: number;
	readyTimeoutMs: number;
	publishDescriptor: (agentDir: string, descriptor: ActiveGroupChatDescriptor) => Promise<string>;
	writeFile: (path: string, data: string) => Promise<void>;
	/** #107：决策 JSONL 原子替换（temp+rename；组合根注入默认实现）。 */
	rename: (from: string, to: string) => Promise<void>;
	/** #107：决策 JSONL 读取（组合根注入默认实现；runtime 不直连 node:fs）。 */
	readFile?: (path: string) => Promise<string>;
	rm: (path: string) => Promise<void>;
	/** WebSocket 心跳 ping 间隔（默认 30s）。 */
	heartbeatIntervalMs: number;
	/** Pong 超时阈值（默认 120s）；超时成员被终止。 */
	heartbeatTimeoutMs: number;
	/** close()/detachForReload() 等待运行时队列排空的最长时间。 */
	drainTimeoutMs: number;
	/**
	 * #25：角色清单磁盘重扫（懒刷新）。未注入 = 不刷新（启动快照语义）。
	 * 由组合根注入（creator-factory 默认装配 = loadTavernConfig 重读）。
	 */
	loadCharacters?: () => Promise<CharacterCard[]>;
}

export class CreatorRuntime {
	readonly connections = new Map<string, WebSocket>();
	readonly characters: Map<string, CharacterCard>;

	/** @internal reload-flow 主机接口读取；语义不变。 */
	lifecycle: "active" | "detaching" | "disposed" = "active";
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
	/** #107：决策状态访问面（组合根装配；单写者，跨 reload 由 handoff 传递）。 */
	readonly decisionStore: DecisionStoreAccess;
	/** #107：decision_declare 管线依赖（RuntimeFacades 的 User 入口复用）。 */
	readonly decisionDeps: ConstructorParameters<typeof DecisionPipeline>[0];
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
		/** #107：决策状态 JSONL 路径（工厂推导；undefined = 仅内存不落盘兜底）。 */
		readonly decisionFilePath?: string,
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
			readDecisionSnapshot: () => computeSnapshot(this.decisionStore.records),
			iterateConnections: (visit) => {
				for (const socket of this.connections.values()) {
					visit(socket);
				}
			},
			supportsDecisionState: (socket) => this.connectionManager?.getConnection(socket)?.decisionStateCapable ?? false,
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
		// #107：决策状态访问面（单写者）。append = 完整链持久化（temp+rename
		// 原子替换；reload/resume 由 handoff/工厂恢复内存链）。
		this.decisionStore = {
			records: initialPersistedState?.decisionRecords ?? [],
			declareCounts: new Map(initialPersistedState?.declareCounts ?? []),
			append: async (records) => {
				if (!this.decisionFilePath) {
					return;
				}
				// 决策也属于可恢复群聊状态。首条公开消息尚未出现时先原子落一个
				// 规范 session header，使 /tavern-resume 能发现 decision-only 群聊；
				// 后续首条 User Persona 消息仍按既有 first-persist 流程覆盖并追加设置。
				if (this.persistedCount === 0) {
					const sessionPath = this.sessionStore.getSessionFilePath();
					const header = this.sessionStore.getHeader();
					if (!header) throw new Error("Group chat session has no header");
					const seedPath = `${sessionPath}.decision-seed.tmp`;
					await this.deps.writeFile(
						seedPath,
						`${JSON.stringify({ ...header, timestamp: this.state.groupChat.createdAt })}\n`,
					);
					await this.deps.rename(seedPath, sessionPath);
				}
				const lines = records.map((r) => JSON.stringify(r));
				const content = `${lines.join("\n")}\n`;
				// F6：temp + rename 原子替换（崩溃/部分写不损坏既有链）。
				const tmpPath = `${this.decisionFilePath}.tmp`;
				await this.deps.writeFile(tmpPath, content);
				await this.deps.rename(tmpPath, this.decisionFilePath);
			},
		};
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
			decisionStore: this.decisionStore,
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
		this.decisionDeps = assembly.decisionDeps;

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
			decisionDeps: this.decisionDeps,
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

	/** #107（F2）：User Persona 决策声明入口（命令层调用；decided_by 由管线固定）。 */
	declareDecisionAsUser(decl: {
		decision_id: string;
		version: number;
		content: string;
		supersedes: string[];
		status?: "proposed" | "closed";
	}): Promise<import("./creator-pipelines/decision-pipeline.js").DecisionPipelineResult> {
		return this.runtimeFacades.declareAsUser(decl);
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

	/** 等待运行时队列排空（Arch B 级：与 runtime-lifecycle 合一，委托单一实现）。 */
	async drainRuntimeQueue(timeoutMs: number): Promise<boolean> {
		return this.runtimeLifecycle.drainRuntimeQueue(timeoutMs);
	}

	/** #83（Arch 评审要点③）：角色清单刷新单飞行锁——并发 join/claim/query 复用飞行中刷新，防重扫风暴。 */
	private refreshInFlight: Promise<void> | null = null;

	/**
	 * #25：角色清单懒刷新——join/claim/query 前重扫磁盘。
	 * 成功且非空 = 原地更新 characters Map（保持实例引用，member-bookkeeping
	 * 与各 pipeline 持有的同一引用自动可见）；失败/空结果 = 回退旧快照（不动 Map）。
	 * 未注入 loadCharacters = 启动快照语义（行为零变化）。
	 * #83（QA 红绿钉死 + Arch 评审三要点）：
	 * ① 竞速短超时（1s）——挂起重扫不得无限阻塞 join 热路径，超时按失败回退；
	 * ② 迟到成功仍更新 Map（load 不可取消，完成后 .then 照常应用）——保延迟可见性、不丢刷新；
	 * ③ 单飞行锁复用飞行中刷新——并发 join/claim/query 不重复重扫。
	 */
	private async refreshCharacters(): Promise<void> {
		const load = this.deps.loadCharacters;
		if (!load) {
			return;
		}
		if (this.refreshInFlight) {
			await this.refreshInFlight;
			return;
		}
		const loadPromise = load();
		const refresh = (async () => {
			try {
				const fresh = await Promise.race([
					loadPromise,
					new Promise<never>((_, reject) => {
						const timer = setTimeout(
							() => reject(new Error("PiTavern character refresh timed out")),
							CHARACTER_REFRESH_TIMEOUT_MS,
						);
						timer.unref?.();
					}),
				]);
				this.applyCharacters(fresh);
			} catch {
				// 超时/失败：回退旧快照（不动 Map）；迟到成功由下方 .then 兜底更新。
			}
			// Arch 要点②：load 不可取消，完成后照常应用（幂等；失败静默）——
			// 超时路径下延迟可见性保留，不丢刷新。
			loadPromise
				.then((fresh) => {
					if (fresh.length > 0) {
						this.applyCharacters(fresh);
					}
				})
				.catch(() => undefined);
		})();
		this.refreshInFlight = refresh;
		try {
			await refresh;
		} finally {
			this.refreshInFlight = null;
		}
	}

	/** 应用刷新结果到 characters Map（幂等；空结果不动）。 */
	private applyCharacters(fresh: CharacterCard[]): void {
		if (fresh.length === 0) {
			return;
		}
		this.characters.clear();
		for (const character of fresh) {
			this.characters.set(character.characterId, character);
		}
	}

	/** 客户端消息分发（PR-B：流程移至 creator-pipelines/dispatch）。 */
	private async dispatchClientMessage(
		socket: WebSocket,
		connection: ConnectionContext,
		message: ClientMessage,
	): Promise<void> {
		// #25：角色清单入口（join 的 available_characters / claim 的摘要 /
		// query 的群聊状态）前懒刷新，失败由 refreshCharacters 内部回退旧快照。
		if (
			message.type === "join_group_chat" ||
			message.type === "claim_character" ||
			message.type === "get_group_chat_state"
		) {
			await this.refreshCharacters();
		}
		return dispatchClientMessageFlow(
			{
				joinPipeline: this.joinPipeline,
				leavePipeline: this.leavePipeline,
				submitMessageDeps: this.submitMessageDeps,
				claimDeps: this.claimDeps,
				readyDeps: this.readyDeps,
				queryDeps: this.queryDeps,
				decisionDeps: this.decisionDeps,
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
