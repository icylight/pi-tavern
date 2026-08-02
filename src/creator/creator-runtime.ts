import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import WebSocket, { WebSocketServer } from "ws";

import type { CharacterCard, CharacterSummary } from "../config/character-card.js";
import { DEFAULT_CONFIG_MAX_MESSAGES } from "../config/load-config.js";
import {
	type BufferedFrame,
	type CreatorReloadHandoff,
	getReloadHandoffRegistry,
} from "../controller/reload-handoff-registry.js";
import {
	type ActiveGroupChatDescriptor,
	getActiveDescriptorPath,
	getGroupChatSessionDirectory,
	publishActiveDescriptor,
	readActiveDescriptor,
	removeOwnedActiveDescriptor,
	updateActiveDescriptorName,
} from "../data/discovery/active-descriptor.js";
import { countPersistedEntries, decodeCursor, encodeCursor } from "../data/cursor-store.js";
import { formatEntryContent, SessionStore, type SessionHeaderLike } from "../data/session-store.js";
import { decodeClientMessage, encodeMessage, MAX_WEBSOCKET_FRAME_BYTES } from "../protocol/codec.js";
import type { ClientMessage } from "../protocol/messages.js";
import type { PublicMessageState } from "../protocol/public-message-state.js";
import {
	HEARTBEAT_PING_INTERVAL_MS,
	HEARTBEAT_TIMEOUT_MS,
	JOIN_HISTORY_LIMIT,
	SHORT_COORDINATION_TIMEOUT_MS,
} from "../shared/constants.js";
import type { RuntimeCloseReason, RuntimeCloseResult } from "../shared/runtime-close.js";
import {
	assertValidMaxMessages,
	createGroupChatState,
	type GroupChatState,
	normalizeGroupChatName,
	setGroupChatName,
	setGroupMaxMessages,
	setHandRaised,
} from "./group-chat-state.js";

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

	/** 按 pi session id 索引的成员心跳簿记。 */
	readonly heartbeatStates = new Map<string, HeartbeatState>();

	private lifecycle: "active" | "detaching" | "disposed" = "active";
	private closePromise: Promise<RuntimeCloseResult> | null = null;
	private runtimeTail = Promise.resolve();
	private readonly deps: CreatorRuntimeDependencies;
	private persistedCount = 0;
	private heartbeatTimer: NodeJS.Timeout | null = null;

	/** 当前 SessionManager 实例（由 session-store 持有；回滚重建后返回新实例）。 */
	private get groupSessionManager(): SessionManager {
		return this.sessionStore.getSessionManager() as SessionManager;
	}
	private serverConnectionHandler: ((socket: WebSocket) => void) | null = null;
	private rejectConnectionsHandler: ((socket: WebSocket) => void) | null = null;

	/** 把每个存活 socket 映射回其连接上下文，用于失败清理。 */
	private readonly connectionBySocket = new WeakMap<WebSocket, ConnectionContext>();

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

	private publicMessages: PublicMessageState[] = [];

	/**
	 * #42：消息列表只读访问（返回拷贝，防外部变异）。resume 历史投影使用；
	 * 增量路径仍走内部引用，语义零变化。
	 */
	get publicMessageList(): PublicMessageState[] {
		return [...this.publicMessages];
	}

	private constructor(
		readonly webSocketServer: WebSocketServer,
		private readonly sessionStore: SessionStore,
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
		this.characters = new Map(characters.map((character) => [character.characterId, character]));
		if (initialPersistedState) {
			this.publicMessages = initialPersistedState.publicMessages;
			this.persistedCount = initialPersistedState.persistedCount;
		}
		this.startHeartbeat();
	}

	static async startNew(
		options: StartNewCreatorRuntimeOptions,
		dependencyOverrides: Partial<CreatorRuntimeDependencies> = {},
	): Promise<CreatorRuntime> {
		const dependencies: CreatorRuntimeDependencies = {
			createId: randomUUID,
			now: () => new Date(),
			pid: process.pid,
			readyTimeoutMs: SHORT_COORDINATION_TIMEOUT_MS,
			publishDescriptor: publishActiveDescriptor,
			writeFile: (path, data) => writeFile(path, data),
			rm: (path) => rm(path, { force: true }),
			heartbeatIntervalMs: HEARTBEAT_PING_INTERVAL_MS,
			heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
			drainTimeoutMs: SHORT_COORDINATION_TIMEOUT_MS,
			...dependencyOverrides,
		};
		const groupChatId = dependencies.createId();
		const instanceId = dependencies.createId();
		const createdAt = dependencies.now().toISOString();
		const cwd = resolve(options.cwd);
		const configMaxMessages = options.configMaxMessages ?? DEFAULT_CONFIG_MAX_MESSAGES;
		const state = createGroupChatState({
			groupChatId,
			createdAt,
			groupMaxMessages: configMaxMessages,
		});
		const sessionStore = SessionStore.create(
			SessionManager,
			cwd,
			getGroupChatSessionDirectory(options.agentDir, cwd),
			{ id: groupChatId },
			{ writeFile: dependencies.writeFile, rm: dependencies.rm },
		);
		const webSocketServer = await listenOnLocalhost(`/${groupChatId}/${instanceId}`);
		const address = webSocketServer.address() as AddressInfo;
		const activeDescriptor: ActiveGroupChatDescriptor = {
			instanceId,
			groupChatId,
			name: null,
			cwd,
			pid: dependencies.pid,
			host: "127.0.0.1",
			port: address.port,
			startedAt: createdAt,
		};
		const activeDescriptorPath = getActiveDescriptorPath(options.agentDir, cwd, groupChatId);
		const runtime = new CreatorRuntime(
			webSocketServer,
			sessionStore,
			state,
			activeDescriptor,
			activeDescriptorPath,
			configMaxMessages,
			options.characters ?? [],
			dependencies.readyTimeoutMs,
			dependencies,
		);

		try {
			await dependencies.publishDescriptor(options.agentDir, activeDescriptor);
			runtime.attachServerHandler();
			return runtime;
		} catch (error) {
			await removeOwnedActiveDescriptor(activeDescriptorPath, instanceId);
			await closeWebSocketServer(webSocketServer);
			throw error;
		}
	}

	/**
	 * 从群聊历史 JSONL 文件恢复此前持久化的群聊。从会话条目重建 name、
	 * groupMaxMessages、Round、next sequence 与公开消息列表；分配全新
	 * instance_id 与端口；不恢复任何成员连接。发布 active descriptor 即
	 * 原子排他声明——并发 resume 的群聊在硬链接竞争上失败。
	 */
	static async resume(
		options: ResumeCreatorRuntimeOptions,
		dependencyOverrides: Partial<CreatorRuntimeDependencies> = {},
	): Promise<CreatorRuntime> {
		const dependencies: CreatorRuntimeDependencies = {
			createId: randomUUID,
			now: () => new Date(),
			pid: process.pid,
			readyTimeoutMs: SHORT_COORDINATION_TIMEOUT_MS,
			publishDescriptor: publishActiveDescriptor,
			writeFile: (path, data) => writeFile(path, data),
			rm: (path) => rm(path, { force: true }),
			heartbeatIntervalMs: HEARTBEAT_PING_INTERVAL_MS,
			heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
			drainTimeoutMs: SHORT_COORDINATION_TIMEOUT_MS,
			...dependencyOverrides,
		};
		const cwd = resolve(options.cwd);
		const configMaxMessages = options.configMaxMessages ?? DEFAULT_CONFIG_MAX_MESSAGES;
		// 前置拒绝缺失/空文件：SessionManager.open() 在文件不存在或为空时静默
		// 创建全新随机会话，会导致为幽灵群聊发布 active descriptor。
		const sessionStat = statSync(options.sessionPath, { throwIfNoEntry: false });
		if (!sessionStat?.isFile() || sessionStat.size === 0) {
			throw new Error(`Group chat session file does not exist or is empty: ${options.sessionPath}`);
		}
		const sessionStore = SessionStore.open(
			SessionManager,
			options.sessionPath,
			getGroupChatSessionDirectory(options.agentDir, cwd),
			cwd,
			{ writeFile: dependencies.writeFile, rm: dependencies.rm },
		);
		const header = sessionStore.getHeader();
		if (!header?.id) {
			throw new Error("Group chat session file has no id header");
		}

		// 活跃实例排他：已活跃的群聊不可被 resume。
		const activeDescriptorPath = getActiveDescriptorPath(options.agentDir, cwd, header.id);
		const existingActive = await readActiveDescriptor(activeDescriptorPath);
		if (existingActive) {
			throw new Error(`Group chat ${header.id} is already active; leave the active group chat before resuming`);
		}

		// 按文件顺序扫描会话条目重建 PiTavern 扩展状态。
		const entries = sessionStore.getEntries();
		const publicMessages: PublicMessageState[] = [];
		let name: string | null = null;
		let groupMaxMessages = configMaxMessages;
		let round: GroupChatState["round"] = null;
		let nextSequence = 0;
		const persistedCount = countPersistedEntries(entries);
		for (const entry of entries) {
			if (entry.type === "session_info") {
				name = entry.name?.trim() || null;
			} else if (entry.type === "custom" && entry.customType === "pi-tavern.group-settings") {
				const max = (entry.data as { group_max_messages?: number } | undefined)?.group_max_messages;
				if (typeof max === "number" && Number.isSafeInteger(max) && max >= 0) {
					groupMaxMessages = max;
				}
			} else if (entry.type === "custom_message" && entry.customType === "pi-tavern.public-message") {
				const details = entry.details as
					| {
							sender: { type: "user_persona" } | { type: "character"; character_id: string; name: string };
							content: string;
							sequence: number;
							round: {
								round_max_messages: number;
								used_messages: number;
								remaining_messages: number;
							};
					  }
					| undefined;
				if (!details || typeof details.sequence !== "number") {
					continue;
				}
				publicMessages.push({
					sender: details.sender,
					content: details.content,
					event_id: entry.id,
					sequence: details.sequence,
					timestamp: entry.timestamp,
					round: details.round,
				});
				nextSequence = details.sequence;
				round = {
					roundMaxMessages: details.round.round_max_messages,
					usedMessages: details.round.used_messages,
				};
			}
		}

		const createdAt = header.timestamp;
		const state = createGroupChatState({
			groupChatId: header.id,
			createdAt,
			groupMaxMessages,
		});
		state.groupChat.name = name;
		state.round = round;
		state.nextSequence = nextSequence;

		// 全新运行时身份：新 instance_id 与新端口；无成员连接。
		const instanceId = dependencies.createId();
		const startedAt = dependencies.now().toISOString();
		const webSocketServer = await listenOnLocalhost(`/${header.id}/${instanceId}`);
		const address = webSocketServer.address() as AddressInfo;
		const activeDescriptor: ActiveGroupChatDescriptor = {
			instanceId,
			groupChatId: header.id,
			name,
			cwd,
			pid: dependencies.pid,
			host: "127.0.0.1",
			port: address.port,
			startedAt,
		};
		const runtime = new CreatorRuntime(
			webSocketServer,
			sessionStore,
			state,
			activeDescriptor,
			activeDescriptorPath,
			configMaxMessages,
			options.characters ?? [],
			dependencies.readyTimeoutMs,
			dependencies,
			{ publicMessages, persistedCount },
		);

		try {
			await dependencies.publishDescriptor(options.agentDir, activeDescriptor);
			runtime.attachServerHandler();
			return runtime;
		} catch (error) {
			await removeOwnedActiveDescriptor(activeDescriptorPath, instanceId);
			await closeWebSocketServer(webSocketServer);
			throw error;
		}
	}

	/**
	 * 为 reload 分离运行时：保持稳定成员与 WebSocket 服务器存活，缓冲
	 * reload 窗口内的帧，发布一次性 handoff。未完成上线的连接被释放并关闭；
	 * reload 窗口内到达的新连接立即被拒绝。
	 */
	async detachForReload(piSessionId: string): Promise<CreatorReloadHandoff> {
		if (this.lifecycle !== "active") {
			throw new Error("CreatorRuntime is not active");
		}
		this.lifecycle = "detaching";
		this.stopHeartbeat();
		await this.drainRuntimeQueue(this.deps.drainTimeoutMs);

		// 释放从未完成 character_ready 的连接。
		for (const socket of this.webSocketServer.clients) {
			const connection = this.connectionBySocket.get(socket);
			if (connection && (!connection.online || connection.sessionId === null)) {
				this.releaseReservation(connection);
				socket.close(1001, "Group chat closed");
			}
		}

		// 服务器保持在同一端口监听；reload 窗口内到达的新连接被立即拒绝。
		this.webSocketServer.removeAllListeners("connection");
		this.serverConnectionHandler = null;
		this.rejectConnectionsHandler = (socket) => socket.close(1001, "Group chat closed");
		this.webSocketServer.on("connection", this.rejectConnectionsHandler);

		// 缓冲 reload 窗口内的帧并按成员记录断连。
		const bufferedFrames = new Map<string, BufferedFrame[]>();
		const bufferingHandlers = new Map<string, { message: (data: WebSocket.RawData) => void; close: () => void }>();
		const closedSessionIds = new Set<string>();
		for (const [sessionId, socket] of this.connections) {
			const connection = this.connectionBySocket.get(socket);
			if (connection) {
				this.detachSocketHandlers(socket, connection);
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
			expiresAt: Date.now() + this.deps.drainTimeoutMs,
			webSocketServer: this.webSocketServer,
			groupSessionManager: this.groupSessionManager,
			groupChatState: this.state,
			connections: this.connections,
			heartbeatStates: this.heartbeatStates,
			activeDescriptor: this.activeDescriptor,
			activeDescriptorPath: this.activeDescriptorPath,
			configMaxMessages: this.configMaxMessages,
			characters: [...this.characters.values()],
			publicMessages: [...this.publicMessages],
			persistedCount: this.persistedCount,
			bufferedFrames,
			bufferingHandlers,
			closedSessionIds,
			cleanup: async () => {
				for (const socket of this.connections.values()) {
					socket.close(1001, "Group chat closed");
				}
				await closeWebSocketServer(this.webSocketServer);
				await removeOwnedActiveDescriptor(this.activeDescriptorPath, this.activeDescriptor.instanceId);
				this.connections.clear();
				this.heartbeatStates.clear();
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
	static async takeHandoff(
		handoff: CreatorReloadHandoff,
		dependencyOverrides: Partial<CreatorRuntimeDependencies> = {},
	): Promise<CreatorRuntime> {
		const dependencies: CreatorRuntimeDependencies = {
			createId: randomUUID,
			now: () => new Date(),
			pid: process.pid,
			readyTimeoutMs: SHORT_COORDINATION_TIMEOUT_MS,
			publishDescriptor: publishActiveDescriptor,
			writeFile: (path, data) => writeFile(path, data),
			rm: (path) => rm(path, { force: true }),
			heartbeatIntervalMs: HEARTBEAT_PING_INTERVAL_MS,
			heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
			drainTimeoutMs: SHORT_COORDINATION_TIMEOUT_MS,
			...dependencyOverrides,
		};
		const sessionStore = new SessionStore(
			handoff.groupSessionManager,
			SessionManager,
			{ writeFile: dependencies.writeFile, rm: dependencies.rm },
		);
		const runtime = new CreatorRuntime(
			handoff.webSocketServer,
			sessionStore,
			handoff.groupChatState,
			handoff.activeDescriptor,
			handoff.activeDescriptorPath,
			handoff.configMaxMessages,
			handoff.characters,
			dependencies.readyTimeoutMs,
			dependencies,
			{ publicMessages: handoff.publicMessages, persistedCount: handoff.persistedCount },
		);

		// 把连接表与心跳状态移入新运行时。
		runtime.connections.clear();
		for (const [sessionId, socket] of handoff.connections) {
			runtime.connections.set(sessionId, socket);
		}
		runtime.heartbeatStates.clear();
		for (const [sessionId, state] of handoff.heartbeatStates) {
			runtime.heartbeatStates.set(sessionId, { lastPongAt: state.lastPongAt });
		}

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
			runtime.connectionBySocket.set(socket, connection);
			runtime.attachSocketHandlers(socket, connection);
		}

		// 按接收顺序回放 reload 窗口内的帧，然后清理窗口期间断连的成员。
		for (const [sessionId, frames] of handoff.bufferedFrames) {
			const socket = runtime.connections.get(sessionId);
			const connection = socket ? runtime.connectionBySocket.get(socket) : undefined;
			if (!socket || !connection) {
				continue;
			}
			for (const frame of [...frames].sort((a, b) => a.receivedAt - b.receivedAt)) {
				await runtime.handleSocketMessage(socket, connection, frame.data, false);
			}
		}
		for (const sessionId of handoff.closedSessionIds) {
			const socket = runtime.connections.get(sessionId);
			const connection = socket ? runtime.connectionBySocket.get(socket) : undefined;
			if (socket && connection) {
				runtime.removeOnlineCharacter(connection, "disconnected");
			}
		}

		runtime.attachServerHandler();
		return runtime;
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
		return this.enqueue(async () => {
			this.sessionStore.assertWritable();

			const contentBytes = Buffer.byteLength(content, "utf8");
			if (contentBytes > 64 * 1024) {
				throw new Error("User Persona message exceeds 64 KiB");
			}

			// 计算候选状态值（仅在持久化成功后提交）
			const roundMaxMessages = this.state.groupChat.groupMaxMessages;
			const sequence = this.state.nextSequence + 1;
			const timestamp = new Date().toISOString();
			let entryId: string;

			// 首次持久化：先用 header 种子文件，之后全部走 append API，使 ID、
			// parentId 链与信封都由 SessionManager 管理（persistence.md L6-8）。
			// 位标记状态机 + 部分失败精细回滚收在 session-store 内。
			if (this.persistedCount === 0) {
				const sessionPath = this.sessionStore.getSessionFilePath();
				// 用规范 createdAt，使 header 时间戳与状态、descriptor 一致
				// （运行时仍展开完整 header：type/version/cwd 等由真实实例供给）。
				const header = {
					...this.sessionStore.getHeader(),
					timestamp: this.state.groupChat.createdAt,
				} as SessionHeaderLike;

				const result = await this.sessionStore.persistFirstMessage({
					sessionPath,
					header,
					groupChatId: this.state.groupChat.groupChatId,
					name: this.state.groupChat.name,
					groupMaxMessages: roundMaxMessages,
					sequence,
					content,
				});
				entryId = result.entryId;
				this.persistedCount += result.entriesPersisted;
			} else {
				try {
					entryId = this.sessionStore.appendCustomMessageEntry(
						"pi-tavern.public-message",
						formatEntryContent("User Persona", content),
						true,
					{
						sender: { type: "user_persona" as const },
						content,
						sequence,
						round: {
							round_max_messages: roundMaxMessages,
							used_messages: 0,
							remaining_messages: roundMaxMessages,
						},
					},
				);
				this.persistedCount++;
			} catch (error) {
				// SessionManager._appendEntry 在磁盘写入前先改内存。
				// 失败时把未持久化的条目从内存清除（恢复编排在 store 内）。
				this.sessionStore.recoverFromFailedAppend(error);
			}
		}

			// 从 SessionManager 读真实条目时间戳，保证磁盘信封与广播/显示时间戳
			// 一致（finding 3）。
			const persisted = this.sessionStore.getEntry(entryId);
			const entryTimestamp = persisted?.timestamp ?? timestamp;

			// 仅在持久化成功后提交状态
			this.state.round = { roundMaxMessages, usedMessages: 0 };
			this.state.nextSequence = sequence;
			// 清除上一轮的手举标志（仅成功时）
			for (const character of this.state.onlineCharacters.values()) {
				character.handRaised = false;
			}

			const message = {
				sender: { type: "user_persona" as const },
				content,
				event_id: entryId,
				sequence,
				timestamp: entryTimestamp,
				round: { round_max_messages: roundMaxMessages, used_messages: 0, remaining_messages: roundMaxMessages },
			};
			this.publicMessages.push(message);

			// 广播与 TUI 投影相互独立——互不阻塞
			try {
				this.broadcastGroupChatUpdate();
			} catch {
				// 广播失败静默吞掉——对状态与 TUI 无影响
			}

			try {
				this.onPublicMessage?.(message);
			} catch (error) {
				this.onPublicMessageError?.(
					`TUI projection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
					message.sequence,
					message.timestamp,
				);
			}

			return entryId;
		});
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
		this.stopHeartbeat();
		const timedOut = await this.drainRuntimeQueue(this.deps.drainTimeoutMs);

		try {
			this.broadcast({
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
		this.heartbeatStates.clear();
		try {
			await removeOwnedActiveDescriptor(this.activeDescriptorPath, this.activeDescriptor.instanceId);
		} catch (error) {
			errors.push(asError(error));
		}
		return { timedOut, errors };
	}

	/** 等待运行时队列排空，最长 timeoutMs；超时返回 true。 */
	private async drainRuntimeQueue(timeoutMs: number): Promise<boolean> {
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

	private startHeartbeat(): void {
		if (this.heartbeatTimer) {
			return;
		}
		this.heartbeatTimer = setInterval(() => this.heartbeatTick(), this.deps.heartbeatIntervalMs);
		this.heartbeatTimer.unref?.();
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private heartbeatTick(): void {
		const now = this.deps.now().getTime();
		for (const [sessionId, socket] of this.connections) {
			const state = this.heartbeatStates.get(sessionId);
			if (!state) {
				continue;
			}
			if (now - state.lastPongAt > this.deps.heartbeatTimeoutMs) {
				// 半开连接：terminate 触发 close → 统一断连清理。
				socket.terminate();
				continue;
			}
			socket.ping();
		}
	}

	/** 安装服务器连接处理器（reload 接管后也使用）。 */
	private attachServerHandler(): void {
		this.webSocketServer.removeAllListeners("connection");
		this.rejectConnectionsHandler = null;
		this.serverConnectionHandler = (socket) => this.handleConnection(socket);
		this.webSocketServer.on("connection", this.serverConnectionHandler);
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
				void this.enqueue(() => this.handleSocketMessage(socket, connection, data, isBinary));
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

	private detachSocketHandlers(socket: WebSocket, connection: ConnectionContext): void {
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

	private async handleSocketMessage(
		socket: WebSocket,
		connection: ConnectionContext,
		data: WebSocket.RawData,
		isBinary: boolean,
	): Promise<void> {
		if (isBinary) {
			socket.close(1002, "Binary frames are not supported");
			return;
		}
		if (this.lifecycle !== "active") {
			socket.close(1001, "Group chat closed");
			return;
		}
		let message: ClientMessage;
		try {
			message = decodeClientMessage(data);
		} catch {
			socket.close(1002, "Protocol error");
			return;
		}
		try {
			await this.handleClientMessage(socket, connection, message);
		} catch (error) {
			if (this.lifecycle === "active") {
				const errorMessage = error instanceof Error ? error.message : String(error);
				socket.close(1011, errorMessage);
			}
		}
	}

	private handleSocketPong(connection: ConnectionContext): void {
		if (connection.sessionId !== null) {
			const state = this.heartbeatStates.get(connection.sessionId);
			if (state) {
				state.lastPongAt = this.deps.now().getTime();
			}
		}
	}

	private handleSocketClose(connection: ConnectionContext): void {
		void this.enqueue(() => {
			this.releaseReservation(connection);
			this.removeOnlineCharacter(connection, "disconnected");
		});
	}

	private async handleClientMessage(
		socket: WebSocket,
		connection: ConnectionContext,
		message: ClientMessage,
	): Promise<void> {
		switch (message.type) {
			case "join_group_chat":
				this.handleJoinGroupChat(socket, connection, message);
				return;
			case "claim_character":
				this.handleClaimCharacter(socket, connection, message);
				return;
			case "character_ready":
				this.handleCharacterReady(socket, connection, message);
				return;
			case "get_group_chat_state":
				this.handleGetGroupChatState(socket, connection, message);
				return;
			case "get_message_history":
				this.handleGetMessageHistory(socket, connection, message);
				return;
			case "fetch_messages_since":
				this.handleFetchMessagesSince(socket, connection, message);
				return;
			case "get_chat_history_file":
				this.handleGetChatHistoryFile(socket, connection, message);
				return;
			case "update_character_state":
				this.handleUpdateCharacterState(connection, message.is_streaming);
				return;
			case "leave_group_chat":
				this.handleLeaveGroupChat(socket, connection, message);
				return;
			case "speak":
				await this.handleSpeak(socket, connection, message);
				return;
		}
	}

	private handleJoinGroupChat(
		socket: WebSocket,
		connection: ConnectionContext,
		message: Extract<ClientMessage, { type: "join_group_chat" }>,
	): void {
		if (
			connection.online ||
			this.connections.has(message.session_id) ||
			(connection.sessionId !== null && connection.sessionId !== message.session_id)
		) {
			this.sendFailure(socket, message.id, "join_group_chat", "This pi session is already in the group chat");
			return;
		}

		connection.sessionId = message.session_id;
		this.send(socket, {
			...(message.id !== undefined ? { id: message.id } : {}),
			type: "response",
			command: "join_group_chat",
			success: true,
			data: {
				available_characters: this.getAvailableCharacters().map(toCharacterSummaryMessage),
			},
		});
	}

	private handleClaimCharacter(
		socket: WebSocket,
		connection: ConnectionContext,
		message: Extract<ClientMessage, { type: "claim_character" }>,
	): void {
		const character = this.characters.get(message.character_id);
		if (
			connection.sessionId === null ||
			connection.online ||
			connection.reservedCharacterId !== null ||
			!character ||
			!this.isCharacterAvailable(message.character_id)
		) {
			this.sendFailure(socket, message.id, "claim_character", "Character is no longer available");
			return;
		}

		this.state.characterReservations.set(character.characterId, connection.sessionId);
		connection.reservedCharacterId = character.characterId;
		this.startReadyTimer(socket, connection);
		this.send(socket, {
			...(message.id !== undefined ? { id: message.id } : {}),
			type: "response",
			command: "claim_character",
			success: true,
			data: {
				character: {
					...toCharacterSummaryMessage(character),
					path: character.path,
				},
			},
		});
	}

	private handleCharacterReady(
		socket: WebSocket,
		connection: ConnectionContext,
		message: Extract<ClientMessage, { type: "character_ready" }>,
	): void {
		const { sessionId, reservedCharacterId } = connection;
		const character = reservedCharacterId ? this.characters.get(reservedCharacterId) : undefined;
		if (
			sessionId === null ||
			reservedCharacterId === null ||
			!character ||
			connection.online ||
			this.state.characterReservations.get(reservedCharacterId) !== sessionId
		) {
			this.sendFailure(socket, message.id, "character_ready", "Character reservation is no longer valid");
			return;
		}
		if (this.connections.has(sessionId)) {
			this.sendFailure(socket, message.id, "character_ready", "This pi session is already in the group chat");
			return;
		}

		this.clearReadyTimer(connection);
		this.state.characterReservations.delete(reservedCharacterId);
		connection.reservedCharacterId = null;
		this.connections.set(sessionId, socket);
		this.heartbeatStates.set(sessionId, { lastPongAt: this.deps.now().getTime() });
		this.state.onlineCharacters.set(sessionId, {
			sessionId,
			character: toCharacterSummary(character),
			isStreaming: false,
			handRaised: false,
		});
		connection.online = true;

		this.send(socket, {
			...(message.id !== undefined ? { id: message.id } : {}),
			type: "response",
			command: "character_ready",
			success: true,
		});

		// 在 join 广播前发送历史，使新 Character 处理自己的 character_joined
		// 事件时 hasPublicMessages 已为 true。
		// User 2026-08-01：join 推送窗口 10 → JOIN_HISTORY_LIMIT（100）。
		const recentMessages = this.publicMessages.slice(-JOIN_HISTORY_LIMIT);
		const earliest = recentMessages[0];
		const hasMore = earliest !== undefined && earliest.sequence > 1;
		this.send(socket, {
			type: "message_history",
			messages: recentMessages.map((m) => ({
				type: "public_message" as const,
				event_id: m.event_id,
				sequence: m.sequence,
				timestamp: m.timestamp,
				sender: m.sender,
				content: m.content,
				round: m.round,
			})),
			cursor: hasMore ? encodeCursor(earliest.sequence) : null,
			has_more: hasMore,
			total_messages: this.publicMessages.length,
		});

		// 在 message_history 之后广播 character_joined，使新 Character 处理
		// 自己的 join 事件时 hasPublicMessages 已为 true。
		this.broadcast({
			type: "character_joined",
			character: toCharacterSummaryMessage(character),
		});
		this.onMembersChanged?.();
		// ISSUE-014/#14（方案 A）：成员变化也经 M7 通知通道唤醒角色，使即使
		// 没有新消息到达时其 widget 快照也刷新。
		this.broadcastGroupChatUpdate();
	}

	private handleGetGroupChatState(
		socket: WebSocket,
		connection: ConnectionContext,
		message: Extract<ClientMessage, { type: "get_group_chat_state" }>,
	): void {
		if (!connection.online || connection.sessionId === null) {
			this.sendFailure(socket, message.id, "get_group_chat_state", "Character is not in the group chat");
			return;
		}
		this.send(socket, {
			...(message.id !== undefined ? { id: message.id } : {}),
			type: "response",
			command: "get_group_chat_state",
			success: true,
			data: this.getGroupChatStateMessage(connection.sessionId),
		});
	}

	private handleGetMessageHistory(
		socket: WebSocket,
		connection: ConnectionContext,
		message: Extract<ClientMessage, { type: "get_message_history" }>,
	): void {
		if (!connection.online || connection.sessionId === null) {
			this.sendFailure(socket, message.id, "get_message_history", "Character is not in the group chat");
			return;
		}

		// 游标是绝对 sequence 边界：返回 sequence < cursorSeq 的最近 10 条。
		// 新消息不会使其移位。
		// 注：分页大小保持 10（增量分页粒度）；只有 join 推送窗口用
		// JOIN_HISTORY_LIMIT（User 2026-08-01）。
		const cursorSeq = message.cursor === undefined || message.cursor === null ? null : decodeCursor(message.cursor);
		const page =
			cursorSeq === null
				? this.publicMessages.slice(-10)
				: this.publicMessages.filter((m) => m.sequence < cursorSeq).slice(-10);
		const earliest = page[0];
		const hasMore = earliest !== undefined && earliest.sequence > 1;

		this.send(socket, {
			...(message.id !== undefined ? { id: message.id } : {}),
			type: "response",
			command: "get_message_history",
			success: true,
			data: {
				messages: page.map((m) => ({
					type: "public_message" as const,
					event_id: m.event_id,
					sequence: m.sequence,
					timestamp: m.timestamp,
					sender: m.sender,
					content: m.content,
					round: m.round,
				})),
				cursor: hasMore ? encodeCursor(earliest.sequence) : null,
				has_more: hasMore,
				total_messages: this.publicMessages.length,
			},
		});
	}

	private handleFetchMessagesSince(
		socket: WebSocket,
		connection: ConnectionContext,
		message: Extract<ClientMessage, { type: "fetch_messages_since" }>,
	): void {
		if (!connection.online || connection.sessionId === null) {
			this.sendFailure(socket, message.id, "fetch_messages_since", "Character is not in the group chat");
			return;
		}

		// 增量拉取（M7/ISSUE-012）：返回客户端游标之后的全部消息。sequence
		// 过滤天然补洞——漏掉的通知由下一次拉取自愈。
		const since = message.since_sequence;
		const increment = this.publicMessages.filter((m) => m.sequence > since);
		const latest = this.publicMessages[this.publicMessages.length - 1];

		this.send(socket, {
			...(message.id !== undefined ? { id: message.id } : {}),
			type: "response",
			command: "fetch_messages_since",
			success: true,
			data: {
				messages: increment.map((m) => ({
					type: "public_message" as const,
					event_id: m.event_id,
					sequence: m.sequence,
					timestamp: m.timestamp,
					sender: m.sender,
					content: m.content,
					round: m.round,
				})),
				latest_sequence: latest?.sequence ?? since,
				total_messages: this.publicMessages.length,
			},
		});
	}

	private handleGetChatHistoryFile(
		socket: WebSocket,
		connection: ConnectionContext,
		message: Extract<ClientMessage, { type: "get_chat_history_file" }>,
	): void {
		if (!connection.online || connection.sessionId === null) {
			this.sendFailure(socket, message.id, "get_chat_history_file", "Character is not in the group chat");
			return;
		}

		let path: string;
		try {
			path = this.sessionStore.getSessionFilePath();
		} catch {
			this.sendFailure(socket, message.id, "get_chat_history_file", "Group chat has no chat history file yet");
			return;
		}
		// 文件在首次持久化后才存在；SessionManager 在文件写入前可能已知路径。
		if (this.persistedCount === 0) {
			this.sendFailure(socket, message.id, "get_chat_history_file", "Group chat has no chat history file yet");
			return;
		}
		this.send(socket, {
			...(message.id !== undefined ? { id: message.id } : {}),
			type: "response",
			command: "get_chat_history_file",
			success: true,
			data: { path },
		});
	}

	private handleUpdateCharacterState(connection: ConnectionContext, isStreaming: boolean): void {
		if (!connection.online || connection.sessionId === null) {
			return;
		}
		const onlineCharacter = this.state.onlineCharacters.get(connection.sessionId);
		if (onlineCharacter) {
			onlineCharacter.isStreaming = isStreaming;
		}
		this.onMembersChanged?.();
		// ISSUE-014/#14（方案 A）：流式翻转是最频繁的成员状态变化——广播更新
		// 通知使每个角色刷新快照（widget「正在发言」保持实时）。
		this.broadcastGroupChatUpdate();
	}

	private async handleSpeak(
		socket: WebSocket,
		connection: ConnectionContext,
		message: Extract<ClientMessage, { type: "speak" }>,
	): Promise<void> {
		if (!connection.online || connection.sessionId === null) {
			this.sendFailure(socket, message.id, "speak", "Character is not a group member");
			return;
		}

		const contentBytes = Buffer.byteLength(message.content, "utf8");
		if (contentBytes > 64 * 1024) {
			this.sendFailure(socket, message.id, "speak", "Message exceeds 64 KiB");
			return;
		}

		const onlineCharacter = this.state.onlineCharacters.get(connection.sessionId);
		if (!onlineCharacter) {
			this.sendFailure(socket, message.id, "speak", "Character is not a group member");
			return;
		}

		const round = this.state.round;
		if (!round) {
			this.sendFailure(socket, message.id, "speak", "No active round");
			return;
		}

		// ISSUE-013 B2：陈旧性检查——仅当客户端发送了 based_on_sequence 时
		// 生效。legacy 客户端省略该字段则完全跳过检查（平滑协议演进）。陈旧
		// speak 是业务性拒绝（与 round_limit_reached 对称）：不发布、不耗配额、
		// 不举手。
		//
		// B6：检查排除请求者自己的消息——客户端单一游标从不越过自己发布的
		// 消息（echo 在客户端侧过滤），朴素的「最新 sequence」比较会错误拒绝
		// 针对自身的下一次 speak。尾扫找最近一条他人消息：无额外状态，且请求者
		// 的尾部 run 通常为 0-1 条。
		let latestOtherSequence = 0;
		for (let i = this.publicMessages.length - 1; i >= 0; i--) {
			const candidate = this.publicMessages[i];
			if (candidate === undefined) {
				continue;
			}
			if (
				candidate.sender.type === "character" &&
				candidate.sender.character_id === onlineCharacter.character.characterId
			) {
				continue;
			}
			latestOtherSequence = candidate.sequence;
			break;
		}
		const latestPublic = this.publicMessages[this.publicMessages.length - 1];
		const latestSequence = latestPublic !== undefined ? latestPublic.sequence : 0;
		if (message.based_on_sequence !== undefined && message.based_on_sequence < latestOtherSequence) {
			// missing_sequences 是到最新 sequence 的普通连续区间（仅信息性）：
			// 客户端经 fetch_messages_since 从游标重拉，isOwnEcho 过滤自己的
			// 消息——这里无需精确的他人消息区间。
			this.send(socket, {
				...(message.id !== undefined ? { id: message.id } : {}),
				type: "response",
				command: "speak",
				success: true,
				data: {
					published: false,
					reason: "stale",
					missing_sequences: {
						from: message.based_on_sequence + 1,
						to: latestSequence,
					},
					round: {
						round_max_messages: round.roundMaxMessages,
						used_messages: round.usedMessages,
						remaining_messages: Math.max(0, round.roundMaxMessages - round.usedMessages),
					},
				},
			});
			return;
		}

		const canPublish = round.usedMessages < round.roundMaxMessages;

		// 持久化损坏时连非发布型 speak 也拒绝（状态无法安全变更）。
		try {
			this.sessionStore.assertWritable();
		} catch (error) {
			this.sendFailure(socket, message.id, "speak", error instanceof Error ? error.message : String(error));
			return;
		}

		if (canPublish) {
			const newUsed = round.usedMessages + 1;
			const roundMaxMessages = round.roundMaxMessages;
			const sequence = this.state.nextSequence + 1;
			const timestamp = new Date().toISOString();

			const senderName = onlineCharacter.character.name;
			const details = {
				sender: {
					type: "character" as const,
					character_id: onlineCharacter.character.characterId,
					name: senderName,
				},
				content: message.content,
				sequence,
				round: {
					round_max_messages: roundMaxMessages,
					used_messages: newUsed,
					remaining_messages: Math.max(0, roundMaxMessages - newUsed),
				},
			};

			let entryId: string;
			try {
				// 初始化后的写入走 SessionManager 的 append API
				entryId = this.sessionStore.appendCustomMessageEntry(
					"pi-tavern.public-message",
					formatEntryContent(senderName, message.content),
					true,
					details,
				);
			} catch (error) {
				// SessionManager._appendEntry 在磁盘写入前先改内存。
				// 把未持久化的条目从 byId/leafId 清除（恢复编排在 store 内）。
				const reportError = this.sessionStore.recoverFromFailedAppendAndCatch(error);
				this.sendFailure(socket, message.id, "speak", `Failed to persist message: ${reportError.message}`);
				return;
			}

			this.persistedCount++;

			// 从 SessionManager 读真实条目时间戳，保证一致性
			const persisted = this.sessionStore.getEntry(entryId);
			const entryTimestamp = persisted?.timestamp ?? timestamp;

			// 仅在持久化成功后提交状态
			round.usedMessages = newUsed;
			this.state.nextSequence = sequence;
			setHandRaised(this.state, connection.sessionId, false);

			const msg = {
				sender: {
					type: "character" as const,
					character_id: onlineCharacter.character.characterId,
					name: senderName,
				},
				content: message.content,
				event_id: entryId,
				sequence,
				timestamp: entryTimestamp,
				round: {
					round_max_messages: roundMaxMessages,
					used_messages: newUsed,
					remaining_messages: Math.max(0, roundMaxMessages - newUsed),
				},
			};
			this.publicMessages.push(msg);

			// 广播与 TUI 投影相互独立——互不阻塞
			try {
				this.broadcastGroupChatUpdate();
			} catch {
				// 广播失败静默吞掉
			}

			try {
				this.onPublicMessage?.(msg);
			} catch (error) {
				this.onPublicMessageError?.(
					`TUI projection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
					msg.sequence,
					msg.timestamp,
				);
			}

			this.send(socket, {
				...(message.id !== undefined ? { id: message.id } : {}),
				type: "response",
				command: "speak",
				success: true,
				data: {
					published: true,
					event_id: entryId,
					sequence,
					// ISSUE-013 B6：让客户端把 last-seen sequence 越过自己发布的
					// 消息（echo 在客户端侧过滤，因此拉取游标不会自行推进）。
					latest_sequence: sequence,
					round: msg.round,
				},
			});
		} else {
			setHandRaised(this.state, connection.sessionId, true);

			this.send(socket, {
				...(message.id !== undefined ? { id: message.id } : {}),
				type: "response",
				command: "speak",
				success: true,
				data: {
					published: false,
					reason: "round_limit_reached",
					hand_raised: true,
					round: {
						round_max_messages: round.roundMaxMessages,
						used_messages: round.usedMessages,
						remaining_messages: 0,
					},
				},
			});
		}
	}

	private handleLeaveGroupChat(
		socket: WebSocket,
		connection: ConnectionContext,
		message: Extract<ClientMessage, { type: "leave_group_chat" }>,
	): void {
		if (!connection.online) {
			this.sendFailure(socket, message.id, "leave_group_chat", "Character is not in the group chat");
			return;
		}

		this.removeOnlineCharacter(connection, "left");
		this.send(socket, {
			...(message.id !== undefined ? { id: message.id } : {}),
			type: "response",
			command: "leave_group_chat",
			success: true,
		});
		socket.close(1000, "Left group chat");
	}

	private startReadyTimer(socket: WebSocket, connection: ConnectionContext): void {
		this.clearReadyTimer(connection);
		connection.readyTimer = setTimeout(() => {
			void this.enqueue(() => {
				if (!connection.online && connection.reservedCharacterId !== null) {
					this.releaseReservation(connection);
					socket.close(1008, "Character ready timeout");
				}
			});
		}, this.readyTimeoutMs);
	}

	private clearReadyTimer(connection: ConnectionContext): void {
		if (connection.readyTimer) {
			clearTimeout(connection.readyTimer);
			connection.readyTimer = null;
		}
	}

	private releaseReservation(connection: ConnectionContext): void {
		const characterId = connection.reservedCharacterId;
		if (characterId !== null && this.state.characterReservations.get(characterId) === connection.sessionId) {
			this.state.characterReservations.delete(characterId);
		}
		connection.reservedCharacterId = null;
		this.clearReadyTimer(connection);
	}

	private removeOnlineCharacter(connection: ConnectionContext, reason: "left" | "disconnected"): void {
		if (!connection.online || connection.sessionId === null) {
			return;
		}
		const onlineCharacter = this.state.onlineCharacters.get(connection.sessionId);
		connection.online = false;
		this.connections.delete(connection.sessionId);
		this.heartbeatStates.delete(connection.sessionId);
		this.state.onlineCharacters.delete(connection.sessionId);
		if (onlineCharacter) {
			this.broadcast({
				type: "character_left",
				character: toCharacterSummaryMessage(onlineCharacter.character),
				reason,
			});
		}
		this.onMembersChanged?.();
		// ISSUE-014/#14（方案 A）：离开也刷新其他成员的 widget。
		this.broadcastGroupChatUpdate();
	}

	private getAvailableCharacters(): CharacterCard[] {
		return [...this.characters.values()].filter((character) => this.isCharacterAvailable(character.characterId));
	}

	private isCharacterAvailable(characterId: string): boolean {
		if (this.state.characterReservations.has(characterId)) {
			return false;
		}
		return ![...this.state.onlineCharacters.values()].some((online) => online.character.characterId === characterId);
	}

	private getGroupChatStateMessage(requestingSessionId: string) {
		const { groupChat, round } = this.state;
		return {
			group_chat: {
				group_chat_id: groupChat.groupChatId,
				name: groupChat.name,
				created_at: groupChat.createdAt,
				group_max_messages: groupChat.groupMaxMessages,
			},
			round: round
				? {
						round_max_messages: round.roundMaxMessages,
						used_messages: round.usedMessages,
						remaining_messages: Math.max(0, round.roundMaxMessages - round.usedMessages),
					}
				: null,
			online_characters: [...this.state.onlineCharacters.values()].map((online) => ({
				...toCharacterSummaryMessage(online.character),
				is_self: online.sessionId === requestingSessionId,
				is_streaming: online.isStreaming,
				hand_raised: online.handRaised,
			})),
		};
	}

	private sendFailure(
		socket: WebSocket,
		id: string | undefined,
		command:
			| "join_group_chat"
			| "claim_character"
			| "character_ready"
			| "leave_group_chat"
			| "get_group_chat_state"
			| "get_message_history"
			| "fetch_messages_since"
			| "get_chat_history_file"
			| "speak",
		error: string,
	): void {
		this.send(socket, {
			...(id !== undefined ? { id } : {}),
			type: "response",
			command,
			success: false,
			error,
		});
	}

	private send(socket: WebSocket, message: unknown): void {
		try {
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(encodeMessage(message));
				return;
			}
		} catch {
			// 落入下面：socket 不可用。
		}
		// close/detach 期间由运行时自行清理；发送失败不得与终止流程竞争。
		if (this.lifecycle === "active") {
			this.handleSendFailure(socket);
		}
	}

	/**
	 * 把失败的发送引入统一断连清理。先从连接表移除 socket，使 character_left
	 * 广播不会递归命中同一个死 socket。
	 */
	private handleSendFailure(socket: WebSocket): void {
		const connection = this.connectionBySocket.get(socket);
		if (!connection || !connection.online || connection.sessionId === null) {
			return;
		}
		this.connections.delete(connection.sessionId);
		this.heartbeatStates.delete(connection.sessionId);
		void this.enqueue(() => {
			this.removeOnlineCharacter(connection, "disconnected");
		});
	}

	private broadcast(message: unknown): void {
		for (const socket of this.connections.values()) {
			this.send(socket, message);
		}
	}

	/**
	 * M7（ISSUE-012/#24）：广播 group_chat_update 通知而非完整 public_message
	 * 事件。角色收到通知后经 fetch_messages_since 拉取真实增量。preview 携带
	 * 最近消息（微信风格）；内容与拉取路径同源（publicMessages），UI 与
	 * agent 上下文永不分叉。
	 */
	private broadcastGroupChatUpdate(): void {
		const latest = this.publicMessages[this.publicMessages.length - 1];
		// ISSUE-014/#14（方案 A）：成员/流式变化可能先于任何公开消息到达——
		// 仍广播（latest_sequence 0、空 preview），使角色唤醒并刷新快照。
		if (!latest) {
			this.broadcast({
				type: "group_chat_update",
				latest_sequence: 0,
				preview_messages: [],
				total_messages: 0,
			});
			return;
		}
		this.broadcast({
			type: "group_chat_update",
			latest_sequence: latest.sequence,
			preview_messages: this.publicMessages.slice(-3).map((m) => ({
				type: "public_message" as const,
				event_id: m.event_id,
				sequence: m.sequence,
				timestamp: m.timestamp,
				sender: m.sender,
				content: m.content,
				round: m.round,
			})),
			total_messages: this.publicMessages.length,
		});
	}

	private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
		const task = this.runtimeTail.then(operation);
		this.runtimeTail = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}
}

interface ConnectionContext {
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

/** 成员心跳簿记（时间为 epoch 毫秒）。 */
interface HeartbeatState {
	lastPongAt: number;
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

async function listenOnLocalhost(path: string): Promise<WebSocketServer> {
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

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
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
