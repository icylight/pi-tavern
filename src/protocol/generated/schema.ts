// 由 scripts/generate-schema.mjs 生成（docs-first：#145）——请勿手改。
// 权威源 = src/protocol/schema/*.jsonc（4 个协议定义文件，唯一手写处）。
import { Type } from "typebox";
export const CharacterSummarySchema = Type.Object(
	{
		character_id: Type.String(),
		name: Type.String(),
		description: Type.String(),
	},
	{ additionalProperties: false },
);

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

export const RequestIdSchema = Type.Union([Type.String(), Type.Integer()]);

export const ProtocolErrorObjectSchema = Type.Object(
	{
		code: Type.Union([
			Type.Literal(-32100),
			Type.Literal(-32101),
			Type.Literal(-32102),
			Type.Literal(-32103),
			Type.Literal(-32104),
			Type.Literal(-32105),
			Type.Literal(-32106),
			Type.Literal(-32107),
			Type.Literal(-32108),
			Type.Literal(-32109),
			Type.Literal(-32110),
			Type.Literal(-32111),
			Type.Literal(-32700),
			Type.Literal(-32600),
			Type.Literal(-32601),
			Type.Literal(-32602),
			Type.Literal(-32603),
		]),
		message: Type.String(),
	},
	{ additionalProperties: false },
);

export const NullResultSchema = Type.Null();

