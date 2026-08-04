import { type Static, Type } from "typebox";

export const CharacterSummarySchema = Type.Object(
	{
		character_id: Type.String(),
		name: Type.String(),
		description: Type.String(),
	},
	{ additionalProperties: false },
);

export type CharacterSummaryMessage = Static<typeof CharacterSummarySchema>;

export const OnlineCharacterSchema = Type.Object(
	{
		character_id: Type.String(),
		name: Type.String(),
		description: Type.String(),
		is_self: Type.Boolean(),
		is_streaming: Type.Boolean(),
		hand_raised: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const RequestIdSchema = Type.Optional(Type.String());

export const ClientMessageSchema = Type.Union([
	Type.Object(
		{
			id: RequestIdSchema,
			type: Type.Literal("join_group_chat"),
			session_id: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			id: RequestIdSchema,
			type: Type.Literal("claim_character"),
			character_id: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			id: RequestIdSchema,
			type: Type.Literal("character_ready"),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			id: RequestIdSchema,
			type: Type.Literal("leave_group_chat"),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			id: RequestIdSchema,
			type: Type.Literal("get_group_chat_state"),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			id: RequestIdSchema,
			type: Type.Literal("get_message_history"),
			cursor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			id: RequestIdSchema,
			type: Type.Literal("fetch_messages_since"),
			since_sequence: Type.Integer({ minimum: 0 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			id: RequestIdSchema,
			type: Type.Literal("get_chat_history_file"),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("update_character_state"),
			is_streaming: Type.Boolean(),
		},
		{ additionalProperties: false },
	),
	// 白板模型（#114）：board_write = 贴/改/撕/清（PR #116 review 修正：按 action
	// 判别 union，跨字段不变量 schema 层 fail-close——F1）。不带 actor 字段——
	// 服务端从 session 推导，操作永远作用于发送者自己的白板（actor 限定本人板）。
	// set：note 全可选——「update 不带 content = note_unchanged」是契约定义的业务
	// 幂等（09:26 定案），schema 不得灭掉该告知场景；空串由 store 拦为 noop。
	Type.Object(
		{
			id: RequestIdSchema,
			type: Type.Literal("board_write"),
			action: Type.Literal("set"),
			note: Type.Optional(
				Type.Object(
					{
						id: Type.Optional(Type.String()),
						content: Type.Optional(Type.String()),
					},
					{ additionalProperties: false },
				),
			),
		},
		{ additionalProperties: false },
	),
	// remove：必带 id 定向（无 id = 协议级拒绝而非业务 no-op——P1 fail-close）；
	// content 禁止（被撕条完整内容由服务端在 board_update 广播中回带）。
	Type.Object(
		{
			id: RequestIdSchema,
			type: Type.Literal("board_write"),
			action: Type.Literal("remove"),
			note: Type.Object(
				{
					id: Type.String(),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	// clear：禁携带 note（清空语义无目标条）。
	Type.Object(
		{
			id: RequestIdSchema,
			type: Type.Literal("board_write"),
			action: Type.Literal("clear"),
		},
		{ additionalProperties: false },
	),
	// 白板模型（#114）：board_query 查全量（per-character 条目）。无参——
	// groupId 由 session 隐含；跨群聊隔离由服务端按 session 关联保证。
	Type.Object(
		{
			id: RequestIdSchema,
			type: Type.Literal("board_query"),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			id: RequestIdSchema,
			type: Type.Literal("speak"),
			content: Type.String(),
			// ISSUE-013：可选字段——缺省 = 旧版客户端，服务端跳过 stale
			// 检查（平滑演进）。存在时服务端拒绝过期发言（reason: "stale"）
			// 而不是发布它们。
			based_on_sequence: Type.Optional(Type.Integer({ minimum: 0 })),
		},
		{ additionalProperties: false },
	),
]);

export type ClientMessage = Static<typeof ClientMessageSchema>;

export type SpeakMessage = Extract<ClientMessage, { type: "speak" }>;

const JoinGroupChatResponseSchema = Type.Object(
	{
		id: RequestIdSchema,
		type: Type.Literal("response"),
		command: Type.Literal("join_group_chat"),
		success: Type.Literal(true),
		data: Type.Object({ available_characters: Type.Array(CharacterSummarySchema) }, { additionalProperties: false }),
	},
	{ additionalProperties: false },
);

const ClaimedCharacterSchema = Type.Object(
	{
		character_id: Type.String(),
		name: Type.String(),
		description: Type.String(),
		path: Type.String(),
	},
	{ additionalProperties: false },
);

const ClaimCharacterResponseSchema = Type.Object(
	{
		id: RequestIdSchema,
		type: Type.Literal("response"),
		command: Type.Literal("claim_character"),
		success: Type.Literal(true),
		data: Type.Object({ character: ClaimedCharacterSchema }, { additionalProperties: false }),
	},
	{ additionalProperties: false },
);

const EmptySuccessResponseSchema = Type.Object(
	{
		id: RequestIdSchema,
		type: Type.Literal("response"),
		command: Type.Union([Type.Literal("character_ready"), Type.Literal("leave_group_chat")]),
		success: Type.Literal(true),
	},
	{ additionalProperties: false },
);

const FailureResponseSchema = Type.Object(
	{
		id: RequestIdSchema,
		type: Type.Literal("response"),
		command: Type.Union([
			Type.Literal("join_group_chat"),
			Type.Literal("claim_character"),
			Type.Literal("character_ready"),
			Type.Literal("leave_group_chat"),
			Type.Literal("get_group_chat_state"),
			Type.Literal("get_message_history"),
			Type.Literal("fetch_messages_since"),
			Type.Literal("get_chat_history_file"),
			Type.Literal("speak"),
			// 白板模型（#114）：新消息的失败通道 = union 加新命令成员（合法 union 增量，
			// speak 先例；旧端对新消息本就 fail-close，兼容性政策覆盖）。
			Type.Literal("board_write"),
			Type.Literal("board_query"),
		]),
		success: Type.Literal(false),
		error: Type.String(),
	},
	{ additionalProperties: false },
);

const GroupChatStateResponseSchema = Type.Object(
	{
		id: RequestIdSchema,
		type: Type.Literal("response"),
		command: Type.Literal("get_group_chat_state"),
		success: Type.Literal(true),
		data: Type.Object(
			{
				group_chat: Type.Object(
					{
						group_chat_id: Type.String(),
						name: Type.Union([Type.String(), Type.Null()]),
						created_at: Type.String(),
						group_max_messages: Type.Integer({ minimum: 0 }),
					},
					{ additionalProperties: false },
				),
				round: Type.Union([
					Type.Object(
						{
							round_max_messages: Type.Integer({ minimum: 0 }),
							used_messages: Type.Integer({ minimum: 0 }),
							remaining_messages: Type.Integer({ minimum: 0 }),
						},
						{ additionalProperties: false },
					),
					Type.Null(),
				]),
				online_characters: Type.Array(OnlineCharacterSchema),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const CharacterJoinedSchema = Type.Object(
	{
		type: Type.Literal("character_joined"),
		character: CharacterSummarySchema,
	},
	{ additionalProperties: false },
);

const CharacterLeftSchema = Type.Object(
	{
		type: Type.Literal("character_left"),
		character: CharacterSummarySchema,
		reason: Type.Union([Type.Literal("left"), Type.Literal("disconnected")]),
	},
	{ additionalProperties: false },
);

const GroupChatClosedSchema = Type.Object(
	{
		type: Type.Literal("group_chat_closed"),
		group_chat_id: Type.String(),
	},
	{ additionalProperties: false },
);

const RoundSnapshotSchema = Type.Object(
	{
		round_max_messages: Type.Integer({ minimum: 0 }),
		used_messages: Type.Integer({ minimum: 0 }),
		remaining_messages: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

const PublicMessageSchema = Type.Object(
	{
		type: Type.Literal("public_message"),
		event_id: Type.String(),
		sequence: Type.Integer({ minimum: 1 }),
		timestamp: Type.String(),
		sender: Type.Union([
			Type.Object({ type: Type.Literal("user_persona") }, { additionalProperties: false }),
			Type.Object(
				{ type: Type.Literal("character"), character_id: Type.String(), name: Type.String() },
				{ additionalProperties: false },
			),
		]),
		content: Type.String(),
		round: RoundSnapshotSchema,
	},
	{ additionalProperties: false },
);

const MessageHistorySchema = Type.Object(
	{
		type: Type.Literal("message_history"),
		messages: Type.Array(PublicMessageSchema),
		cursor: Type.Union([Type.String(), Type.Null()]),
		has_more: Type.Boolean(),
		total_messages: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

const GetMessageHistoryResponseSchema = Type.Object(
	{
		id: RequestIdSchema,
		type: Type.Literal("response"),
		command: Type.Literal("get_message_history"),
		success: Type.Literal(true),
		data: Type.Object(
			{
				messages: Type.Array(PublicMessageSchema),
				cursor: Type.Union([Type.String(), Type.Null()]),
				has_more: Type.Boolean(),
				total_messages: Type.Integer({ minimum: 0 }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const FetchMessagesSinceResponseSchema = Type.Object(
	{
		id: RequestIdSchema,
		type: Type.Literal("response"),
		command: Type.Literal("fetch_messages_since"),
		success: Type.Literal(true),
		data: Type.Object(
			{
				messages: Type.Array(PublicMessageSchema),
				latest_sequence: Type.Integer({ minimum: 0 }),
				total_messages: Type.Integer({ minimum: 0 }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const GroupChatUpdateSchema = Type.Object(
	{
		type: Type.Literal("group_chat_update"),
		latest_sequence: Type.Integer({ minimum: 0 }),
		preview_messages: Type.Array(PublicMessageSchema),
		total_messages: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

const GetChatHistoryFileResponseSchema = Type.Object(
	{
		id: RequestIdSchema,
		type: Type.Literal("response"),
		command: Type.Literal("get_chat_history_file"),
		success: Type.Literal(true),
		data: Type.Object(
			{
				path: Type.String(),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const SpeakResponseSchema = Type.Union([
	Type.Object(
		{
			id: RequestIdSchema,
			type: Type.Literal("response"),
			command: Type.Literal("speak"),
			success: Type.Literal(true),
			data: Type.Object(
				{
					published: Type.Literal(true),
					event_id: Type.String(),
					sequence: Type.Integer({ minimum: 1 }),
					round: RoundSnapshotSchema,
					// ISSUE-013 B6：让客户端能把 last-seen sequence 推进到
					// 自己的消息之后（回声被过滤，游标不会自行推进），
					// 而不会被误判为 stale。
					latest_sequence: Type.Integer({ minimum: 1 }),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			id: RequestIdSchema,
			type: Type.Literal("response"),
			command: Type.Literal("speak"),
			success: Type.Literal(true),
			data: Type.Object(
				{
					published: Type.Literal(false),
					reason: Type.Literal("round_limit_reached"),
					hand_raised: Type.Literal(true),
					round: RoundSnapshotSchema,
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			id: RequestIdSchema,
			type: Type.Literal("response"),
			command: Type.Literal("speak"),
			success: Type.Literal(true),
			data: Type.Object(
				{
					// ISSUE-013 B2：stale 拒绝镜像 round_limit_reached——业务拒绝
					// 而非协议错误。只携带缺失的 sequence 区间；客户端通过既有的
					// fetch_messages_since 拉增量（不引入第二个拉取协议）。
					published: Type.Literal(false),
					reason: Type.Literal("stale"),
					missing_sequences: Type.Object(
						{
							from: Type.Integer({ minimum: 0 }),
							to: Type.Integer({ minimum: 1 }),
						},
						{ additionalProperties: false },
					),
					round: RoundSnapshotSchema,
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
]);

// ===== 白板模型（#114，ADR-0007）：board_write / board_query / board_update =====

/** 白板条（wire 形态）：稳定条 id 由 store 分配，remove/edit 按 id 定向。 */
export const BoardNoteSchema = Type.Object(
	{
		id: Type.String(),
		content: Type.String(),
	},
	{ additionalProperties: false },
);

export type BoardNoteWire = Static<typeof BoardNoteSchema>;

/**
 * 白板 reason_code 五码（09:24 版定案，取值区分告知/拒绝）：
 * - 拒绝码（资源约束，未执行）：max_notes_exceeded / note_length_exceeded
 * - 告知码（幂等成立，changed:false 静默）：note_not_found / board_empty / note_unchanged
 * 群聊静默规则：所有 changed:false 均不广播 board_update；告知/拒绝差异在接口层可见。
 */
export const BoardReasonCodeSchema = Type.Union([
	Type.Literal("max_notes_exceeded"),
	Type.Literal("note_length_exceeded"),
	Type.Literal("note_not_found"),
	Type.Literal("board_empty"),
	Type.Literal("note_unchanged"),
]);

/**
 * board_write 成功响应 data（嵌套两态，外层 success 恒 true）：
 * - { changed: true, note? }：有变化；set 新贴/改条回带 { id, content }（id 回带闭环，
 *   业务规则由 pipeline 保证必带）；remove/clear applied 不带 note
 * - { changed: false, code }：无变化——五码取值区分告知（幂等）与拒绝（资源约束）
 * 编解码层排除无意义组合（changed:true 不能带 code 等）。
 */
export const BoardWriteDataSchema = Type.Union([
	Type.Object(
		{
			changed: Type.Literal(true),
			note: Type.Optional(BoardNoteSchema),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			changed: Type.Literal(false),
			code: BoardReasonCodeSchema,
		},
		{ additionalProperties: false },
	),
]);

export type BoardWriteDataWire = Static<typeof BoardWriteDataSchema>;

/** board_write 响应：success 恒 true 业务变体（success:false 协议错误走 FailureResponseSchema）。 */
export const BoardWriteResponseSchema = Type.Object(
	{
		id: RequestIdSchema,
		type: Type.Literal("response"),
		command: Type.Literal("board_write"),
		success: Type.Literal(true),
		data: BoardWriteDataSchema,
	},
	{ additionalProperties: false },
);

/** board_query 响应：全量 per-character 条目（boards: sender → 条列表）。 */
export const BoardQueryResponseSchema = Type.Object(
	{
		id: RequestIdSchema,
		type: Type.Literal("response"),
		command: Type.Literal("board_query"),
		success: Type.Literal(true),
		data: Type.Object(
			{
				boards: Type.Record(Type.String(), Type.Array(BoardNoteSchema)),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

/**
 * board_update 服务器通知（复用 broadcast() 通道，不混入 group_chat_update）：
 * actor + action 四值（set 映射：新贴→add、改条→update）；remove 携带被撕条内容
 * （增量摘要含删除标记，锚点 2 支撑）；clear 无 note。无 sequence 字段——不在消息流里、
 * 无消息流水位语义；字符侧不得视为水位（B4 接线约束）。
 * PR #116 review 修正（F3）：按 action 判别 union——add/update/remove 必带 note
 * （完整条 {id, content}），clear 禁 note；非法组合 codec 层即拒。
 */
export const BoardUpdateSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("board_update"),
			actor: Type.String(),
			action: Type.Union([Type.Literal("add"), Type.Literal("update"), Type.Literal("remove")]),
			note: BoardNoteSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("board_update"),
			actor: Type.String(),
			action: Type.Literal("clear"),
		},
		{ additionalProperties: false },
	),
]);

export const ServerMessageSchema = Type.Union([
	JoinGroupChatResponseSchema,
	ClaimCharacterResponseSchema,
	EmptySuccessResponseSchema,
	FailureResponseSchema,
	GroupChatStateResponseSchema,
	GetMessageHistoryResponseSchema,
	FetchMessagesSinceResponseSchema,
	GetChatHistoryFileResponseSchema,
	SpeakResponseSchema,
	CharacterJoinedSchema,
	CharacterLeftSchema,
	GroupChatClosedSchema,
	MessageHistorySchema,
	PublicMessageSchema,
	GroupChatUpdateSchema,
	BoardWriteResponseSchema,
	BoardQueryResponseSchema,
	BoardUpdateSchema,
]);

export type ServerMessage = Static<typeof ServerMessageSchema>;
export type PublicMessage = Static<typeof PublicMessageSchema>;

export type CharacterSummaryWire = Static<typeof CharacterSummarySchema>;
export type JoinGroupChatSuccess = Extract<ServerMessage, { command: "join_group_chat"; success: true }>;
export type ClaimCharacterSuccess = Extract<ServerMessage, { command: "claim_character"; success: true }>;
export type GroupChatStateSuccess = Extract<ServerMessage, { command: "get_group_chat_state"; success: true }>;
export type GroupChatStateMessage = GroupChatStateSuccess["data"];
