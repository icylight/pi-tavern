import type { Static } from "typebox";

import type {
	BoardNoteSchema,
	BoardWriteDataSchema,
	CharacterSummarySchema,
	ClaimedCharacterSchema,
	ClientMessageSchema,
	OnlineCharacterSchema,
	PublicMessageSchema,
	ServerMessageSchema,
} from "./generated/schema.js";

/**
 * JSON-RPC 2.0 标准信封（迁移豁免零漂移——特例仅此一次）。
 * 判别字段 type → method；请求/响应/通知统一 {jsonrpc:"2.0"}；载荷进 params；
 * 响应 {command, success, data} → {result} / {error:{code,message}}。
 * F 类 method 判别常量（欠账）挂同批抽取，先用字面量。
 *
 * docs-first：schema 定义已迁移至 src/protocol/schema/*.jsonc（唯一手写
 * 源头），本文件从生成产物 re-export——生成产物不得手改；类型继续由 Static
 * 从同一 schema 对象推导（消费面零变化）。
 */
export const JSONRPC_VERSION = "2.0";

export {
	BoardNoteSchema,
	BoardQueryResponseSchema,
	BoardReasonCodeSchema,
	BoardUpdateSchema,
	BoardWriteDataSchema,
	BoardWriteResponseSchema,
	CharacterJoinedSchema,
	CharacterLeftSchema,
	CharacterSummarySchema,
	ClaimCharacterResponseSchema,
	ClaimedCharacterSchema,
	ClientMessageSchema,
	EmptySuccessResponseSchema,
	FailureResponseSchema,
	FetchMessagesSinceResponseSchema,
	GetChatHistoryFileResponseSchema,
	GetMessageHistoryResponseSchema,
	GroupChatClosedSchema,
	GroupChatStateResponseSchema,
	GroupChatUpdateSchema,
	JoinGroupChatResponseSchema,
	MessageHistorySchema,
	NullResultSchema,
	OnlineCharacterSchema,
	ProtocolErrorObjectSchema,
	PublicMessageSchema,
	ReadyResponseSchema,
	RoundSnapshotSchema,
	ServerMessageSchema,
	SpeakResponseSchema,
	SystemMessageSchema,
} from "./generated/schema.js";

/** 角色摘要（join 响应 available_characters 成员 / 成员通知 character 字段）。 */
export type CharacterSummaryMessage = Static<typeof CharacterSummarySchema>;
export type CharacterSummaryWire = Static<typeof CharacterSummarySchema>;

/** 在线角色（group_chat_state 的 members 成员；is_self = 本 session 身份）。 */
export type OnlineCharacterWire = Static<typeof OnlineCharacterSchema>;

export type ClientMessage = Static<typeof ClientMessageSchema>;

export type SpeakMessage = Extract<ClientMessage, { method: "speak" }>;

export type ServerMessage = Static<typeof ServerMessageSchema>;
export type PublicMessage = Static<typeof PublicMessageSchema>;

/** 白板条（wire 形态）：稳定条 id 由 store 分配，remove/edit 按 id 定向。 */
export type BoardNoteWire = Static<typeof BoardNoteSchema>;

/** board_write 成功响应 result（嵌套两态）。 */
export type BoardWriteDataWire = Static<typeof BoardWriteDataSchema>;

export type JoinGroupChatSuccess = Extract<
	ServerMessage,
	{ result: { available_characters: CharacterSummaryMessage[] } }
>;
export type ClaimCharacterSuccess = Extract<
	ServerMessage,
	{ result: { character: Static<typeof ClaimedCharacterSchema> } }
>;
/**   方案 a：ready 成功响应（result 含进入时刻水位）。 */
export type ReadyResponse = Extract<ServerMessage, { result: { latest_sequence: number } }>;
export type GroupChatStateSuccess = Extract<ServerMessage, { result: { group_chat: unknown } }>;
export type GroupChatStateMessage = GroupChatStateSuccess["result"];
