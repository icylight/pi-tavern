import type WebSocket from "ws";

import type { CharacterCard, CharacterSummary } from "../config/character-card.js";
import type { BoardStore } from "../data/board-store.js";
import type { GroupChatState } from "../data/group-chat-state.js";
import type { SessionStore } from "../data/session-store.js";
import type { PublicMessageState } from "../protocol/public-message-state.js";
import type { BroadcastHub } from "./broadcast-hub.js";
import type { ConnectionContext } from "./connection-manager.js";
import type { BoardPipeline } from "./creator-pipelines/board-pipeline.js";
import type { ClaimPipeline } from "./creator-pipelines/claim-pipeline.js";
import { JoinPipeline } from "./creator-pipelines/join-pipeline.js";
import { LeavePipeline } from "./creator-pipelines/leave-pipeline.js";
import type { QueryPipeline } from "./creator-pipelines/query-pipeline.js";
import type { ReadyPipeline } from "./creator-pipelines/ready-pipeline.js";
import type { SubmitMessagePipeline } from "./creator-pipelines/submit-message-pipeline.js";
import type { HeartbeatRegistry } from "./heartbeat-registry.js";
import type { MemberBookkeeping } from "./member-bookkeeping.js";

/** 管线装配访问的骨架窄接口（结构类型；模块不 import CreatorRuntime 类本身）。 */
export interface PipelineAssemblyHost {
	state: GroupChatState;
	connections: Map<string, WebSocket>;
	heartbeatRegistry: HeartbeatRegistry;
	publicMessages: PublicMessageState[];
	characters: ReadonlyMap<string, CharacterCard>;
	sessionStore: SessionStore;
	boardStore: BoardStore;
	persistedCount: { get: () => number; add: (delta: number) => void };
	broadcastHub: BroadcastHub;
	memberBookkeeping: MemberBookkeeping;
	enqueue: <T>(operation: () => T | Promise<T>) => Promise<T>;
	/** 回调经 getter 读取（测试后期赋值仍生效——Arch ②「闭包捕获最终引用」同模式）。 */
	readOnPublicMessage: () => ((msg: PublicMessageState) => void) | undefined;
	readOnPublicMessageError: () => ((error: string, sequence: number, timestamp: string) => void) | undefined;
	readOnMembersChanged: () => (() => void) | undefined;
	now: () => Date;
	toCharacterSummary: (character: CharacterCard) => CharacterSummary;
	toCharacterSummaryMessage: (character: CharacterSummary) => {
		character_id: string;
		name: string;
		description: string;
	};
}

export interface PipelineAssembly {
	joinPipeline: JoinPipeline;
	leavePipeline: LeavePipeline;
	submitMessageDeps: ConstructorParameters<typeof SubmitMessagePipeline>[0];
	claimDeps: ConstructorParameters<typeof ClaimPipeline>[0];
	readyDeps: ConstructorParameters<typeof ReadyPipeline>[0];
	queryDeps: ConstructorParameters<typeof QueryPipeline>[0];
	boardDeps: ConstructorParameters<typeof BoardPipeline>[0];
}

/** 管线门面装配（PR-B 拆自 CreatorRuntime 构造器；跨消息状态经注入引用显式读写，决策 7）。 */
export function assemblePipelineDeps(host: PipelineAssemblyHost): PipelineAssembly {
	const { broadcastHub, memberBookkeeping } = host;
	return {
		joinPipeline: new JoinPipeline({
			connections: host.connections,
			getAvailableCharacters: () => memberBookkeeping.getAvailableCharacters(),
			toCharacterSummaryMessage: host.toCharacterSummaryMessage,
			send: (socket, message) => broadcastHub.send(socket, message),
			sendFailure: (socket, id, command, reason) => broadcastHub.sendFailure(socket, id, command, reason),
		}),
		leavePipeline: new LeavePipeline({
			removeOnlineCharacter: (connection, reason) =>
				memberBookkeeping.removeOnlineCharacter(connection as ConnectionContext, reason),
			send: (socket, message) => broadcastHub.send(socket, message),
			sendFailure: (socket, id, command, reason) => broadcastHub.sendFailure(socket, id, command, reason),
		}),
		submitMessageDeps: {
			state: host.state,
			publicMessages: host.publicMessages,
			persistedCount: host.persistedCount,
			sessionStore: host.sessionStore,
			broadcastGroupChatUpdate: () => broadcastHub.broadcastGroupChatUpdate(),
			onPublicMessage: (msg) => host.readOnPublicMessage()?.(msg),
			onPublicMessageError: (error, sequence, timestamp) =>
				host.readOnPublicMessageError()?.(error, sequence, timestamp),
			send: (socket, message) => broadcastHub.send(socket, message),
			sendFailure: (socket, id, command, reason) => broadcastHub.sendFailure(socket, id, command, reason),
		},
		claimDeps: {
			state: host.state,
			characters: host.characters,
			isCharacterAvailable: (characterId) => memberBookkeeping.isCharacterAvailable(characterId),
			startReadyTimer: (socket, connection) =>
				memberBookkeeping.startReadyTimer(socket, connection as ConnectionContext),
			toCharacterSummaryMessage: host.toCharacterSummaryMessage,
			send: (socket, message) => broadcastHub.send(socket, message),
			sendFailure: (socket, id, command, reason) => broadcastHub.sendFailure(socket, id, command, reason),
		},
		readyDeps: {
			state: host.state,
			connections: host.connections,
			heartbeatRegistry: host.heartbeatRegistry,
			publicMessages: host.publicMessages,
			characters: host.characters,
			clearReadyTimer: (connection) => memberBookkeeping.clearReadyTimer(connection as ConnectionContext),
			now: () => host.now(),
			toCharacterSummary: host.toCharacterSummary,
			toCharacterSummaryMessage: host.toCharacterSummaryMessage,
			send: (socket, message) => broadcastHub.send(socket, message),
			sendFailure: (socket, id, command, reason) => broadcastHub.sendFailure(socket, id, command, reason),
			broadcast: (message) => broadcastHub.broadcast(message),
			broadcastGroupChatUpdate: () => broadcastHub.broadcastGroupChatUpdate(),
			onMembersChanged: () => host.readOnMembersChanged()?.(),
		},
		queryDeps: {
			state: host.state,
			publicMessages: host.publicMessages,
			sessionStore: host.sessionStore,
			getPersistedCount: () => host.persistedCount.get(),
			getGroupChatStateMessage: (requestingSessionId) => broadcastHub.getGroupChatStateMessage(requestingSessionId),
			send: (socket, message) => broadcastHub.send(socket, message),
			sendFailure: (socket, id, command, reason) => broadcastHub.sendFailure(socket, id, command, reason),
			broadcastGroupChatUpdate: () => broadcastHub.broadcastGroupChatUpdate(),
			onMembersChanged: () => host.readOnMembersChanged()?.(),
		},
		boardDeps: {
			state: host.state,
			boardStore: host.boardStore,
			send: (socket, message) => broadcastHub.send(socket, message),
			sendFailure: (socket, id, command, reason) => broadcastHub.sendFailure(socket, id, command, reason),
			broadcast: (message) => broadcastHub.broadcast(message),
		},
	};
}
