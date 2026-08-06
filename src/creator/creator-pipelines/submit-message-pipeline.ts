import { ResponseError } from "vscode-jsonrpc";
import type WebSocket from "ws";
import { type GroupChatState, setHandRaised } from "../../data/group-chat-state.js";
import { formatEntryContent, type SessionHeaderLike, type SessionStore } from "../../data/session-store.js";
import type { ClientMessage } from "../../protocol/messages.js";
import type { PublicMessageState } from "../../protocol/public-message-state.js";
import {
	ERROR_CODE_MESSAGE_TOO_LARGE,
	ERROR_CODE_NO_ACTIVE_ROUND,
	ERROR_CODE_NOT_IN_GROUP,
	ERROR_CODE_PERSIST_FAILED,
	ERROR_MESSAGE_TOO_LARGE,
	ERROR_NO_ACTIVE_ROUND,
	ERROR_NOT_GROUP_MEMBER,
	ERROR_PERSIST_FAILED_PREFIX,
	ERROR_TUI_PROJECTION_FAILED_PREFIX,
	ERROR_UNKNOWN,
	ERROR_USER_PERSONA_MESSAGE_TOO_LARGE,
} from "../../shared/messages.js";

type SpeakMessage = Extract<ClientMessage, { method: "speak" }>;

/** 连接上下文窄接口（creator-runtime 的 ConnectionContext 结构子集）。 */
export interface SpeakConnectionLike {
	sessionId: string | null;
	online: boolean;
}

/** 持久化条目计数访问面：跨消息会话状态归 runtime，管线经读写函数显式访问（决策 7）。 */
export interface PersistedCountAccess {
	get(): number;
	add(delta: number): void;
}

export interface SubmitMessagePipelineDependencies {
	state: GroupChatState;
	publicMessages: PublicMessageState[];
	persistedCount: PersistedCountAccess;
	sessionStore: SessionStore;
	broadcastGroupChatUpdate: () => void;
	onPublicMessage?: (msg: PublicMessageState) => void;
	onPublicMessageError?: (error: string, sequence: number, timestamp: string) => void;
}

/** speak 响应 result（stale / round_limit_reached / published 三态）。 */
export type SpeakResult =
	| {
			published: false;
			reason: "stale";
			missing_sequences: { from: number; to: number };
			round: { round_max_messages: number; used_messages: number; remaining_messages: number };
	  }
	| {
			published: false;
			reason: "round_limit_reached";
			hand_raised: true;
			round: { round_max_messages: number; used_messages: number; remaining_messages: number };
	  }
	| {
			published: true;
			event_id: string;
			sequence: number;
			latest_sequence: number;
			round: { round_max_messages: number; used_messages: number; remaining_messages: number };
	  };

/**
 * submit-message 管线（唯一满足粒度判据的请求级管线：≥3 顺序阶段 + 共享
 * 中间态 + 双入口复用 + 显式读写顺序）。speak 与 submitUserPersonaMessage
 * 共用「校验 → 持久化 → 提交 → 广播/投影」骨架；speak 额外含陈旧性检查与
 * 配额阶段。中间 IO 收于实例字段；跨消息状态（round/nextSequence/在线表/
 * publicMessages/persistedCount）经注入引用显式读写，不缓存（决策 7）。
 */
export class SubmitMessagePipeline {
	/** 请求级中间态（阶段间共享，单次请求存活；每次请求 new 实例）。 */
	private sequence = 0;
	private timestamp = "";
	private entryId = "";
	private senderName = "";
	private roundMaxMessages = 0;

	constructor(private readonly deps: SubmitMessagePipelineDependencies) {}

