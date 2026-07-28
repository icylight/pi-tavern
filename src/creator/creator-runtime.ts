import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import WebSocket, { WebSocketServer } from "ws";

import type { CharacterCard, CharacterSummary } from "../config/character-card.js";
import {
	type ActiveGroupChatDescriptor,
	getActiveDescriptorPath,
	getGroupChatSessionDirectory,
	publishActiveDescriptor,
	removeOwnedActiveDescriptor,
	updateActiveDescriptorName,
} from "../discovery/active-descriptor.js";
import { decodeClientMessage, encodeMessage, MAX_WEBSOCKET_FRAME_BYTES } from "../protocol/codec.js";
import type { ClientMessage } from "../protocol/messages.js";
import { SHORT_COORDINATION_TIMEOUT_MS } from "../shared/constants.js";
import {
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

export interface CreatorRuntimeDependencies {
	createId: () => string;
	now: () => Date;
	pid: number;
	readyTimeoutMs: number;
	publishDescriptor: (agentDir: string, descriptor: ActiveGroupChatDescriptor) => Promise<string>;
	writeFile: (path: string, data: string) => Promise<void>;
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

	private closePromise: Promise<void> | null = null;
	private runtimeTail = Promise.resolve();
	private disposed = false;
	private readonly deps: CreatorRuntimeDependencies;
	private persistedCount = 0;

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

	private publicMessages: Array<{
		sender: { type: "user_persona" } | { type: "character"; character_id: string; name: string };
		content: string;
		event_id: string;
		sequence: number;
		timestamp: string;
		round: { round_max_messages: number; used_messages: number; remaining_messages: number };
	}> = [];

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
	) {
		this.deps = deps;
		this.characters = new Map(characters.map((character) => [character.characterId, character]));
		this.webSocketServer.on("connection", (socket) => this.handleConnection(socket));
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
			return runtime;
		} catch (error) {
			await removeOwnedActiveDescriptor(activeDescriptorPath, instanceId);
			await closeWebSocketServer(webSocketServer);
			throw error;
		}
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

			// Active group chat: persist entry via SessionManager
			this.groupSessionManager.appendSessionInfo(normalizedName ?? "");
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
			// Empty group chat: update memory only
			if (!this.persistedCount) {
				setGroupMaxMessages(this.state, maxMessages);
				return;
			}

			// Active group chat: persist entry via SessionManager
			this.groupSessionManager.appendCustomEntry("pi-tavern.group-settings", {
				group_max_messages: maxMessages,
			});
			this.persistedCount++;

			setGroupMaxMessages(this.state, maxMessages);
		});
	}

	submitUserPersonaMessage(content: string): Promise<string> {
		return this.enqueue(async () => {
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
				const header = this.groupSessionManager.getHeader();

				this.firstPersistFlags = 0;
				try {
					await this.deps.writeFile(sessionPath, `${JSON.stringify(header)}\n`);
					this.firstPersistFlags |= FIRST_PERSIST_HEADER_WRITTEN;

					this.groupSessionManager.setSessionFile(sessionPath);
					this.firstPersistFlags |= FIRST_PERSIST_SESSION_OPENED;

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
							timestamp,
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
					await this.rollbackFirstPersist(sessionPath);
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
							timestamp,
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
					// On failure, reload from disk to purge the unpersisted entry.
					this.groupSessionManager.setSessionFile(this.getSessionFilePath());
					throw error;
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
				this.broadcast({
					type: "public_message",
					event_id: entryId,
					sequence,
					timestamp: entryTimestamp,
					sender: { type: "user_persona" },
					content,
					round: message.round,
				});
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

	close(): Promise<void> {
		this.closePromise ??= this.closePermanently();
		return this.closePromise;
	}

	private async closePermanently(): Promise<void> {
		this.disposed = true;
		this.broadcast({
			type: "group_chat_closed",
			group_chat_id: this.state.groupChat.groupChatId,
		});
		for (const socket of this.webSocketServer.clients) {
			socket.close(1001, "Group chat closed");
		}
		await closeWebSocketServer(this.webSocketServer);
		this.connections.clear();
		this.state.onlineCharacters.clear();
		this.state.characterReservations.clear();
		await removeOwnedActiveDescriptor(this.activeDescriptorPath, this.activeDescriptor.instanceId);
	}

	private handleConnection(socket: WebSocket): void {
		const connection: ConnectionContext = {
			sessionId: null,
			reservedCharacterId: null,
			online: false,
			readyTimer: null,
		};

		socket.on("message", (data, isBinary) => {
			if (isBinary) {
				socket.close(1002, "Binary frames are not supported");
				return;
			}
			void this.enqueue(async () => {
				if (this.disposed) {
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
					if (!this.disposed) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						socket.close(1011, errorMessage);
					}
				}
			});
		});
		socket.on("close", () => {
			void this.enqueue(() => {
				this.releaseReservation(connection);
				this.removeOnlineCharacter(connection, "disconnected");
			});
		});
		socket.on("error", () => undefined);
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
			cursor: this.publicMessages.length > 10 ? "more" : null,
			has_more: this.publicMessages.length > 10,
			total_messages: this.publicMessages.length,
		});

		// Broadcast character_joined after message_history so the new Character
		// already has hasPublicMessages=true when processing its own join event.
		this.broadcast({
			type: "character_joined",
			character: toCharacterSummaryMessage(character),
		});
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

	private handleUpdateCharacterState(connection: ConnectionContext, isStreaming: boolean): void {
		if (!connection.online || connection.sessionId === null) {
			return;
		}
		const onlineCharacter = this.state.onlineCharacters.get(connection.sessionId);
		if (onlineCharacter) {
			onlineCharacter.isStreaming = isStreaming;
		}
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
				timestamp,
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
				// Reload from disk to purge the unpersisted entry from byId/leafId.
				this.groupSessionManager.setSessionFile(this.getSessionFilePath());
				this.sendFailure(
					socket,
					message.id,
					"speak",
					`Failed to persist message: ${error instanceof Error ? error.message : String(error)}`,
				);
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
				this.broadcast({
					type: "public_message",
					event_id: entryId,
					sequence,
					timestamp: entryTimestamp,
					sender: msg.sender,
					content: message.content,
					round: msg.round,
				});
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
		this.state.onlineCharacters.delete(connection.sessionId);
		if (onlineCharacter) {
			this.broadcast({
				type: "character_left",
				character: toCharacterSummaryMessage(onlineCharacter.character),
				reason,
			});
		}
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
			}
		} catch {
			// Per-socket failure must not affect other sockets or the caller
		}
	}

	private broadcast(message: unknown): void {
		for (const socket of this.connections.values()) {
			this.send(socket, message);
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
			try {
				await rm(sessionPath, { force: true });
			} catch {
				// Best-effort cleanup
			}
		}

		if (flags & FIRST_PERSIST_SESSION_OPENED) {
			// SessionManager in-memory state was mutated by the failed appends.
			// Recreate it to purge unpersisted entries from byId/leafId.
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
