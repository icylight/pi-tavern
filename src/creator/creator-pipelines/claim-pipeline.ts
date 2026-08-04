import type WebSocket from "ws";
import type { CharacterCard, CharacterSummary } from "../../config/character-card.js";
import type { GroupChatState } from "../../data/group-chat-state.js";
import type { ClientMessage } from "../../protocol/messages.js";
import { ERROR_CHARACTER_UNAVAILABLE } from "../../shared/messages.js";

type ClaimCharacterMessage = Extract<ClientMessage, { type: "claim_character" }>;

/** 连接上下文窄接口（creator-runtime 的 ConnectionContext 结构子集）。 */
export interface ClaimConnectionLike {
	sessionId: string | null;
	online: boolean;
	reservedCharacterId: string | null;
}

export interface ClaimPipelineDependencies {
	state: GroupChatState;
	characters: ReadonlyMap<string, CharacterCard>;
	isCharacterAvailable: (characterId: string) => boolean;
	/** 预留超时定时器（runtime 方法注入：超时释放 + close，跨消息编排归 runtime）。 */
	startReadyTimer: (socket: WebSocket, connection: ClaimConnectionLike) => void;
	toCharacterSummaryMessage: (character: CharacterSummary) => {
		character_id: string;
		name: string;
		description: string;
	};
	send: (socket: WebSocket, message: unknown) => void;
	sendFailure: (socket: WebSocket, id: string | undefined, command: "claim_character", reason: string) => void;
}

/**
 * claim_character 门面（短流程：粒度约束不建管线）。阶段：
 * validate（会话归属/在线/重复预留/角色存在可用）→ commit 预留 → 定时器 + 响应。
 * 只显式读写 runtime 会话状态（决策 7），不缓存跨消息状态。
 */
export class ClaimPipeline {
	constructor(private readonly deps: ClaimPipelineDependencies) {}

	run(socket: WebSocket, connection: ClaimConnectionLike, message: ClaimCharacterMessage): void {
		const character = this.deps.characters.get(message.character_id);
		if (
			connection.sessionId === null ||
			connection.online ||
			connection.reservedCharacterId !== null ||
			!character ||
			!this.deps.isCharacterAvailable(message.character_id)
		) {
			this.deps.sendFailure(socket, message.id, "claim_character", ERROR_CHARACTER_UNAVAILABLE);
			return;
		}

		this.deps.state.characterReservations.set(character.characterId, connection.sessionId);
		connection.reservedCharacterId = character.characterId;
		this.deps.startReadyTimer(socket, connection);
		this.deps.send(socket, {
			...(message.id !== undefined ? { id: message.id } : {}),
			type: "response",
			command: "claim_character",
			success: true,
			data: {
				character: {
					...this.deps.toCharacterSummaryMessage(character),
					path: character.path,
				},
			},
		});
	}
}
