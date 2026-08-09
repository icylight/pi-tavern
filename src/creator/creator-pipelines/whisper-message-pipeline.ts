import { ResponseError } from "vscode-jsonrpc";
import WebSocket from "ws";
import { type GroupChatState, setHandRaised } from "../../data/group-chat-state.js";
import type { SessionStore } from "../../data/session-store.js";
import { type ClientMessage, JSONRPC_VERSION } from "../../protocol/messages.js";
import type { PublicMessageState } from "../../protocol/public-message-state.js";
import type { WhisperMessageState } from "../../protocol/whisper-message-state.js";
import {
	ERROR_CODE_MESSAGE_TOO_LARGE,
	ERROR_CODE_NO_ACTIVE_ROUND,
	ERROR_CODE_NOT_IN_GROUP,
	ERROR_CODE_PERSIST_FAILED,
	ERROR_CODE_WHISPER_SELF,
	ERROR_CODE_WHISPER_TARGET_OFFLINE,
	ERROR_MESSAGE_TOO_LARGE,
	ERROR_NO_ACTIVE_ROUND,
	ERROR_NOT_GROUP_MEMBER,
	ERROR_PERSIST_FAILED_PREFIX,
	METHOD_WHISPER_MESSAGE,
	METHOD_WHISPER_PLACEHOLDER,
} from "../../shared/messages.js";

type WhisperMessage = Extract<ClientMessage, { method: "whisper" }>;

/** 连接上下文窄接口（与 SubmitMessagePipeline 同构）。 */
interface WhisperConnectionLike {
	sessionId: string | null;
	online: boolean;
}

interface WhisperPipelineDependencies {
	state: GroupChatState;
	/** 公开消息流（stale 检查与合并流读取；跨消息状态经注入引用显式读写）。 */
	publicMessages: PublicMessageState[];
	/** 私信消息流（与公开共用递增器；新增私信 push 此处）。 */
	whisperMessages: WhisperMessageState[];
	persistedCount: { get(): number; add(delta: number): void };
	sessionStore: SessionStore;
	/** 合并流读取（public + whisper 按 sequence 归并；stale 检查与查询同源）。 */
	readMergedMessages: () => Array<PublicMessageState | WhisperMessageState>;
	/** 在线连接表（sessionId → socket；单播/占位广播目标查找）。 */
	connections: Map<string, WebSocket>;
	/** 发送帧（BroadcastHub.send 语义；失败静默 + 断连清理由注入方保证）。 */
	send: (socket: WebSocket, message: unknown) => void;
	/** #152（P2 评审阻断 1）：私信落盘顶层 content 格式化——契约（P1 冻结）= 创建者
	 * 视角完整投影 `{sender} 向 {receiver} 悄悄说：{正文}`（whisper_full 模板渲染）。
	 * 窄接口注入：组合根用模板 getter 实现（P3 五 key 合流后自动走模板；P2 独立
	 * 期回退契约默认形态，防值拷贝陷阱）。 */
	formatWhisperContent: (sender: string, receiver: string, content: string) => string;
	/** #152（Arch 阻断修复）：私信提交后触发（创建者 TUI 完整正文投影，与 onPublicMessage 同构）。 */
	onWhisperMessage?: (whisper: WhisperMessageState) => void;
}

/** whisper 响应 result（stale / round_limit_reached / published 三态，与 speak 同构）。 */
type WhisperResult =
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
			sequence: number;
			round: { round_max_messages: number; used_messages: number; remaining_messages: number };
	  };

/**
 * #152：whisper 管线（请求级管线——与 speak 同构的「校验 → 陈旧性 → 配额+可写
 * → 持久化 → 提交 → 通知」骨架）。在线校验（WS 连接活跃，WH10）→ 自发自收拒绝
 * → 共用轮次额度池 → whisper-message 持久化（共用递增器无空洞）→ 提交 →
 * 接收者单播 WhisperMessage（完整帧）+ 其他 Character 广播 WhisperPlaceholder
 * （占位帧，无正文）；发送者零事件（服务端过滤）。失败不占额度；校验后掉线
 * 不回滚（窄窗口竞态 WH7）。
 */
export class WhisperPipeline {
	private sequence = 0;
	private timestamp = "";
	private entryId = "";
	private roundMaxMessages = 0;

	constructor(private readonly deps: WhisperPipelineDependencies) {}

