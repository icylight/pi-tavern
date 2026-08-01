import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import WebSocket, { WebSocketServer } from "ws";

import type { CharacterCard, CharacterSummary } from "../config/character-card.js";
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
} from "../discovery/active-descriptor.js";
import { decodeClientMessage, encodeMessage, MAX_WEBSOCKET_FRAME_BYTES } from "../protocol/codec.js";
import type { ClientMessage } from "../protocol/messages.js";
import {
	HEARTBEAT_PING_INTERVAL_MS,
	HEARTBEAT_TIMEOUT_MS,
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

export interface PublicMessageState {
	sender: { type: "user_persona" } | { type: "character"; character_id: string; name: string };
	content: string;
	event_id: string;
	sequence: number;
	timestamp: string;
	round: { round_max_messages: number; used_messages: number; remaining_messages: number };
}

interface PersistedRuntimeState {
	publicMessages: PublicMessageState[];
	persistedCount: number;
}

/**
 * Opaque history cursor. Encodes the sequence boundary: a request with
 * this cursor returns messages with sequence < seq. Absolute sequence
 * keeps the cursor position stable while new messages arrive.
 */
function encodeCursor(sequence: number): string {
	return Buffer.from(JSON.stringify({ v: 1, seq: sequence })).toString("base64url");
}

function decodeCursor(cursor: string): number | null {
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: number; seq?: number };
		if (parsed.v !== 1 || typeof parsed.seq !== "number" || !Number.isSafeInteger(parsed.seq)) {
			return null;
		}
		return parsed.seq;
	} catch {
		return null;
	}
}

export interface CreatorRuntimeDependencies {
	createId: () => string;
	now: () => Date;
	pid: number;
	readyTimeoutMs: number;
	publishDescriptor: (agentDir: string, descriptor: ActiveGroupChatDescriptor) => Promise<string>;
	writeFile: (path: string, data: string) => Promise<void>;
	rm: (path: string) => Promise<void>;
	/** Interval between WebSocket heartbeat pings (defaults to 30s). */
	heartbeatIntervalMs: number;
	/** Pong timeout threshold (defaults to 120s); overdue members are terminated. */
	heartbeatTimeoutMs: number;
	/** How long close()/detachForReload() waits for the runtime queue to drain. */
	drainTimeoutMs: number;
}

const DEFAULT_CONFIG_MAX_MESSAGES = 10;

/** Bit flags tracking first-persist milestones for granular rollback on failure. */
const FIRST_PERSIST_HEADER_WRITTEN = 1 << 0;
const FIRST_PERSIST_SESSION_OPENED = 1 << 1;
const FIRST_PERSIST_NAME_APPENDED = 1 << 2;
const FIRST_PERSIST_SETTINGS_APPENDED = 1 << 3;
const FIRST_PERSIST_MESSAGE_APPENDED = 1 << 4;

export class CreatorRuntime {
	readonly connections = new Map<string, WebSocket>();
	readonly characters: Map<string, CharacterCard>;

	/** Per-member heartbeat bookkeeping, keyed by pi session id. */
	readonly heartbeatStates = new Map<string, HeartbeatState>();

	private lifecycle: "active" | "detaching" | "disposed" = "active";
	private closePromise: Promise<RuntimeCloseResult> | null = null;
	private runtimeTail = Promise.resolve();
	private readonly deps: CreatorRuntimeDependencies;
	private persistedCount = 0;
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private serverConnectionHandler: ((socket: WebSocket) => void) | null = null;
	private rejectConnectionsHandler: ((socket: WebSocket) => void) | null = null;

	/** Maps each live socket back to its connection context for failure cleanup. */
	private readonly connectionBySocket = new WeakMap<WebSocket, ConnectionContext>();

	/** Set when the session file cannot be written or recovered. All mutating operations reject. */
	private persistenceFatal = false;

	/** Tracks which steps have completed during first-persist, for rollback on failure. */
	private firstPersistFlags = 0;

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

	/** Fired when online membership or streaming state changes (TUI refresh trigger). */
	onMembersChanged: (() => void) | undefined;

	private publicMessages: PublicMessageState[] = [];

