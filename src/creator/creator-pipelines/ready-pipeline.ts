import { ResponseError } from "vscode-jsonrpc";
import type WebSocket from "ws";
import type { CharacterCard, CharacterSummary } from "../../config/character-card.js";
import type { GroupChatState } from "../../data/group-chat-state.js";
import { type ClientMessage, JSONRPC_VERSION } from "../../protocol/messages.js";
import { DEFAULT_WELCOME_MESSAGE } from "../../shared/constants.js";
import {
	ERROR_ALREADY_IN_GROUP_CHAT,
	ERROR_CODE_ALREADY_IN_GROUP,
	ERROR_CODE_RESERVATION_INVALID,
	ERROR_RESERVATION_INVALID,
	METHOD_CHARACTER_JOINED,
	METHOD_SYSTEM_MESSAGE,
} from "../../shared/messages.js";
import type { HeartbeatRegistry } from "../heartbeat-registry.js";

type CharacterReadyMessage = Extract<ClientMessage, { method: "character_ready" }>;

/** 连接上下文窄接口（creator-runtime 的 ConnectionContext 结构子集）。 */
export interface ReadyConnectionLike {
	sessionId: string | null;
	online: boolean;
	reservedCharacterId: string | null;
}

/** 心跳簿记的本地窄接口（runtime HeartbeatState 结构子集）。 */
export interface ReadyPipelineDependencies {
	state: GroupChatState;
	connections: Map<string, WebSocket>;
	heartbeatRegistry: HeartbeatRegistry;
	characters: ReadonlyMap<string, CharacterCard>;
	/** #123：欢迎文案（配置链合并结果，缺省 = DEFAULT_WELCOME_MESSAGE）。 */
	welcomeMessage: string;
	/** 预留定时器清理（runtime 方法注入，与超时释放同一归属）。 */
	clearReadyTimer: (connection: ReadyConnectionLike) => void;
	now: () => Date;
	toCharacterSummary: (character: CharacterCard) => CharacterSummary;
	toCharacterSummaryMessage: (character: CharacterSummary) => {
		character_id: string;
		name: string;
		description: string;
	};
	send: (socket: WebSocket, message: unknown) => void;
	broadcast: (message: unknown) => void;
	onMembersChanged: (() => void) | undefined;
}

/**
 * character_ready 门面（短流程：阶段多为发送顺序而非 IO 管线）。阶段：
 * validate（预留有效性）→ commit 在线态 → 响应 + 欢迎消息 → 广播序列。
 * #123：ready 后不再自动推送 message_history，改为单播 system_message 欢迎文案
 * （历史改由 get_message_history / fetch_messages_since 主动拉取，WL1-WL3）。
 */
export class ReadyPipeline {
	constructor(private readonly deps: ReadyPipelineDependencies) {}

	run(socket: WebSocket, connection: ReadyConnectionLike, _message: CharacterReadyMessage): null {
		const { sessionId, reservedCharacterId } = connection;
		const character = reservedCharacterId ? this.deps.characters.get(reservedCharacterId) : undefined;
		if (
			sessionId === null ||
			reservedCharacterId === null ||
			!character ||
			connection.online ||
			this.deps.state.characterReservations.get(reservedCharacterId) !== sessionId
		) {
			throw new ResponseError(ERROR_CODE_RESERVATION_INVALID, ERROR_RESERVATION_INVALID);
		}
		if (this.deps.connections.has(sessionId)) {
			throw new ResponseError(ERROR_CODE_ALREADY_IN_GROUP, ERROR_ALREADY_IN_GROUP_CHAT);
		}

		this.deps.clearReadyTimer(connection);
		this.deps.state.characterReservations.delete(reservedCharacterId);
		connection.reservedCharacterId = null;
		this.deps.connections.set(sessionId, socket);
		this.deps.heartbeatRegistry.register(sessionId);
		this.deps.state.onlineCharacters.set(sessionId, {
			sessionId,
			character: this.deps.toCharacterSummary(character),
			isStreaming: false,
			handRaised: false,
		});
		connection.online = true;

		// 时序语义（重构前 = 同步 send 顺序）：ready 响应（result: null）先到，
		// 随后 system_message 欢迎单播 + character_joined 广播。connection 模式下
		// 响应由库在 handler resolve 后（微任务）reply——通知帧延迟到宏任务，
		// 事件循环保证响应先发。
		// #123：system_message 单播（Arch 评审 §1.5——欢迎语个人化，非 broadcast）；
		// 在 character_joined 之前发送，使新角色处理自己的 join 事件时欢迎语已就位。
		setImmediate(() => {
			this.deps.send(socket, {
				jsonrpc: JSONRPC_VERSION,
				method: METHOD_SYSTEM_MESSAGE,
				params: {
					content: this.deps.welcomeMessage ?? DEFAULT_WELCOME_MESSAGE,
				},
			});
			this.deps.broadcast({
				jsonrpc: JSONRPC_VERSION,
				method: METHOD_CHARACTER_JOINED,
				params: {
					character: this.deps.toCharacterSummaryMessage(character),
				},
			});
			this.deps.onMembersChanged?.();
		});
		return null;
	}
}
