export interface GroupChatInfo {
	groupChatId: string;
	name: string | null;
	createdAt: string;
	groupMaxMessages: number;
}

export interface RoundState {
	roundMaxMessages: number;
	usedMessages: number;
}

export interface GroupChatState {
	groupChat: GroupChatInfo;
	round: RoundState | null;
	characterReservations: Map<string, string>;
	onlineCharacters: Map<string, never>;
}

export interface CreateGroupChatStateOptions {
	groupChatId: string;
	createdAt: string;
	groupMaxMessages: number;
}

export function createGroupChatState(options: CreateGroupChatStateOptions): GroupChatState {
	assertValidMaxMessages(options.groupMaxMessages);

	return {
		groupChat: {
			groupChatId: options.groupChatId,
			name: null,
			createdAt: options.createdAt,
			groupMaxMessages: options.groupMaxMessages,
		},
		round: null,
		characterReservations: new Map(),
		onlineCharacters: new Map<string, never>(),
	};
}

export function normalizeGroupChatName(name: string): string | null {
	return name.replace(/[\r\n]+/g, " ").trim() || null;
}

export function setGroupChatName(state: GroupChatState, name: string): string | null {
	const normalizedName = normalizeGroupChatName(name);
	state.groupChat.name = normalizedName;
	return normalizedName;
}

export function setGroupMaxMessages(state: GroupChatState, maxMessages: number): void {
	assertValidMaxMessages(maxMessages);
	state.groupChat.groupMaxMessages = maxMessages;
}

function assertValidMaxMessages(maxMessages: number): void {
	if (!Number.isSafeInteger(maxMessages) || maxMessages < 0) {
		throw new Error("maxMessages must be a non-negative safe integer");
	}
}
