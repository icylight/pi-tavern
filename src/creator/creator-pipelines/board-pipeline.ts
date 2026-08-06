import { ResponseError } from "vscode-jsonrpc";
import type WebSocket from "ws";
import type { BoardStore } from "../../data/board-store.js";
import type { GroupChatState } from "../../data/group-chat-state.js";
import { type ClientMessage, JSONRPC_VERSION } from "../../protocol/messages.js";
import {
	ERROR_CODE_INVALID_NOTE_ID,
	ERROR_CODE_NOT_IN_GROUP,
	ERROR_NOT_GROUP_MEMBER,
	ERROR_NOTE_ID_EMPTY,
	METHOD_BOARD_UPDATE,
} from "../../shared/messages.js";

type BoardWriteMessage = Extract<ClientMessage, { method: "board_write" }>;
type BoardQueryMessage = Extract<ClientMessage, { method: "board_query" }>;

/** 连接上下文窄接口（creator-runtime 的 ConnectionContext 结构子集）。 */
export interface BoardConnectionLike {
	sessionId: string | null;
	online: boolean;
}

export interface BoardPipelineDependencies {
	state: GroupChatState;
	boardStore: BoardStore;
	/** board_update 通知通道（复用 broadcast()，不混入 group_chat_update）。 */
	broadcast: (message: unknown) => void;
	/** creator 实时提示（纯展示，组合根接线；每次 applied 广播触发）。 */
	onBoardUpdated?: (update: {
		actor: string;
		action: "add" | "update" | "remove" | "clear";
		note?: { id: string; content: string };
	}) => void;
}

/**
 * 白板管线（#114，ADR-0007 §3）：board_write 请求-响应四态 + applied 后广播
 * board_update 增量摘要；board_query 全量查询。outcome → wire 响应映射在本层
 * （data 层不依赖协议类型，B2 约束⑤）。
 *
 * 语义要点：
 * - 只允许本人板（sender = 在线角色的 character_id，session 推导，无 actor 字段）
 * - changed:false（告知/拒绝）一律不广播（群聊静默，09:24 版拍板③）
 * - set 映射：请求带 id = update、无 id = add（新贴由 store 分配条 id）
 * - note.id 携带时非空校验（Arch B3 建议：空串 = 无 id 语义，协议层拒绝）
 */
export class BoardPipeline {
	constructor(private readonly deps: BoardPipelineDependencies) {}

	/** board_write 入口：校验 → store 写 → 响应四态 → applied 广播 board_update。 */
	runBoardWrite(
		socket: WebSocket,
		connection: BoardConnectionLike,
		message: BoardWriteMessage,
	): {
		changed: boolean;
		note?: { id: string; content: string };
		code?: string;
	} {
		void socket;
		const sender = this.requireOnlineCharacter(connection, message);
		const note = message.params.action === "clear" ? undefined : message.params.note;
		// Arch B3 建议：携带 id 必须非空（空串 = 无 id 语义，协议层拒绝）。
		if (note?.id !== undefined && note.id === "") {
			throw new ResponseError(ERROR_CODE_INVALID_NOTE_ID, ERROR_NOTE_ID_EMPTY);
		}
		// 增量摘要需要被撕条完整内容（{id, content}——schema 要求 content）；
		// 必须在写前读（写后已不在板上）。
		const removedNote =
			message.params.action === "remove" && note?.id
				? this.deps.boardStore.read(this.deps.state.groupChat.groupChatId)[sender]?.find((n) => n.id === note.id)
				: undefined;
		const outcome = this.deps.boardStore.write(
			this.deps.state.groupChat.groupChatId,
			sender,
			message.params.action,
			note,
		);
		if (outcome.status === "applied") {
			// 增量摘要：remove 携带被撕条完整内容；clear 无 note。
			const action: "add" | "update" | "remove" | "clear" =
				message.params.action === "set" ? (note?.id !== undefined ? "update" : "add") : message.params.action;
			const broadcastNote = outcome.note ?? removedNote;
			const wireUpdate = {
				jsonrpc: JSONRPC_VERSION,
				method: METHOD_BOARD_UPDATE,
				params: {
					actor: sender,
					action,
					...(broadcastNote ? { note: broadcastNote } : {}),
				},
			};
			this.deps.broadcast(wireUpdate);
			// creator 实时提示（纯展示）：每次 applied 广播同步通知组合根。
			this.deps.onBoardUpdated?.({ actor: sender, action, ...(broadcastNote ? { note: broadcastNote } : {}) });
		}
		return {
			changed: outcome.status === "applied",
			...(outcome.status === "applied" && outcome.note ? { note: outcome.note } : {}),
			...(outcome.status !== "applied" ? { code: outcome.code } : {}),
		};
	}

	/** board_query 入口：全量 per-character 条目（无参；groupId 由 session 隐含）。 */
	runBoardQuery(
		socket: WebSocket,
		connection: BoardConnectionLike,
		message: BoardQueryMessage,
	): {
		boards: Record<string, { id: string; content: string }[]>;
	} {
		void socket;
		this.requireOnlineCharacter(connection, message);
		return {
			boards: this.deps.boardStore.read(this.deps.state.groupChat.groupChatId),
		};
	}

	/** 成员资格校验（与 speak 管线同规）：非成员 / 未连接 = 协议级拒绝。 */
	private requireOnlineCharacter(connection: BoardConnectionLike, message: { id?: string | number }): string {
		if (!connection.online || connection.sessionId === null) {
			throw new ResponseError(ERROR_CODE_NOT_IN_GROUP, ERROR_NOT_GROUP_MEMBER);
		}
		const onlineCharacter = this.deps.state.onlineCharacters.get(connection.sessionId);
		if (!onlineCharacter) {
			throw new ResponseError(ERROR_CODE_NOT_IN_GROUP, ERROR_NOT_GROUP_MEMBER);
		}
		return onlineCharacter.character.characterId;
	}
}