	async runWhisper(
		socket: WebSocket,
		connection: WhisperConnectionLike,
		message: WhisperMessage,
	): Promise<WhisperResult> {
		void socket;
		// 阶段 1：校验（成员资格 / 大小 / 在线角色 / 活跃轮次 / 目标在线 / 自发自收）
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

		const senderId = onlineCharacter.character.characterId;
		const targetCharacterId = message.params.character_id;
		if (targetCharacterId === senderId) {
			throw new ResponseError(ERROR_CODE_WHISPER_SELF, "Cannot whisper to yourself");
		}

		// 目标在线判定（WH10）= WS 连接活跃：反向查找 onlineCharacters 中
		// character_id 匹配且连接表存在该 sessionId 的连接（连接断开的
		// ready 完成角色不视为在线——消息永不可达会误导发送者）。
		const targetEntry = [...this.deps.state.onlineCharacters.values()].find(
			(online) => online.character.characterId === targetCharacterId,
		);
		const targetSessionId = targetEntry?.sessionId ?? null;
		const targetSocket = targetSessionId !== null ? (this.deps.connections.get(targetSessionId) ?? null) : null;
		// WH10（P2 评审阻断 2）：在线 = WS 连接活跃（readyState OPEN）。close 清理由
		// runtimeTail 异步排队——Map 仍保留 CLOSED/CLOSING socket 的窗口内不得判在线
		// （WH7 仅允许「校验时在线、投递瞬间掉线」的窄窗口，不吞「校验时已关闭」）。
		if (
			targetEntry === undefined ||
			targetSessionId === null ||
			targetSocket === null ||
			targetSocket.readyState !== WebSocket.OPEN
		) {
			throw new ResponseError(ERROR_CODE_WHISPER_TARGET_OFFLINE, "Whisper target character is not online");
		}

		// 阶段 2：陈旧性检查（与 speak 同源 B2/B6）——基于合并流（公开+私信），
		// 排除请求者自己发送的消息（发送者零事件 → 其游标不越过自己的私信）。
		const merged = this.deps.readMergedMessages();
		let latestOtherSequence = 0;
		for (let i = merged.length - 1; i >= 0; i--) {
			const candidate = merged[i];
			if (candidate === undefined) {
				continue;
			}
			if (candidate.sender.type === "character" && candidate.sender.character_id === senderId) {
				continue;
			}
			latestOtherSequence = candidate.sequence;
			break;
		}
		const latest = merged[merged.length - 1];
		const latestSequence = latest !== undefined ? latest.sequence : 0;
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

		// 阶段 3：配额（与 speak 共用同一轮次额度池）+ 可写性
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
		const senderName = onlineCharacter.character.name;
		const recipient = targetEntry.character;

		const details = {
			sender: {
				type: "character" as const,
				character_id: senderId,
				name: senderName,
			},
			recipient: {
				type: "character" as const,
				character_id: recipient.characterId,
				name: recipient.name,
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
				"pi-tavern.whisper-message",
				this.deps.formatWhisperContent(senderName, recipient.name, message.params.content),
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

		const whisper: WhisperMessageState = {
			sender: {
				type: "character" as const,
				character_id: senderId,
				name: senderName,
			},
			recipient: {
				type: "character" as const,
				character_id: recipient.characterId,
				name: recipient.name,
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
		this.deps.whisperMessages.push(whisper);

		// 阶段 6：通知——接收者单播完整帧；其他在线 Character（非发送者非接收者）
		// 单播占位帧（无正文、无 round）；发送者零事件（服务端过滤）。
		this.notify(whisper, connection.sessionId, targetSessionId);

		// 创建者 TUI 投影（Arch 阻断修复）：提交后触发钩子（完整正文视角）。
		try {
			this.deps.onWhisperMessage?.(whisper);
		} catch {
			// 投影失败不影响已提交私信（同 onPublicMessage 容错语义）。
		}

		return {
			published: true,
			sequence: this.sequence,
			round: whisper.round,
		};
	}

	/** 投递（单播逐连接；发送失败由注入方 send 语义兜底，不回滚已提交私信——WH7）。 */
	private notify(whisper: WhisperMessageState, senderSessionId: string, recipientSessionId: string): void {
		const fullFrame = {
			jsonrpc: JSONRPC_VERSION,
			method: METHOD_WHISPER_MESSAGE,
			params: {
				event_id: whisper.event_id,
				sequence: whisper.sequence,
				timestamp: whisper.timestamp,
				sender: whisper.sender,
				recipient: whisper.recipient,
				content: whisper.content,
				round: whisper.round,
			},
		};
		const recipientSocket = this.deps.connections.get(recipientSessionId);
		if (recipientSocket !== undefined) {
			this.deps.send(recipientSocket, fullFrame);
		}

		const placeholderFrame = {
			jsonrpc: JSONRPC_VERSION,
			method: METHOD_WHISPER_PLACEHOLDER,
			params: {
				event_id: whisper.event_id,
				sequence: whisper.sequence,
				timestamp: whisper.timestamp,
				sender: whisper.sender,
				recipient: whisper.recipient,
			},
		};
		for (const [sessionId] of this.deps.state.onlineCharacters) {
			if (sessionId === senderSessionId || sessionId === recipientSessionId) {
				continue;
			}
			const socket = this.deps.connections.get(sessionId);
			if (socket !== undefined) {
				this.deps.send(socket, placeholderFrame);
			}
		}
	}
}
