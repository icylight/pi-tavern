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
	Type.Object(
		{
			id: RequestIdSchema,
			type: Type.Literal("speak"),
			content: Type.String(),
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
]);

export type ServerMessage = Static<typeof ServerMessageSchema>;
export type PublicMessage = Static<typeof PublicMessageSchema>;

export type CharacterSummaryWire = Static<typeof CharacterSummarySchema>;
export type JoinGroupChatSuccess = Extract<ServerMessage, { command: "join_group_chat"; success: true }>;
export type ClaimCharacterSuccess = Extract<ServerMessage, { command: "claim_character"; success: true }>;
export type GroupChatStateSuccess = Extract<ServerMessage, { command: "get_group_chat_state"; success: true }>;
export type GroupChatStateMessage = GroupChatStateSuccess["data"];