	private constructor(
		readonly webSocketServer: WebSocketServer,
		private groupSessionManager: SessionManager,
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
		const groupSessionManager = SessionManager.create(cwd, getGroupChatSessionDirectory(options.agentDir, cwd), {
			id: groupChatId,
		});
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
			groupSessionManager,
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
	 * Resume a previously persisted group chat from its chat history JSONL file.
	 * Rebuilds name, groupMaxMessages, Round, next sequence, and the public
	 * message list from the session entries; allocates a fresh instance_id and
	 * port; restores no member connections. Publishing the active descriptor is
	 * the atomic exclusive claim — a concurrently resumed group chat loses the
	 * hard-link race and fails.
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
		// Reject missing or empty files up front: SessionManager.open() silently
		// creates a brand-new random session when the file does not exist or is
		// empty, which would publish an active descriptor for a phantom group chat.
		const sessionStat = statSync(options.sessionPath, { throwIfNoEntry: false });
		if (!sessionStat?.isFile() || sessionStat.size === 0) {
			throw new Error(`Group chat session file does not exist or is empty: ${options.sessionPath}`);
		}
		const groupSessionManager = SessionManager.open(
			options.sessionPath,
			getGroupChatSessionDirectory(options.agentDir, cwd),
			cwd,
		);
		const header = groupSessionManager.getHeader();
		if (!header?.id) {
			throw new Error("Group chat session file has no id header");
		}

		// Active instance exclusivity: an already active group chat cannot be resumed.
		const activeDescriptorPath = getActiveDescriptorPath(options.agentDir, cwd, header.id);
		const existingActive = await readActiveDescriptor(activeDescriptorPath);
		if (existingActive) {
			throw new Error(`Group chat ${header.id} is already active; leave the active group chat before resuming`);
		}

		// Rebuild PiTavern extension state by scanning the session entries in file order.
		const entries = groupSessionManager.getEntries();
		const publicMessages: PublicMessageState[] = [];
		let name: string | null = null;
		let groupMaxMessages = configMaxMessages;
		let round: GroupChatState["round"] = null;
		let nextSequence = 0;
		let persistedCount = 0;
		for (const entry of entries) {
			if (entry.type === "session_info") {
				persistedCount++;
				name = entry.name?.trim() || null;
			} else if (entry.type === "custom" && entry.customType === "pi-tavern.group-settings") {
				persistedCount++;
				const max = (entry.data as { group_max_messages?: number } | undefined)?.group_max_messages;
				if (typeof max === "number" && Number.isSafeInteger(max) && max >= 0) {
					groupMaxMessages = max;
				}
			} else if (entry.type === "custom_message" && entry.customType === "pi-tavern.public-message") {
				persistedCount++;
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

		// Fresh runtime identity: new instance_id and new port; no member connections.
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
			groupSessionManager,
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
	 * Detach the runtime for a reload: keep stable members and the WebSocket
	 * server alive, buffer reload-window frames, and publish a one-shot
	 * handoff. Not-yet-online connections are released and closed; new
	 * connections during the reload window are closed immediately.
	 */
	async detachForReload(piSessionId: string): Promise<CreatorReloadHandoff> {
		if (this.lifecycle !== "active") {
			throw new Error("CreatorRuntime is not active");
		}
		this.lifecycle = "detaching";
		this.stopHeartbeat();
		await this.drainRuntimeQueue(this.deps.drainTimeoutMs);

		// Release connections that never completed character_ready.
		for (const socket of this.webSocketServer.clients) {
			const connection = this.connectionBySocket.get(socket);
			if (connection && (!connection.online || connection.sessionId === null)) {
				this.releaseReservation(connection);
				socket.close(1001, "Group chat closed");
			}
		}

		// The server keeps listening on the same port; new connections during
		// the reload window are rejected immediately.
		this.webSocketServer.removeAllListeners("connection");
		this.serverConnectionHandler = null;
		this.rejectConnectionsHandler = (socket) => socket.close(1001, "Group chat closed");
		this.webSocketServer.on("connection", this.rejectConnectionsHandler);

		// Buffer reload-window frames and record disconnects per member.
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
	 * Take over a creator handoff published by the previous Extension Runtime:
	 * re-attaches member sockets with fresh handlers, replays buffered frames
	 * in received order, cleans up members that disconnected during the window,
	 * and resumes heartbeats. The group chat identity and listening port are
	 * preserved.
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
		const runtime = new CreatorRuntime(
			handoff.webSocketServer,
			handoff.groupSessionManager,
			handoff.groupChatState,
			handoff.activeDescriptor,
			handoff.activeDescriptorPath,
			handoff.configMaxMessages,
			handoff.characters,
			dependencies.readyTimeoutMs,
			dependencies,
			{ publicMessages: handoff.publicMessages, persistedCount: handoff.persistedCount },
		);

		// Move the connection table and heartbeat states into the new runtime.
		runtime.connections.clear();
		for (const [sessionId, socket] of handoff.connections) {
			runtime.connections.set(sessionId, socket);
		}
		runtime.heartbeatStates.clear();
		for (const [sessionId, state] of handoff.heartbeatStates) {
			runtime.heartbeatStates.set(sessionId, { lastPongAt: state.lastPongAt });
		}

		// Re-attach member sockets with fresh connection contexts and handlers.
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

		// Replay reload-window frames in received order, then clean up members
		// that disconnected during the window.
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

			// Empty group chat: update memory only (no file yet)
			if (!this.persistedCount) {
				await updateActiveDescriptorName(this.activeDescriptorPath, this.activeDescriptor.instanceId, normalizedName);
				setGroupChatName(this.state, name);
				this.activeDescriptor.name = normalizedName;
				return normalizedName;
			}

			this.assertWritable();

			// Active group chat: persist entry via SessionManager
			try {
				this.groupSessionManager.appendSessionInfo(normalizedName ?? "");
			} catch (error) {
				this.recoverSessionManagerFromFailedAppend(error);
			}
			this.persistedCount++;

			// Commit memory state (authoritative after successful persist)
			setGroupChatName(this.state, name);
			this.activeDescriptor.name = normalizedName;

			// Best-effort descriptor update (discovery projection; failure is non-fatal)
			try {
				await updateActiveDescriptorName(this.activeDescriptorPath, this.activeDescriptor.instanceId, normalizedName);
			} catch {
				// Descriptor update failed but memory and JSONL are consistent
			}

			return normalizedName;
		});
	}

	setMaxMessages(maxMessages: number): Promise<void> {
		return this.enqueue(async () => {
			// Validate BEFORE any persistence or state mutation: an invalid
			// value must never reach the JSONL or advance persistedCount (BC-18).
			assertValidMaxMessages(maxMessages);

			// Empty group chat: update memory only
			if (!this.persistedCount) {
				setGroupMaxMessages(this.state, maxMessages);
				return;
			}

			this.assertWritable();

			// Active group chat: persist entry via SessionManager
			try {
				this.groupSessionManager.appendCustomEntry("pi-tavern.group-settings", {
					group_max_messages: maxMessages,
				});
			} catch (error) {
				this.recoverSessionManagerFromFailedAppend(error);
			}
			this.persistedCount++;

			setGroupMaxMessages(this.state, maxMessages);
		});
	}

	submitUserPersonaMessage(content: string): Promise<string> {
		return this.enqueue(async () => {
			this.assertWritable();

			const contentBytes = Buffer.byteLength(content, "utf8");
			if (contentBytes > 64 * 1024) {
				throw new Error("User Persona message exceeds 64 KiB");
			}

			// Compute candidate state values (committed only after successful persist)
			const roundMaxMessages = this.state.groupChat.groupMaxMessages;
			const sequence = this.state.nextSequence + 1;
			const timestamp = new Date().toISOString();
			let entryId: string;

			// For the very first persist, seed the file with SessionManager's header,
			// then use its append API for all entries so IDs, parentId chain, and envelopes
			// are fully managed by SessionManager (persistence.md L6-8).
			// Bit flags track each step for granular rollback on partial failure.
			if (this.persistedCount === 0) {
				const sessionPath = this.getSessionFilePath();
				// Use canonical createdAt so header timestamp matches state and descriptor
				const header = { ...this.groupSessionManager.getHeader(), timestamp: this.state.groupChat.createdAt };

				this.firstPersistFlags = 0;
				try {
					// Set bit before operation so rollback knows this step was attempted
					// (writeFile may create/partially-write the file before throwing).
					this.firstPersistFlags |= FIRST_PERSIST_HEADER_WRITTEN;
					await this.deps.writeFile(sessionPath, `${JSON.stringify(header)}\n`);

					this.firstPersistFlags |= FIRST_PERSIST_SESSION_OPENED;
					this.groupSessionManager.setSessionFile(sessionPath);

					if (this.state.groupChat.name) {
						this.groupSessionManager.appendSessionInfo(this.state.groupChat.name);
						this.firstPersistFlags |= FIRST_PERSIST_NAME_APPENDED;
						this.persistedCount++;
					}

					this.groupSessionManager.appendCustomEntry("pi-tavern.group-settings", {
						group_max_messages: roundMaxMessages,
					});
					this.firstPersistFlags |= FIRST_PERSIST_SETTINGS_APPENDED;
					this.persistedCount++;

					entryId = this.groupSessionManager.appendCustomMessageEntry(
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
					this.firstPersistFlags |= FIRST_PERSIST_MESSAGE_APPENDED;
					this.persistedCount++;
				} catch (error) {
					try {
						await this.rollbackFirstPersist(sessionPath);
					} catch (rollbackError) {
						throw new Error(
							`Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
							{ cause: error },
						);
					}
					throw error;
				}
			} else {
				try {
					entryId = this.groupSessionManager.appendCustomMessageEntry(
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
					// SessionManager._appendEntry mutates memory before disk write.
					// On failure, purge the unpersisted entry from memory.
					this.recoverSessionManagerFromFailedAppend(error);
				}
			}

			// Read the real entry timestamp from SessionManager for consistency
			// between disk envelope and broadcast/display timestamps (finding 3).
			const persisted = this.groupSessionManager.getEntry(entryId);
			const entryTimestamp = persisted?.timestamp ?? timestamp;

			// Commit state only after successful persist
			this.state.round = { roundMaxMessages, usedMessages: 0 };
			this.state.nextSequence = sequence;
			// Clear hand-raised flags from previous round (only on success)
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

			// Broadcast and TUI projection are independent — neither blocks the other
			try {
				this.broadcastGroupChatUpdate();
			} catch {
				// Broadcast failure silently swallowed — no impact on state or TUI
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
	 * Permanently end the runtime. Idempotent: concurrent calls share the same
	 * result. The runtime queue is drained first (bounded by the coordination
	 * timeout); when it never drains, local cleanup still force-completes.
	 */
	close(reason: RuntimeCloseReason = "user_leave"): Promise<RuntimeCloseResult> {
		this.closePromise ??= this.performClose(reason);
		return this.closePromise;
	}

	private async performClose(_reason: RuntimeCloseReason): Promise<RuntimeCloseResult> {
		if (this.lifecycle === "detaching") {
			// close() and detachForReload() are mutually exclusive paths.
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

	/** Wait for the runtime queue to drain, up to timeoutMs; returns true when timed out. */
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
				// Half-open connection: terminating emits close → unified disconnected cleanup.
				socket.terminate();
				continue;
			}
			socket.ping();
		}
	}

	/** Install the server's connection handler (also used after reload takeover). */
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

		// Send history before join broadcast so hasPublicMessages is true
		// when the new Character processes its own character_joined event.
		const recentMessages = this.publicMessages.slice(-10);
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

		// Broadcast character_joined after message_history so the new Character
		// already has hasPublicMessages=true when processing its own join event.
		this.broadcast({
			type: "character_joined",
			character: toCharacterSummaryMessage(character),
		});
		this.onMembersChanged?.();
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

		// Cursor is an absolute sequence boundary: return the 10 most recent
		// messages with sequence < cursorSeq. New messages never shift it.
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

		// Incremental pull (M7/ISSUE-012): return every message after the
		// client's cursor. Sequence filtering naturally fills gaps — a missed
		// notification is healed by the next pull.
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
			path = this.getSessionFilePath();
		} catch {
			this.sendFailure(socket, message.id, "get_chat_history_file", "Group chat has no chat history file yet");
			return;
		}
		// The file only exists after the first persist; SessionManager may
		// already know the path before the file is written.
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

		const canPublish = round.usedMessages < round.roundMaxMessages;

		// If persistence is broken, reject even non-publishing speaks
		// (state can't be mutated safely).
		try {
			this.assertWritable();
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
				// Use SessionManager's append API for post-init writes
				entryId = this.groupSessionManager.appendCustomMessageEntry(
					"pi-tavern.public-message",
					formatEntryContent(senderName, message.content),
					true,
					details,
				);
			} catch (error) {
				// SessionManager._appendEntry mutates memory before disk write.
				// Purge the unpersisted entry from byId/leafId.
				const reportError = this.recoverSessionManagerAndCatch(error);
				this.sendFailure(socket, message.id, "speak", `Failed to persist message: ${reportError.message}`);
				return;
			}

			this.persistedCount++;

			// Read the real entry timestamp from SessionManager for consistency
			const persisted = this.groupSessionManager.getEntry(entryId);
			const entryTimestamp = persisted?.timestamp ?? timestamp;

			// Commit state only after successful persist
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

			// Broadcast and TUI projection are independent — neither blocks the other
			try {
				this.broadcastGroupChatUpdate();
			} catch {
				// Broadcast failure silently swallowed
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
			// Fall through: the socket is unusable.
		}
		// During close/detach the runtime performs its own cleanup; a send
		// failure must not race the termination flow.
		if (this.lifecycle === "active") {
			this.handleSendFailure(socket);
		}
	}

	/**
	 * Route a failed send into the unified disconnected cleanup. The socket is
	 * removed from the connection table first so the character_left broadcast
	 * cannot hit the same dead socket recursively.
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
	 * M7 (ISSUE-012/#24): broadcast a group_chat_update notification instead
	 * of the full public_message event. Characters wake on the notification
	 * and pull the actual increment via fetch_messages_since. The preview
	 * carries the most recent messages (WeChat-style); content is the same
	 * source (publicMessages) as the pull path, so UI and agent context
	 * never diverge.
	 */
	private broadcastGroupChatUpdate(): void {
		const latest = this.publicMessages[this.publicMessages.length - 1];
		if (!latest) {
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

	/**
	 * Recover SessionManager in-memory state after a failed append.
	 * SessionManager._appendEntry mutates byId/leafId before disk write;
	 * on failure the disk file is still valid (the write never happened)
	 * so setSessionFile can reload clean state. If even that fails, the
	 * Runtime is marked persistence-fatal — all future mutating operations
	 * will reject rather than continue with corrupt/empty in-memory state.
	 */
	private recoverSessionManagerFromFailedAppend(originalError: unknown): never {
		try {
			this.groupSessionManager.setSessionFile(this.getSessionFilePath());
			// Recovery succeeded — re-throw the original error so the caller
			// can report it; the SessionManager is clean for the next operation.
			throw originalError;
		} catch (recoveryError) {
			if (recoveryError === originalError) throw originalError;
			// setSessionFile itself failed — unrecoverable.
			this.persistenceFatal = true;
			throw new Error(
				`Persistence recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}. ` +
					`Original error: ${originalError instanceof Error ? originalError.message : String(originalError)}`,
				{ cause: originalError },
			);
		}
	}

	/**
	 * Recover and return the error to report. For callers that must continue
	 * after recovery (e.g., handleSpeak which sends a response).
	 */
	private recoverSessionManagerAndCatch(originalError: unknown): Error {
		try {
			this.groupSessionManager.setSessionFile(this.getSessionFilePath());
		} catch (recoveryError) {
			this.persistenceFatal = true;
			return new Error(
				`Persistence recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}. ` +
					`Original error: ${originalError instanceof Error ? originalError.message : String(originalError)}`,
				{ cause: originalError },
			);
		}
		return originalError instanceof Error ? originalError : new Error(String(originalError));
	}

	private assertWritable(): void {
		if (this.persistenceFatal) {
			throw new Error("Group chat persistence is broken — further writes are blocked");
		}
	}

	/**
	 * Roll back a partially-completed first persist using bit flags to decide
	 * what cleanup is needed. Each bit represents a completed step.
	 */
	private async rollbackFirstPersist(sessionPath: string): Promise<void> {
		const flags = this.firstPersistFlags;
		this.firstPersistFlags = 0;
		this.persistedCount = 0;

		if (flags & FIRST_PERSIST_HEADER_WRITTEN) {
			// Delete the half-initialized file. If deletion fails,
			// the Runtime cannot safely continue — it would start
			// a new session while a broken file remains on disk.
			try {
				await this.deps.rm(sessionPath);
			} catch {
				this.persistenceFatal = true;
				throw new Error(
					"Failed to delete half-initialized session file during rollback. " +
						"Persistence is now blocked to prevent duplicate sessions.",
				);
			}
		}

		if (flags & FIRST_PERSIST_SESSION_OPENED) {
			// SessionManager in-memory state was mutated by the failed appends.
			// Recreate a fresh instance — the file was already deleted above.
			// The next first-persist will write the header with canonical createdAt.
			this.groupSessionManager = SessionManager.create(
				this.groupSessionManager.getCwd(),
				this.groupSessionManager.getSessionDir(),
				{ id: this.state.groupChat.groupChatId },
			);
		}
	}

	private getSessionFilePath(): string {
		const path = this.groupSessionManager.getSessionFile();
		if (!path) throw new Error("Session file not set");
		return path;
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
	/** Event handler references so detachForReload can swap in buffering handlers. */
	handlers: {
		message: (data: WebSocket.RawData, isBinary: boolean) => void;
		pong: () => void;
		close: () => void;
		error: () => void;
	} | null;
}

/** Per-member heartbeat bookkeeping (times are epoch milliseconds). */
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

function formatEntryContent(senderLabel: string, body: string): string {
	const trimmed = body.replace(/\n+$/, "");
	return `${senderLabel}:\n${trimmed}\n`;
}