	/** speak 入口：六阶段编排（校验 → 陈旧性 → 配额+可写 → 持久化 → 提交 → 广播/响应）。 */
	async runSpeak(socket: WebSocket, connection: SpeakConnectionLike, message: SpeakMessage): Promise<SpeakResult> {
		// 阶段 1：校验（成员资格 / 大小 / 在线角色 / 活跃轮次）
		void socket;
		if (!connection.online || connection.sessionId === null) {
			throw new ResponseError(ERROR_CODE_NOT_IN_GROUP, ERROR_NOT_GROUP_MEMBER);
		}

		const contentBytes = Buffer.byteLength(message.params.content, "utf8");
		if (contentBytes > 64 * 1024) {
			throw new ResponseError(ERROR_CODE_MESSAGE_TOO_LARGE, ERROR_MESSAGE_TOO_LARGE);
		}

		const onlineCharacter = this.deps.state.onlineCharacters.get(connection.sessionId);
		if (!onlineCharacter) {
			throw new ResponseError(ERROR_CODE_NOT_IN_GROUP, ERROR_NOT_GROUP_MEMBER);
		}

		const round = this.deps.state.round;
		if (!round) {
			throw new ResponseError(ERROR_CODE_NO_ACTIVE_ROUND, ERROR_NO_ACTIVE_ROUND);
		}

		// 阶段 2：陈旧性检查（ISSUE-013 B2/B6）——业务性拒绝：不发布、不耗配额、不举手
		let latestOtherSequence = 0;
		for (let i = this.deps.publicMessages.length - 1; i >= 0; i--) {
			const candidate = this.deps.publicMessages[i];
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
		const latestPublic = this.deps.publicMessages[this.deps.publicMessages.length - 1];
		const latestSequence = latestPublic !== undefined ? latestPublic.sequence : 0;
		if (message.params.based_on_sequence !== undefined && message.params.based_on_sequence < latestOtherSequence) {
			return {
				published: false,
				reason: "stale",
				missing_sequences: {
					from: message.params.based_on_sequence + 1,
					to: latestSequence,
				},
				round: {
					round_max_messages: round.roundMaxMessages,
					used_messages: round.usedMessages,
					remaining_messages: Math.max(0, round.roundMaxMessages - round.usedMessages),
				},
			};
		}

		// 阶段 3：配额 + 可写性（持久化损坏时连非发布型 speak 也拒绝）
		const canPublish = round.usedMessages < round.roundMaxMessages;
		try {
			this.deps.sessionStore.assertWritable();
		} catch (error) {
			throw new ResponseError(ERROR_CODE_PERSIST_FAILED, error instanceof Error ? error.message : String(error));
		}
		if (!canPublish) {
			setHandRaised(this.deps.state, connection.sessionId, true);
			return {
				published: false,
				reason: "round_limit_reached",
				hand_raised: true,
				round: {
					round_max_messages: round.roundMaxMessages,
					used_messages: round.usedMessages,
					remaining_messages: 0,
				},
			};
		}

		// 阶段 4：持久化（候选值仅在落盘成功后提交）
		const newUsed = round.usedMessages + 1;
		this.roundMaxMessages = round.roundMaxMessages;
		this.sequence = this.deps.state.nextSequence + 1;
		this.timestamp = new Date().toISOString();
		this.senderName = onlineCharacter.character.name;

		const details = {
			sender: {
				type: "character" as const,
				character_id: onlineCharacter.character.characterId,
				name: this.senderName,
			},
			content: message.params.content,
			sequence: this.sequence,
			round: {
				round_max_messages: this.roundMaxMessages,
				used_messages: newUsed,
				remaining_messages: Math.max(0, this.roundMaxMessages - newUsed),
			},
		};

		try {
			this.entryId = this.deps.sessionStore.appendCustomMessageEntry(
				"pi-tavern.public-message",
				formatEntryContent(this.senderName, message.params.content),
				true,
				details,
			);
		} catch (error) {
			const reportError = this.deps.sessionStore.recoverFromFailedAppendAndCatch(error);
			throw new ResponseError(ERROR_CODE_PERSIST_FAILED, `${ERROR_PERSIST_FAILED_PREFIX}${reportError.message}`);
		}

		this.deps.persistedCount.add(1);

		const persisted = this.deps.sessionStore.getEntry(this.entryId);
		const entryTimestamp = persisted?.timestamp ?? this.timestamp;

		// 阶段 5：提交状态（仅在持久化成功后）
		round.usedMessages = newUsed;
		this.deps.state.nextSequence = this.sequence;
		setHandRaised(this.deps.state, connection.sessionId, false);

		const msg: PublicMessageState = {
			sender: {
				type: "character" as const,
				character_id: onlineCharacter.character.characterId,
				name: this.senderName,
			},
			content: message.params.content,
			event_id: this.entryId,
			sequence: this.sequence,
			timestamp: entryTimestamp,
			round: {
				round_max_messages: this.roundMaxMessages,
				used_messages: newUsed,
				remaining_messages: Math.max(0, this.roundMaxMessages - newUsed),
			},
		};
		this.deps.publicMessages.push(msg);

		// 阶段 6：广播 + TUI 投影（相互独立，互不阻塞）+ 响应
		this.broadcastAndProject(msg);
		return {
			published: true,
			event_id: this.entryId,
			sequence: this.sequence,
			// ISSUE-013 B6：让客户端把 last-seen sequence 越过自己发布的
			// 消息（echo 在客户端侧过滤，因此拉取游标不会自行推进）。
			latest_sequence: this.sequence,
			round: msg.round,
		};
	}

	/** User Persona 入口：校验 → 持久化（first-persist/append）→ 提交 → 广播/投影；返回 entryId。 */
	async runUserPersona(content: string): Promise<string> {
		// 阶段 1：校验（可写性先于大小检查——与迁移前顺序逐字一致）
		this.deps.sessionStore.assertWritable();

		const contentBytes = Buffer.byteLength(content, "utf8");
		if (contentBytes > 64 * 1024) {
			throw new Error(ERROR_USER_PERSONA_MESSAGE_TOO_LARGE);
		}

		// 阶段 2：持久化
		this.roundMaxMessages = this.deps.state.groupChat.groupMaxMessages;
		this.sequence = this.deps.state.nextSequence + 1;
		this.timestamp = new Date().toISOString();

		if (this.deps.persistedCount.get() === 0) {
			const sessionPath = this.deps.sessionStore.getSessionFilePath();
			// 用规范 createdAt，使 header 时间戳与状态、descriptor 一致
			// （运行时仍展开完整 header：type/version/cwd 等由真实实例供给）。
			const header = {
				...this.deps.sessionStore.getHeader(),
				timestamp: this.deps.state.groupChat.createdAt,
			} as SessionHeaderLike;

			const result = await this.deps.sessionStore.persistFirstMessage({
				sessionPath,
				header,
				groupChatId: this.deps.state.groupChat.groupChatId,
				name: this.deps.state.groupChat.name,
				groupMaxMessages: this.roundMaxMessages,
				sequence: this.sequence,
				content,
			});
			this.entryId = result.entryId;
			this.deps.persistedCount.add(result.entriesPersisted);
		} else {
			try {
				this.entryId = this.deps.sessionStore.appendCustomMessageEntry(
					"pi-tavern.public-message",
					formatEntryContent("User Persona", content),
					true,
					{
						sender: { type: "user_persona" as const },
						content,
						sequence: this.sequence,
						round: {
							round_max_messages: this.roundMaxMessages,
							used_messages: 0,
							remaining_messages: this.roundMaxMessages,
						},
					},
				);
				this.deps.persistedCount.add(1);
			} catch (error) {
				// SessionManager._appendEntry 在磁盘写入前先改内存。
				// 失败时把未持久化的条目从内存清除（恢复编排在 store 内）。
				this.deps.sessionStore.recoverFromFailedAppend(error);
			}
		}

		const persisted = this.deps.sessionStore.getEntry(this.entryId);
		const entryTimestamp = persisted?.timestamp ?? this.timestamp;

		// 阶段 3：提交状态（仅在持久化成功后）
		this.deps.state.round = { roundMaxMessages: this.roundMaxMessages, usedMessages: 0 };
		this.deps.state.nextSequence = this.sequence;
		// 清除上一轮的手举标志（仅成功时）
		for (const character of this.deps.state.onlineCharacters.values()) {
			character.handRaised = false;
		}

		const message: PublicMessageState = {
			sender: { type: "user_persona" as const },
			content,
			event_id: this.entryId,
			sequence: this.sequence,
			timestamp: entryTimestamp,
			round: {
				round_max_messages: this.roundMaxMessages,
				used_messages: 0,
				remaining_messages: this.roundMaxMessages,
			},
		};
		this.deps.publicMessages.push(message);

		// 阶段 4：广播 + TUI 投影（相互独立，互不阻塞）
		this.broadcastAndProject(message);
		return this.entryId;
	}

	/** 广播与 TUI 投影相互独立——互不阻塞（两入口共享）。 */
	private broadcastAndProject(msg: PublicMessageState): void {
		try {
			this.deps.broadcastGroupChatUpdate();
		} catch {
			// 广播失败静默吞掉——对状态与 TUI 无影响
		}

		try {
			this.deps.onPublicMessage?.(msg);
		} catch (error) {
			this.deps.onPublicMessageError?.(
				`${ERROR_TUI_PROJECTION_FAILED_PREFIX}${error instanceof Error ? error.message : ERROR_UNKNOWN}`,
				msg.sequence,
				msg.timestamp,
			);
		}
	}
}
