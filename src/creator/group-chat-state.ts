import type { CharacterSummary } from "../config/character-card.js";

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

export interface OnlineCharacterState {
	sessionId: string;
	character: CharacterSummary;
	isStreaming: boolean;
	handRaised: boolean;
}

export interface GroupChatState {
	groupChat: GroupChatInfo;
	round: RoundState | null;
	nextSequence: number;
	characterReservations: Map<string, string>;
	onlineCharacters: Map<string, OnlineCharacterState>;
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
		nextSequence: 0,
		characterReservations: new Map(),
		onlineCharacters: new Map<string, OnlineCharacterState>(),
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

export function startNewRound(state: GroupChatState): RoundState {
	const round: RoundState = {
		roundMaxMessages: state.groupChat.groupMaxMessages,
		usedMessages: 0,
	};
	state.round = round;
	return round;
}

export function advanceSequence(state: GroupChatState): number {
	state.nextSequence += 1;
	return state.nextSequence;
}

function assertValidMaxMessages(maxMessages: number): void {
	if (!Number.isSafeInteger(maxMessages) || maxMessages < 0) {
		throw new Error("maxMessages must be a non-negative safe integer");
	}
}
