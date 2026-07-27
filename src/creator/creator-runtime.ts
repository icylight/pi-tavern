import { randomUUID } from "node:crypto";
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
import {
	createGroupChatState,
	type GroupChatState,
	normalizeGroupChatName,
	setGroupChatName,
	setGroupMaxMessages,
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
}

const DEFAULT_CONFIG_MAX_MESSAGES = 10;
const DEFAULT_READY_TIMEOUT_MS = 5_000;

export class CreatorRuntime {
	readonly connections = new Map<string, WebSocket>();
	readonly characters: Map<string, CharacterCard>;

	private closePromise: Promise<void> | null = null;
	private runtimeTail = Promise.resolve();
	private disposed = false;

	private constructor(
		readonly webSocketServer: WebSocketServer,
		readonly groupSessionManager: SessionManager,
		readonly state: GroupChatState,
		readonly activeDescriptor: ActiveGroupChatDescriptor,
		readonly activeDescriptorPath: string,
		readonly configMaxMessages: number,
		characters: CharacterCard[],
		private readonly readyTimeoutMs: number,
	) {
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
			readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
			publishDescriptor: publishActiveDescriptor,
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
		const normalizedName = normalizeGroupChatName(name);
		await updateActiveDescriptorName(this.activeDescriptorPath, this.activeDescriptor.instanceId, normalizedName);
		setGroupChatName(this.state, name);
		this.activeDescriptor.name = normalizedName;
		return normalizedName;
	}

	setMaxMessages(maxMessages: number): void {
		setGroupMaxMessages(this.state, maxMessages);
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
			void this.enqueue(() => {
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
				this.handleClientMessage(socket, connection, message);
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

	private handleClientMessage(socket: WebSocket, connection: ConnectionContext, message: ClientMessage): void {
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
		this.broadcast({
			type: "character_joined",
			character: toCharacterSummaryMessage(character),
		});
		this.send(socket, {
			type: "message_history",
			messages: [],
			cursor: null,
			has_more: false,
			total_messages: 0,
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
		command: "join_group_chat" | "claim_character" | "character_ready" | "leave_group_chat" | "get_group_chat_state",
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
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(encodeMessage(message));
		}
	}

	private broadcast(message: unknown): void {
		for (const socket of this.connections.values()) {
			this.send(socket, message);
		}
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
