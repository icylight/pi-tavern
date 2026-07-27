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
			type: Type.Literal("update_character_state"),
			is_streaming: Type.Boolean(),
		},
		{ additionalProperties: false },
	),
]);

export type ClientMessage = Static<typeof ClientMessageSchema>;

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

const MessageHistorySchema = Type.Object(
	{
		type: Type.Literal("message_history"),
		messages: Type.Array(Type.Unknown()),
		cursor: Type.Union([Type.String(), Type.Null()]),
		has_more: Type.Boolean(),
		total_messages: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

export const ServerMessageSchema = Type.Union([
	JoinGroupChatResponseSchema,
	ClaimCharacterResponseSchema,
	EmptySuccessResponseSchema,
	FailureResponseSchema,
	GroupChatStateResponseSchema,
	CharacterJoinedSchema,
	CharacterLeftSchema,
	GroupChatClosedSchema,
	MessageHistorySchema,
]);

export type ServerMessage = Static<typeof ServerMessageSchema>;

export type CharacterSummaryWire = Static<typeof CharacterSummarySchema>;
export type JoinGroupChatSuccess = Extract<ServerMessage, { command: "join_group_chat"; success: true }>;
export type ClaimCharacterSuccess = Extract<ServerMessage, { command: "claim_character"; success: true }>;
export type GroupChatStateSuccess = Extract<ServerMessage, { command: "get_group_chat_state"; success: true }>;
export type GroupChatStateMessage = GroupChatStateSuccess["data"];
