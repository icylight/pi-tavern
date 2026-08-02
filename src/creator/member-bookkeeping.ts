import type WebSocket from "ws";

import type { CharacterCard, CharacterSummary } from "../config/character-card.js";
import type { GroupChatState } from "../data/group-chat-state.js";
import type { BroadcastHub } from "./broadcast-hub.js";
import type { ConnectionContext } from "./connection-manager.js";
import type { HeartbeatRegistry } from "./heartbeat-registry.js";

export interface MemberBookkeepingOptions {
	state: GroupChatState;
	connections: Map<string, WebSocket>;
	characters: ReadonlyMap<string, CharacterCard>;
	heartbeatRegistry: HeartbeatRegistry;
	broadcastHub: BroadcastHub;
	enqueue: <T>(operation: () => T | Promise<T>) => Promise<T>;
	readyTimeoutMs: number;
	/** 回调经 getter 读取（测试后期赋值仍生效——Arch ②「闭包捕获最终引用」同模式）。 */
	readOnMembersChanged: () => (() => void) | undefined;
	toCharacterSummaryMessage: (character: CharacterSummary) => {
		character_id: string;
		name: string;
		description: string | null;
	};
}

/**
 * 成员簿记：ready 计时、角色预留、在线成员移除与角色可用性（PR-B 拆自
 * CreatorRuntime）。状态/连接实体由骨架持有，经窄接口注入；不 import CreatorRuntime。
 */
export class MemberBookkeeping {
	private readonly options: MemberBookkeepingOptions;

	constructor(options: MemberBookkeepingOptions) {
		this.options = options;
	}

	startReadyTimer(socket: WebSocket, connection: ConnectionContext): void {
		this.clearReadyTimer(connection);
		connection.readyTimer = setTimeout(() => {
			void this.options.enqueue(() => {
				if (!connection.online && connection.reservedCharacterId !== null) {
					this.releaseReservation(connection);
					socket.close(1008, "Character ready timeout");
				}
			});
		}, this.options.readyTimeoutMs);
	}

	clearReadyTimer(connection: ConnectionContext): void {
		if (connection.readyTimer) {
			clearTimeout(connection.readyTimer);
			connection.readyTimer = null;
		}
	}

	releaseReservation(connection: ConnectionContext): void {
		const characterId = connection.reservedCharacterId;
		if (characterId !== null && this.options.state.characterReservations.get(characterId) === connection.sessionId) {
			this.options.state.characterReservations.delete(characterId);
		}
		connection.reservedCharacterId = null;
		this.clearReadyTimer(connection);
	}

	removeOnlineCharacter(connection: ConnectionContext, reason: "left" | "disconnected"): void {
		if (!connection.online || connection.sessionId === null) {
			return;
		}
		const onlineCharacter = this.options.state.onlineCharacters.get(connection.sessionId);
		connection.online = false;
		this.options.connections.delete(connection.sessionId);
		this.options.heartbeatRegistry.remove(connection.sessionId);
		this.options.state.onlineCharacters.delete(connection.sessionId);
		if (onlineCharacter) {
			this.options.broadcastHub.broadcast({
				type: "character_left",
				character: this.options.toCharacterSummaryMessage(onlineCharacter.character),
				reason,
			});
		}
		this.options.readOnMembersChanged()?.();
		// ISSUE-014/#14（方案 A）：离开也刷新其他成员的 widget。
		this.options.broadcastHub.broadcastGroupChatUpdate();
	}

	getAvailableCharacters(): CharacterCard[] {
		return [...this.options.characters.values()].filter((character) =>
			this.isCharacterAvailable(character.characterId),
		);
	}

	isCharacterAvailable(characterId: string): boolean {
		if (this.options.state.characterReservations.has(characterId)) {
			return false;
		}
		return ![...this.options.state.onlineCharacters.values()].some(
			(online) => online.character.characterId === characterId,
		);
	}
}
