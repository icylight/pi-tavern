/**
 * #107（ADR-0006）：决策状态存储与机械校验。
 *
 * - 状态链与消息流零耦合（独立命名空间 decision_id，O(1) 校验）；
 * - 单写者（Creator）串行追加 JSONL；版本不可变（id@version → content 一对一）；
 * - 校验五项 + 权限对等全部为纯函数（非 LLM）；
 * - 角色不自行归约——快照归约（当前决定/活跃集）只在此处机械计算。
 */

import type { DecisionRecordWire, DecisionSnapshotWire } from "../protocol/messages.js";

/** 业务拒绝错误码（与 stale/round_limit_reached 同风格——业务拒绝而非协议错误）。 */
export type DecisionErrorCode =
	| "target_missing"
	| "target_closed_denied"
	| "cycle_rejected"
	| "version_not_monotonic"
	| "permission_denied"
	| "quota_exceeded";

export interface DecisionDeclaration {
	decision_id: string;
	version: number;
	content: string;
	supersedes: string[];
	/** 缺省 = proposed（管线/调用方可不传）。 */
	status?: "proposed" | "closed";
	decided_by: DecisionRecordWire["decided_by"];
	now: string;
}

export type DeclarationResult =
	| { ok: true; record: DecisionRecordWire }
	| { ok: false; code: DecisionErrorCode; message: string };

/** 校验五项 + 权限对等（Creator 机械执行，纯函数）。 */
export function validateDeclaration(
	records: readonly DecisionRecordWire[],
	decl: DecisionDeclaration,
	declareCount: number,
	declareLimit: number,
): DeclarationResult {
	const status = decl.status ?? "proposed";
	// ⑤ 权限对等：status=closed 声明须由 User Persona 或提案人本人发起
	// （v1.1：提案人关闭 + User override——谁提谁结、防他人改裁）。
	if (status === "closed") {
		const proposer = records.filter((r) => r.decision_id === decl.decision_id).find((r) => r.status !== "superseded");
		const isUser = decl.decided_by.type === "user_persona";
		const isProposer =
			!isUser &&
			proposer?.decided_by.type === "character" &&
			decl.decided_by.type === "character" &&
			proposer.decided_by.character_id === decl.decided_by.character_id;
		if (!isUser && !isProposer) {
			return { ok: false, code: "permission_denied", message: "status=closed 仅提案人本人或 User Persona 可声明" };
		}
	}

	// ③ 版本单调 + ② id 占用：同 id 已存在记录时，新版本必须严格递增
	// （撞名 = 同 id 同版本重复声明，版本不可变）。
	const sameId = records.filter((r) => r.decision_id === decl.decision_id);
	if (sameId.length > 0) {
		const maxVersion = Math.max(...sameId.map((r) => r.version));
		if (decl.version <= maxVersion) {
			return {
				ok: false,
				code: "version_not_monotonic",
				message: `decision_id=${decl.decision_id} 已占用至 v${maxVersion}，新声明版本必须 > ${maxVersion}`,
			};
		}
	}

	// ① 目标存在 + ② 未被活跃替代（superseded 终态不可引用）+ ④ DAG 无环。
	// 路径压缩查环：沿 supersedes 链向上（目标 → 目标的目标），若链中
	// 出现被替代记录自己的 id@version 则成环（P2→P1→P2 拒绝）。
	for (const target of decl.supersedes) {
		const targetRecord = records.find((r) => `${r.decision_id}@v${r.version}` === target);
		if (!targetRecord) {
			return { ok: false, code: "target_missing", message: `supersedes 目标不存在：${target}` };
		}
		if (targetRecord.status === "superseded") {
			return { ok: false, code: "cycle_rejected", message: `supersedes 目标已被替代（终态不可引用）：${target}` };
		}
		// ⑤ 权限对等：目标为 closed 时，新声明必须 status=closed 且由 User 关闭
		// （「谁决定谁推翻」——普通角色不能替代已决定提案）。
		if (targetRecord.status === "closed" && (decl.status !== "closed" || decl.decided_by.type !== "user_persona")) {
			return {
				ok: false,
				code: "target_closed_denied",
				message: `目标 ${target} 已决定——仅 User 关闭的新提案可替代`,
			};
		}
		// 环检测：从目标沿 supersedes 链向上查，若链中出现本声明的 id@version 则成环。
		const selfKey = `${decl.decision_id}@v${decl.version}`;
		const visited = new Set<string>([target]);
		let cursor = targetRecord;
		while (cursor.supersedes.length > 0) {
			const parent = records.find((r) => `${r.decision_id}@v${r.version}` === cursor.supersedes[0]);
			if (!parent) {
				break;
			}
			const parentKey = `${parent.decision_id}@v${parent.version}`;
			if (visited.has(parentKey)) {
				return { ok: false, code: "cycle_rejected", message: "supersedes 替代链成环" };
			}
			if (parentKey === selfKey) {
				return { ok: false, code: "cycle_rejected", message: `替代链循环（${selfKey} 出现在链中）` };
			}
			visited.add(parentKey);
			cursor = parent;
		}
	}

	// 配额：成功才计次（失败不消耗，由调用方在成功后计数）。
	// User 入口（declareAsUser）传非有限 count = 不检查配额（User 是最终权威，非角色）。
	if (Number.isFinite(declareCount) && declareCount >= declareLimit) {
		return { ok: false, code: "quota_exceeded", message: `每轮成功声明上限 ${declareLimit} 次已用尽` };
	}

	return {
		ok: true,
		record: {
			decision_id: decl.decision_id,
			version: decl.version,
			content: decl.content,
			status,
			supersedes: decl.supersedes,
			decided_by: decl.decided_by,
			created_at: decl.now,
			updated_at: decl.now,
		},
	};
}