export const RoundSnapshotSchema = Type.Object(
	{
		round_max_messages: Type.Integer({ minimum: 0 }),
		used_messages: Type.Integer({ minimum: 0 }),
		remaining_messages: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

export const ClientMessageSchema = Type.Union([
	Type.Object(
		{
			jsonrpc: Type.Literal("2.0"),
			id: RequestIdSchema,
			method: Type.Literal("join_group_chat"),
			params: Type.Object(
				{
					session_id: Type.String(),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			jsonrpc: Type.Literal("2.0"),
			id: RequestIdSchema,
			method: Type.Literal("claim_character"),
			params: Type.Object(
				{
					character_id: Type.String(),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			jsonrpc: Type.Literal("2.0"),
			id: RequestIdSchema,
			method: Type.Literal("character_ready"),
			params: Type.Optional(Type.Object({}, { additionalProperties: false })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			jsonrpc: Type.Literal("2.0"),
			id: RequestIdSchema,
			method: Type.Literal("leave_group_chat"),
			params: Type.Optional(Type.Object({}, { additionalProperties: false })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			jsonrpc: Type.Literal("2.0"),
			id: RequestIdSchema,
			method: Type.Literal("get_group_chat_state"),
			params: Type.Optional(Type.Object({}, { additionalProperties: false })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			jsonrpc: Type.Literal("2.0"),
			id: RequestIdSchema,
			method: Type.Literal("get_message_history"),
			params: Type.Object(
				{
					cursor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			jsonrpc: Type.Literal("2.0"),
			id: RequestIdSchema,
			method: Type.Literal("fetch_messages_since"),
			params: Type.Object(
				{
					since_sequence: Type.Integer({ minimum: 0 }),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			jsonrpc: Type.Literal("2.0"),
			id: RequestIdSchema,
			method: Type.Literal("get_chat_history_file"),
			params: Type.Optional(Type.Object({}, { additionalProperties: false })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			jsonrpc: Type.Literal("2.0"),
			method: Type.Literal("update_character_state"),
			params: Type.Object(
				{
					is_streaming: Type.Boolean(),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			jsonrpc: Type.Literal("2.0"),
			id: RequestIdSchema,
			method: Type.Literal("board_write"),
			params: Type.Object(
				{
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
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			jsonrpc: Type.Literal("2.0"),
			id: RequestIdSchema,
			method: Type.Literal("board_write"),
			params: Type.Object(
				{
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
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			jsonrpc: Type.Literal("2.0"),
			id: RequestIdSchema,
			method: Type.Literal("board_write"),
			params: Type.Object(
				{
					action: Type.Literal("clear"),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			jsonrpc: Type.Literal("2.0"),
			id: RequestIdSchema,
			method: Type.Literal("board_query"),
			params: Type.Optional(Type.Object({}, { additionalProperties: false })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			jsonrpc: Type.Literal("2.0"),
			id: RequestIdSchema,
			method: Type.Literal("speak"),
			params: Type.Object(
				{
					content: Type.String(),
					based_on_sequence: Type.Optional(Type.Integer({ minimum: 0 })),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			jsonrpc: Type.Literal("2.0"),
			id: RequestIdSchema,
			method: Type.Literal("whisper"),
			params: Type.Object(
				{
					character_id: Type.String(),
					content: Type.String(),
					based_on_sequence: Type.Optional(Type.Integer({ minimum: 0 })),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
]);

export const JoinGroupChatResponseSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		id: RequestIdSchema,
		result: Type.Object(
			{
				available_characters: Type.Array(CharacterSummarySchema),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const ClaimedCharacterSchema = Type.Object(
	{
		character_id: Type.String(),
		name: Type.String(),
		description: Type.String(),
		path: Type.String(),
	},
	{ additionalProperties: false },
);

export const ClaimCharacterResponseSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		id: RequestIdSchema,
		result: Type.Object(
			{
				character: ClaimedCharacterSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const EmptySuccessResponseSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		id: RequestIdSchema,
		result: NullResultSchema,
	},
	{ additionalProperties: false },
);

export const ReadyResponseSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		id: RequestIdSchema,
		result: Type.Object(
			{
				latest_sequence: Type.Integer(),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const FailureResponseSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		id: RequestIdSchema,
		error: ProtocolErrorObjectSchema,
	},
	{ additionalProperties: false },
);

export const GroupChatStateResponseSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		id: RequestIdSchema,
		result: Type.Object(
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
				round: Type.Union([RoundSnapshotSchema, Type.Null()]),
				online_characters: Type.Array(OnlineCharacterSchema),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const CharacterJoinedSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		method: Type.Literal("character_joined"),
		params: Type.Object(
			{
				character: CharacterSummarySchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const CharacterLeftSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		method: Type.Literal("character_left"),
		params: Type.Object(
			{
				character: CharacterSummarySchema,
				reason: Type.Union([Type.Literal("left"), Type.Literal("disconnected")]),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const SystemMessageSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		method: Type.Literal("system_message"),
		params: Type.Object(
			{
				content: Type.String(),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const GroupChatClosedSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		method: Type.Literal("group_chat_closed"),
		params: Type.Object(
			{
				group_chat_id: Type.String(),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const PublicMessageSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		method: Type.Literal("public_message"),
		params: Type.Object(
			{
				event_id: Type.String(),
				sequence: Type.Integer({ minimum: 1 }),
				timestamp: Type.String(),
				sender: Type.Union([
					Type.Object(
						{
							type: Type.Literal("user_persona"),
						},
						{ additionalProperties: false },
					),
					Type.Object(
						{
							type: Type.Literal("character"),
							character_id: Type.String(),
							name: Type.String(),
						},
						{ additionalProperties: false },
					),
				]),
				source: Type.Optional(Type.Literal("group")),
				content: Type.String(),
				round: RoundSnapshotSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const WhisperSenderSchema = Type.Object(
	{
		type: Type.Literal("character"),
		character_id: Type.String(),
		name: Type.String(),
	},
	{ additionalProperties: false },
);

export const WhisperMessageSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		method: Type.Literal("whisper_message"),
		params: Type.Object(
			{
				event_id: Type.String(),
				sequence: Type.Integer({ minimum: 1 }),
				timestamp: Type.String(),
				sender: WhisperSenderSchema,
				recipient: WhisperSenderSchema,
				content: Type.String(),
				round: RoundSnapshotSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const WhisperPlaceholderSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		method: Type.Literal("whisper_placeholder"),
		params: Type.Object(
			{
				event_id: Type.String(),
				sequence: Type.Integer({ minimum: 1 }),
				timestamp: Type.String(),
				sender: WhisperSenderSchema,
				recipient: WhisperSenderSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const MessageHistorySchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		method: Type.Literal("message_history"),
		params: Type.Object(
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

export const GetMessageHistoryResponseSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		id: RequestIdSchema,
		result: Type.Object(
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

export const FetchMessagesSinceResponseSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		id: RequestIdSchema,
		result: Type.Object(
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

export const GroupChatUpdateSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		method: Type.Literal("group_chat_update"),
		params: Type.Object(
			{
				latest_sequence: Type.Integer({ minimum: 0 }),
				preview_messages: Type.Array(PublicMessageSchema),
				total_messages: Type.Integer({ minimum: 0 }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const GetChatHistoryFileResponseSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		id: RequestIdSchema,
		result: Type.Object(
			{
				path: Type.String(),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const SpeakResponseSchema = Type.Union([
	Type.Object(
		{
			jsonrpc: Type.Literal("2.0"),
			id: RequestIdSchema,
			result: Type.Object(
				{
					published: Type.Literal(true),
					event_id: Type.String(),
					sequence: Type.Integer({ minimum: 1 }),
					round: RoundSnapshotSchema,
					latest_sequence: Type.Integer({ minimum: 1 }),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			jsonrpc: Type.Literal("2.0"),
			id: RequestIdSchema,
			result: Type.Object(
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
			jsonrpc: Type.Literal("2.0"),
			id: RequestIdSchema,
			result: Type.Object(
				{
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

export const WhisperResponseSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		id: RequestIdSchema,
		result: Type.Object(
			{
				sequence: Type.Integer({ minimum: 1 }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const BoardNoteSchema = Type.Object(
	{
		id: Type.String(),
		content: Type.String(),
	},
	{ additionalProperties: false },
);

export const BoardReasonCodeSchema = Type.Union([
	Type.Literal("max_notes_exceeded"),
	Type.Literal("note_length_exceeded"),
	Type.Literal("note_not_found"),
	Type.Literal("board_empty"),
	Type.Literal("note_unchanged"),
]);

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

export const BoardWriteResponseSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		id: RequestIdSchema,
		result: BoardWriteDataSchema,
	},
	{ additionalProperties: false },
);

export const BoardQueryResponseSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		id: RequestIdSchema,
		result: Type.Object(
			{
				boards: Type.Record(Type.String(), Type.Array(BoardNoteSchema)),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const BoardUpdateSchema = Type.Union([
	Type.Object(
		{
			jsonrpc: Type.Literal("2.0"),
			method: Type.Literal("board_update"),
			params: Type.Object(
				{
					actor: Type.String(),
					action: Type.Union([Type.Literal("add"), Type.Literal("update"), Type.Literal("remove")]),
					note: BoardNoteSchema,
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			jsonrpc: Type.Literal("2.0"),
			method: Type.Literal("board_update"),
			params: Type.Object(
				{
					actor: Type.String(),
					action: Type.Literal("clear"),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
]);

export const ServerMessageSchema = Type.Union([
	JoinGroupChatResponseSchema,
	ClaimCharacterResponseSchema,
	EmptySuccessResponseSchema,
	ReadyResponseSchema,
	FailureResponseSchema,
	GroupChatStateResponseSchema,
	GetMessageHistoryResponseSchema,
	FetchMessagesSinceResponseSchema,
	GetChatHistoryFileResponseSchema,
	SpeakResponseSchema,
	WhisperResponseSchema,
	CharacterJoinedSchema,
	CharacterLeftSchema,
	SystemMessageSchema,
	GroupChatClosedSchema,
	MessageHistorySchema,
	PublicMessageSchema,
	WhisperMessageSchema,
	WhisperPlaceholderSchema,
	GroupChatUpdateSchema,
	BoardWriteResponseSchema,
	BoardQueryResponseSchema,
	BoardUpdateSchema,
]);
