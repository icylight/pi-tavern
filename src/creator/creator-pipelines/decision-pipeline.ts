/**
 * #107（ADR-0006）：decision_declare 请求管线。
 *
 * 骨架与 submit-message 同构：校验（五项 + 配额）→ 持久化（JSONL 追加）→
 * 计数/状态更新 → 广播（group_chat_update 带快照）→ 响应。校验失败 =
 * 业务拒绝（accepted:false + 错误码），不消耗配额、不产生半状态。
 *
 * 双入口（与 submit-message 同模式）：角色经 WS runDeclare；User Persona
 * 经 declareAsUser（命令层/headless 调用，v1.1：User 关闭 = 最终决定）。
 */

import type WebSocket from "ws";

import {
	applyDeclaration,
	computeSnapshot,
	type DecisionDeclaration,
	type DecisionErrorCode,
	validateDeclaration,
} from "../../data/decision-store.js";
import type { DecisionRecordWire } from "../../protocol/messages.js";
import { DECLARE_PER_ROUND_LIMIT } from "../../shared/constants.js";

/** 决策状态访问面（组合根注入；单写者串行，跨消息状态经引用显式读写）。 */
export interface DecisionStoreAccess {
	/** 当前状态链（内存镜像，加载自 JSONL）。 */
	records: DecisionRecordWire[];
	/** 每角色每轮成功声明计数（键 = character_id；round 重置清空）。 */
	declareCounts: Map<string, number>;
	/**
	 * 校验通过后持久化完整状态链（含已应用替代关系，temp+rename 原子替换；
	 * 失败抛错 = 声明失败，无半状态、内存不变）。
	 */
	append: (records: DecisionRecordWire[]) => Promise<void>;
}

export interface DecisionPipelineDependencies {
	decisionStore: DecisionStoreAccess;
	/** 广播 group_chat_update（内部装配 decision_snapshot）。 */
	broadcastGroupChatUpdate: () => void;
	send: (socket: WebSocket, message: unknown) => void;
	now: () => Date;
	/** 发送者身份解析（组合根注入，与 submit-message 同源：在线角色表；仅角色形态）。 */
	resolveSender: (connection: { sessionId: string | null }) => {
		type: "character";
		character_id: string;
		name: string;
	} | null;
}

export interface DecisionPipelineResult {
	accepted: boolean;
	error_code?: DecisionErrorCode;
	error_message?: string;
}

/**
 * decision-declare 管线实例（一次协议消息 = 一个实例；依赖面由 runtime
 * 装配注入——与 SubmitMessagePipeline 同模式）。
 */
export class DecisionPipeline {
	constructor(private readonly deps: DecisionPipelineDependencies) {}

	/** 角色入口（WS）：发送者 = 组合根注入解析；配额按 sessionId 计数。 */
	async runDeclare(
		socket: WebSocket,
		connection: { sessionId: string | null },
		message: {
			id?: string;
			type: "decision_declare";
			decision_id: string;
			content: string;
			version: number;
			supersedes: string[];
			status?: "proposed" | "closed";
		},
	): Promise<void> {
		const sender = this.resolveSender(connection);
		if (!sender || connection.sessionId === null) {
			this.deps.send(socket, {
				id: message.id,
				type: "response",
				command: "decision_declare",
				success: false,
				error: "not joined",
			});
			return;
		}

		const count = this.deps.decisionStore.declareCounts.get(sender.character_id) ?? 0;
		let result: DecisionPipelineResult;
		try {
			result = await this.processCore(
				{
					decision_id: message.decision_id,
					version: message.version,
					content: message.content,
					supersedes: message.supersedes,
					status: message.status ?? "proposed",
					decided_by: sender,
					now: this.deps.now().toISOString(),
				},
				count,
			);
		} catch {
			throw new Error("decision state processing failed");
		}
		if (!result.accepted) {
			this.deps.send(socket, {
				id: message.id,
				type: "response",
				command: "decision_declare",
				success: true,
				data: {
					accepted: false,
					error_code: result.error_code,
					error_message: result.error_message,
				},
			});
			return;
		}

		this.deps.decisionStore.declareCounts.set(sender.character_id, count + 1);
		this.deps.send(socket, {
			id: message.id,
			type: "response",
			command: "decision_declare",
			success: true,
			data: {
				accepted: true,
				snapshot: computeSnapshot(this.deps.decisionStore.records),
			},
		});
	}

	/**
	 * User Persona 入口（命令层/headless，不走 WS）：v1.1「User 关闭 = 最终
	 * 决定」+「谁决定谁推翻」（替代 closed 目标须 User 关闭）。User 声明不
	 * 消耗角色配额（User 是最终权威，非角色）。
	 */
	async declareAsUser(decl: Omit<DecisionDeclaration, "decided_by" | "now">): Promise<DecisionPipelineResult> {
		const result = await this.processCore(
			{
				...decl,
				decided_by: { type: "user_persona" },
				now: this.deps.now().toISOString(),
			},
			Number.POSITIVE_INFINITY,
		);
		return result;
	}

	/** 发送者解析（组合根注入：在线角色表，与 submit-message 同源）。 */
	private resolveSender(connection: {
		sessionId: string | null;
	}): { type: "character"; character_id: string; name: string } | null {
		return this.deps.resolveSender(connection);
	}

	/**
	 * 核心：校验五项 + 配额 → 应用替代（内存计算新链）→ 持久化（原子，
	 * 磁盘 = 已应用替代关系的完整链）→ 内存镜像更新 → 广播。
	 * 校验失败或持久化失败 = 无任何状态副作用（失败不消耗配额、不污染链）。
	 */
	private async processCore(decl: DecisionDeclaration, count: number): Promise<DecisionPipelineResult> {
		const result = validateDeclaration(this.deps.decisionStore.records, decl, count, DECLARE_PER_ROUND_LIMIT);
		if (!result.ok) {
			return { accepted: false, error_code: result.code, error_message: result.message };
		}

		// F1：先应用替代（计算新链），磁盘写入的永远是含替代结果的完整链。
		const applied = applyDeclaration(this.deps.decisionStore.records, result.record);
		try {
			await this.deps.decisionStore.append(applied);
		} catch {
			throw new Error("decision state append failed");
		}

		this.deps.decisionStore.records = applied;
		this.deps.broadcastGroupChatUpdate();
		return { accepted: true };
	}
}