/**
 * 应用声明到状态链（不可变返回新数组）：
 * - 新记录入链；
 * - 被替代目标（supersedes 命中的记录）置 superseded（历史保留，可追溯）。
 */
export function applyDeclaration(
	records: readonly DecisionRecordWire[],
	record: DecisionRecordWire,
): DecisionRecordWire[] {
	const updated = records.map((r) =>
		record.supersedes.some((t) => `${r.decision_id}@v${r.version}` === t)
			? { ...r, status: "superseded" as const, updated_at: record.updated_at }
			: r,
	);
	return [...updated, record];
}

/**
 * 快照归约（唯一归约点——角色不自行 fold）：
 * - current = 链末端的 closed 记录（无 closed 时为 null）；
 * - active = 未 superseded 的完整记录集（截断在渲染端）。
 */
export function computeSnapshot(records: readonly DecisionRecordWire[]): DecisionSnapshotWire {
	const active = records.filter((r) => r.status !== "superseded");
	const closed = active.filter((r) => r.status === "closed");
	const last = closed[closed.length - 1];
	const current: DecisionSnapshotWire["current"] = last ?? null;
	return { current, active };
}

/** 解析 decision JSONL 行（容忍空行/损坏行跳过——与消息流恢复同语义）。 */
export function parseDecisionLine(line: string): DecisionRecordWire | null {
	if (!line.trim()) {
		return null;
	}
	try {
		const parsed = JSON.parse(line) as DecisionRecordWire;
		// F9：完整校验（版本整数/状态枚举/supersedes 元素形态/decided_by 具体形态/时间戳）。
		if (typeof parsed.decision_id !== "string" || parsed.decision_id.length === 0) {
			return null;
		}
		if (!Number.isSafeInteger(parsed.version) || parsed.version < 1) {
			return null;
		}
		if (typeof parsed.content !== "string") {
			return null;
		}
		if (!["proposed", "superseded", "closed"].includes(parsed.status)) {
			return null;
		}
		if (!Array.isArray(parsed.supersedes) || parsed.supersedes.some((t) => typeof t !== "string")) {
			return null;
		}
		const db = parsed.decided_by as DecisionRecordWire["decided_by"] | undefined;
		if (db?.type === "user_persona") {
			// 通过。
		} else if (db?.type === "character" && typeof db.character_id === "string" && typeof db.name === "string") {
			// 通过。
		} else {
			return null;
		}
		if (typeof parsed.created_at !== "string" || typeof parsed.updated_at !== "string") {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}
