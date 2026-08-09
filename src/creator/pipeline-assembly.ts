import type WebSocket from "ws";

import type { CharacterCard, CharacterSummary } from "../config/character-card.js";
import type { MessageTemplateKey } from "../config/message-templates.js";
import { renderTemplate } from "../config/message-templates.js";
import type { BoardStore } from "../data/board-store.js";
import type { GroupChatState } from "../data/group-chat-state.js";
import type { SessionStore } from "../data/session-store.js";
import type { PublicMessageState } from "../protocol/public-message-state.js";
import type { WhisperMessageState } from "../protocol/whisper-message-state.js";
import type { BroadcastHub } from "./broadcast-hub.js";
import type { ConnectionContext } from "./connection-manager.js";
import type { BoardPipeline, BoardPipelineDependencies } from "./creator-pipelines/board-pipeline.js";
import type { ClaimPipeline } from "./creator-pipelines/claim-pipeline.js";
import { JoinPipeline } from "./creator-pipelines/join-pipeline.js";
import { LeavePipeline } from "./creator-pipelines/leave-pipeline.js";
import { mergeMessageStreams } from "./creator-pipelines/message-stream.js";
import type { QueryPipeline } from "./creator-pipelines/query-pipeline.js";
import type { ReadyPipeline } from "./creator-pipelines/ready-pipeline.js";
import type { SubmitMessagePipeline } from "./creator-pipelines/submit-message-pipeline.js";
import type { WhisperPipeline } from "./creator-pipelines/whisper-message-pipeline.js";
import type { HeartbeatRegistry } from "./heartbeat-registry.js";
import type { MemberBookkeeping } from "./member-bookkeeping.js";

/** 管线装配访问的骨架窄接口（结构类型；模块不 import CreatorRuntime 类本身）。 */
interface PipelineAssemblyHost {
	state: GroupChatState;
	connections: Map<string, WebSocket>;
	heartbeatRegistry: HeartbeatRegistry;
	publicMessages: PublicMessageState[];
	/** #152：私信消息流（与公开共用递增器；恢复/查询合并）。 */
	whisperMessages: WhisperMessageState[];
	characters: ReadonlyMap<string, CharacterCard>;
	sessionStore: SessionStore;
	boardStore: BoardStore;
	/** #123：欢迎文案（ready 后 system_message 单播内容；配置链已合并，值传快照）。 */
	welcomeMessage: string;
	persistedCount: { get: () => number; add: (delta: number) => void };
	broadcastHub: BroadcastHub;
	memberBookkeeping: MemberBookkeeping;
	enqueue: <T>(operation: () => T | Promise<T>) => Promise<T>;
	/** 回调经 getter 读取（测试后期赋值仍生效——Arch ②「闭包捕获最终引用」同模式）。 */
	readOnPublicMessage: () => ((msg: PublicMessageState) => void) | undefined;
	readOnPublicMessageError: () => ((error: string, sequence: number, timestamp: string) => void) | undefined;
	/** #152（Arch 阻断修复）：私信提交钩子读取（getter 闭包，同 readOnPublicMessage 模式）。 */
	readOnWhisperMessage: () => ((msg: WhisperMessageState) => void) | undefined;
	/** #154/#152（P2 评审阻断 1）：模板集 getter（P3 五 key 合流后含 whisper_full；P2 独立期三 key 回退契约默认形态）。 */
	readMessageTemplates: () => Record<MessageTemplateKey, string> | undefined;
	readOnMembersChanged: () => (() => void) | undefined;
	/** 白板模型（#114）：creator 实时提示（纯展示，applied 广播触发）。 */
	readOnBoardUpdated: () => BoardPipelineDependencies["onBoardUpdated"];
	now: () => Date;
	toCharacterSummary: (character: CharacterCard) => CharacterSummary;
	toCharacterSummaryMessage: (character: CharacterSummary) => {
		character_id: string;
		name: string;
		description: string;
	};
}

interface PipelineAssembly {
	joinPipeline: JoinPipeline;
	leavePipeline: LeavePipeline;
	submitMessageDeps: ConstructorParameters<typeof SubmitMessagePipeline>[0];
	claimDeps: ConstructorParameters<typeof ClaimPipeline>[0];
	readyDeps: ConstructorParameters<typeof ReadyPipeline>[0];
	queryDeps: ConstructorParameters<typeof QueryPipeline>[0];
	boardDeps: ConstructorParameters<typeof BoardPipeline>[0];
	/** #152：whisper 管线依赖。 */
	whisperDeps: ConstructorParameters<typeof WhisperPipeline>[0];
}

