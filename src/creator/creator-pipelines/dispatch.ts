import type WebSocket from "ws";

import type { ClientMessage } from "../../protocol/messages.js";
import type { ConnectionContext } from "../connection-manager.js";
import { ClaimPipeline } from "./claim-pipeline.js";
import { DecisionPipeline } from "./decision-pipeline.js";
import type { JoinPipeline } from "./join-pipeline.js";
import type { LeavePipeline } from "./leave-pipeline.js";
import { QueryPipeline } from "./query-pipeline.js";
import { ReadyPipeline } from "./ready-pipeline.js";
import { SubmitMessagePipeline } from "./submit-message-pipeline.js";

/** 分发依赖面（runtime 装配注入的管线门面）。 */
export interface DispatchDependencies {
	joinPipeline: JoinPipeline;
	leavePipeline: LeavePipeline;
	submitMessageDeps: ConstructorParameters<typeof SubmitMessagePipeline>[0];
	claimDeps: ConstructorParameters<typeof ClaimPipeline>[0];
	readyDeps: ConstructorParameters<typeof ReadyPipeline>[0];
	queryDeps: ConstructorParameters<typeof QueryPipeline>[0];
	decisionDeps: ConstructorParameters<typeof DecisionPipeline>[0];
}

/** 客户端消息分发（PR-B 拆自 CreatorRuntime；管线门面装配）。 */
export async function dispatchClientMessage(
	deps: DispatchDependencies,
	socket: WebSocket,
	connection: ConnectionContext,
	message: ClientMessage,
): Promise<void> {
	switch (message.type) {
		case "join_group_chat":
			deps.joinPipeline.run(socket, connection, message);
			return;
		case "claim_character":
			new ClaimPipeline(deps.claimDeps).run(socket, connection, message);
			return;
		case "character_ready":
			new ReadyPipeline(deps.readyDeps).run(socket, connection, message);
			return;
		case "get_group_chat_state":
			new QueryPipeline(deps.queryDeps).runGetGroupChatState(socket, connection, message);
			return;
		case "get_message_history":
			new QueryPipeline(deps.queryDeps).runGetMessageHistory(socket, connection, message);
			return;
		case "fetch_messages_since":
			new QueryPipeline(deps.queryDeps).runFetchMessagesSince(socket, connection, message);
			return;
		case "get_chat_history_file":
			new QueryPipeline(deps.queryDeps).runGetChatHistoryFile(socket, connection, message);
			return;
		case "update_character_state":
			new QueryPipeline(deps.queryDeps).runUpdateCharacterState(connection, message.is_streaming);
			return;
		case "leave_group_chat":
			deps.leavePipeline.run(socket, connection, message);
			return;
		case "speak":
			// 请求级管线实例（ADR：一次协议消息 = 一个管线实例；依赖面由 runtime 装配注入）
			await new SubmitMessagePipeline(deps.submitMessageDeps).runSpeak(socket, connection, message);
			return;
		case "decision_declare":
			await new DecisionPipeline(deps.decisionDeps).runDeclare(socket, connection, {
				...message,
				supersedes: message.supersedes ?? [],
			});
			return;
	}
}