/** 管线门面装配（PR-B 拆自 CreatorRuntime 构造器；跨消息状态经注入引用显式读写，决策 7）。 */
export function assemblePipelineDeps(host: PipelineAssemblyHost): PipelineAssembly {
	const { broadcastHub, memberBookkeeping } = host;
	return {
		joinPipeline: new JoinPipeline({
			connections: host.connections,
			getAvailableCharacters: () => memberBookkeeping.getAvailableCharacters(),
			toCharacterSummaryMessage: host.toCharacterSummaryMessage,
		}),
		leavePipeline: new LeavePipeline({
			removeOnlineCharacter: (connection, reason) =>
				memberBookkeeping.removeOnlineCharacter(connection as ConnectionContext, reason),
		}),
		submitMessageDeps: {
			state: host.state,
			publicMessages: host.publicMessages,
			whisperMessages: host.whisperMessages,
			persistedCount: host.persistedCount,
			sessionStore: host.sessionStore,
			broadcastGroupChatUpdate: () => broadcastHub.broadcastGroupChatUpdate(),
			onPublicMessage: (msg) => host.readOnPublicMessage()?.(msg),
			onPublicMessageError: (error, sequence, timestamp) =>
				host.readOnPublicMessageError()?.(error, sequence, timestamp),
		},
		claimDeps: {
			state: host.state,
			characters: host.characters,
			isCharacterAvailable: (characterId) => memberBookkeeping.isCharacterAvailable(characterId),
			startReadyTimer: (socket, connection) =>
				memberBookkeeping.startReadyTimer(socket, connection as ConnectionContext),
			toCharacterSummaryMessage: host.toCharacterSummaryMessage,
		},
		readyDeps: {
			state: host.state,
			connections: host.connections,
			heartbeatRegistry: host.heartbeatRegistry,
			characters: host.characters,
			welcomeMessage: host.welcomeMessage,
			clearReadyTimer: (connection) => memberBookkeeping.clearReadyTimer(connection as ConnectionContext),
			now: () => host.now(),
			toCharacterSummary: host.toCharacterSummary,
			toCharacterSummaryMessage: host.toCharacterSummaryMessage,
			send: (socket, message) => broadcastHub.send(socket, message),
			broadcast: (message) => broadcastHub.broadcast(message),
			onMembersChanged: () => host.readOnMembersChanged()?.(),
			/** #144 P1-4 方案 a：进入时刻水位 = 当前公开消息总数（与 group_chat_update 同源）。 */
			latestSequence: () => host.publicMessages.length,
		},
		queryDeps: {
			state: host.state,
			publicMessages: host.publicMessages,
			whisperMessages: host.whisperMessages,
			sessionStore: host.sessionStore,
			getPersistedCount: () => host.persistedCount.get(),
			getGroupChatStateMessage: (requestingSessionId) => broadcastHub.getGroupChatStateMessage(requestingSessionId),
			onMembersChanged: () => host.readOnMembersChanged()?.(),
		},
		boardDeps: {
			state: host.state,
			boardStore: host.boardStore,
			broadcast: (message) => broadcastHub.broadcast(message),
			onBoardUpdated: (update) => host.readOnBoardUpdated()?.(update),
		},
		whisperDeps: {
			state: host.state,
			publicMessages: host.publicMessages,
			whisperMessages: host.whisperMessages,
			persistedCount: host.persistedCount,
			sessionStore: host.sessionStore,
			// 合并流（public + whisper 按 sequence 归并）：stale 检查与查询投影同源。
			readMergedMessages: () => mergeMessageStreams(host.publicMessages, host.whisperMessages),
			connections: host.connections,
			send: (socket, message) => broadcastHub.send(socket, message),
			// P2 评审阻断 1：落盘顶层 content = 创建者视角完整投影（P1 契约）。
			// 有 whisper_full 模板（P3 合流）走模板渲染；否则回退契约默认形态（与
			// DEFAULT_TEMPLATES.whisper_full 同文案）——P2 独立合并期亦符合契约。
			formatWhisperContent: (sender, receiver, content) => {
				const templates = host.readMessageTemplates() as Record<string, string> | undefined;
				const whisperFull = templates?.whisper_full;
				if (whisperFull !== undefined) {
					return renderTemplate(whisperFull, { sender, receiver, content });
				}
				return `${sender} 向 ${receiver} 悄悄说：${content}`;
			},
			onWhisperMessage: (whisper) => host.readOnWhisperMessage()?.(whisper),
		},
	};
}
