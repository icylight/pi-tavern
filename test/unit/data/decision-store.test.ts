import { describe, expect, it } from "vitest";
import {
	applyDeclaration,
	computeDeclareCountsForRound,
	computeSnapshot,
	type DecisionDeclaration,
	parseDecisionLine,
	validateDeclaration,
} from "../../../src/data/decision-store.js";
import type { DecisionRecordWire } from "../../../src/protocol/messages.js";

/**
 * #107 红测（unit 层，Arch 属主）：决策状态存储与机械校验纯函数。
 *
 * 契约（ADR-0006）：
 * - 校验五项：① 目标存在 ② 未被活跃替代（superseded 终态不可引用）
 *   ③ 版本单调（撞名 = 同 id 同版本/低版本拒绝）④ DAG 无环（P2→P1→P2 拒）
 *   ⑤ 权限对等（status=closed 仅提案人/User；supersedes 含 closed ⇒ 声明
 *   须 status=closed 且 decided_by=user_persona——「谁决定谁推翻」）。
 * - 配额：declareCount >= declareLimit 拒绝（成功才计次，调用方计数）。
 * - 应用：被替代目标置 superseded（历史保留可追溯）；新记录入链。
 * - 快照：current = 链末端 closed（无则 null）；active = 非 superseded 全集。
 * - 解析：坏行/空行容忍（与消息流恢复同语义）。
 */

const USER = { type: "user_persona" } as const;
function char(id: string): DecisionRecordWire["decided_by"] {
	return { type: "character", character_id: id, name: id };
}

function aRecord(over: Partial<DecisionRecordWire> = {}): DecisionRecordWire {
	return {
		decision_id: "D1",
		version: 1,
		content: "决策内容",
		status: "proposed",
		supersedes: [],
		decided_by: char("dev"),
		created_at: "2026-08-01T00:00:00.000Z",
		updated_at: "2026-08-01T00:00:00.000Z",
		...over,
	};
}

function aDecl(over: Partial<DecisionDeclaration> = {}): DecisionDeclaration {
	return {
		decision_id: "D2",
		version: 1,
		content: "新提案",
		supersedes: [],
		status: "proposed",
		decided_by: char("arch"),
		now: "2026-08-01T00:00:00.000Z",
		...over,
	};
}

describe("#107 validateDeclaration: 校验五项", () => {
	it("① 目标存在：supersedes 引用不存在 → target_missing", () => {
		const result = validateDeclaration([aRecord()], aDecl({ supersedes: ["NOPE@v1"] }), 0, 3);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("target_missing");
	});

	it("② 未被活跃替代：supersedes 引用已 superseded 记录 → 拒绝", () => {
		const records = [aRecord({ status: "superseded" }), aRecord({ decision_id: "D2", status: "proposed" })];
		const result = validateDeclaration(records, aDecl({ decision_id: "D3", supersedes: ["D1@v1"] }), 0, 3);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("cycle_rejected");
	});

	it("③ 版本单调：同 id 已占用（撞名/低版本）→ version_not_monotonic", () => {
		const records = [aRecord()]; // D1@v1 已存在
		const result = validateDeclaration(records, aDecl({ decision_id: "D1", version: 1 }), 0, 3);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("version_not_monotonic");
	});

	it("③ 版本单调：同 id 新版本必须严格递增（v2 可、v1 不可）", () => {
		const records = [aRecord()];
		expect(validateDeclaration(records, aDecl({ decision_id: "D1", version: 2 }), 0, 3).ok).toBe(true);
	});

	it("④ DAG 无环：记录间互指成环，新声明指向环中节点 → cycle_rejected", () => {
		// 已持久化记录互指成环：P1 supersedes P2@v1，P2 supersedes P1@v1。
		const p1 = aRecord({ decision_id: "P1", version: 1, supersedes: ["P2@v1"] });
		const p2 = aRecord({ decision_id: "P2", version: 1, supersedes: ["P1@v1"] });
		const records = [p1, p2];
		// P3 声明 supersedes P2@v1——沿 P2 → P1 → P2 链发现 visited 重复 → 拒。
		const result = validateDeclaration(records, aDecl({ decision_id: "P3", supersedes: ["P2@v1"] }), 0, 3);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("cycle_rejected");
	});

	it("④ 无环链正常通过（P3 替代 P2，P2 替代 P1，单一直线）", () => {
		const p1 = aRecord({ decision_id: "P1", version: 1 });
		const p2 = aRecord({ decision_id: "P2", version: 1, supersedes: ["P1@v1"] });
		const records = [p1, p2];
		const result = validateDeclaration(records, aDecl({ decision_id: "P3", supersedes: ["P2@v1"] }), 0, 3);
		expect(result.ok).toBe(true);
	});

	it("G1：supersedes 缺省（undefined）不崩溃——空数组语义（二轮审查 P0-1）", () => {
		// 合法 wire 客户端可省略 supersedes；校验/应用层防御性归一（?? []）。
		const decl = { ...aDecl(), supersedes: undefined } as unknown as DecisionDeclaration;
		const result = validateDeclaration([], decl, 0, 3);
		expect(result.ok).toBe(true);
	});

	it("⑤ 权限对等：status=closed 仅提案人本人或 User（他人 → permission_denied）", () => {
		const records = [aRecord({ decided_by: char("dev") })];
		// arch 关 dev 的提案 → 拒绝
		const result = validateDeclaration(records, aDecl({ decision_id: "D1", version: 2, status: "closed" }), 0, 3);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("permission_denied");
		// 提案人本人关闭 → 成功
		const ok = validateDeclaration(
			records,
			aDecl({ decision_id: "D1", version: 2, status: "closed", decided_by: char("dev") }),
			0,
			3,
		);
		expect(ok.ok).toBe(true);
		// User 关闭 → 成功（override）
		const userOk = validateDeclaration(
			records,
			aDecl({ decision_id: "D1", version: 2, status: "closed", decided_by: USER }),
			0,
			3,
		);
		expect(userOk.ok).toBe(true);
	});

	it("G5：关闭权限绑定被关闭版本——A(v1) 不能关 B 的 v2（find 首条缺陷）", () => {
		const v1 = aRecord({ decision_id: "D1", version: 1, decided_by: char("a") });
		const v2 = aRecord({ decision_id: "D1", version: 2, decided_by: char("b") });
		const records = [v1, v2];
		// A 尝试关闭 D1@v3（同 id 最新版本声明者 = B）→ 拒绝（权限绑定最新版本）。
		const asA = validateDeclaration(
			records,
			aDecl({ decision_id: "D1", version: 3, status: "closed", decided_by: char("a") }),
			0,
			3,
		);
		expect(asA.ok).toBe(false);
		if (!asA.ok) expect(asA.code).toBe("permission_denied");
		// B 关闭自己的 D1@v3 → 成功（v3 声明者 = 最新版本声明者）。
		const asB = validateDeclaration(
			records,
			aDecl({ decision_id: "D1", version: 3, status: "closed", decided_by: char("b") }),
			0,
			3,
		);
		expect(asB.ok).toBe(true);
		// User 关闭 → 成功（override）。
		const asUser = validateDeclaration(
			records,
			aDecl({ decision_id: "D1", version: 3, status: "closed", decided_by: USER }),
			0,
			3,
		);
		expect(asUser.ok).toBe(true);
	});

	it("⑤ 权限对等：替代 closed 目标须 User 关闭的新提案（普通角色 → target_closed_denied）", () => {
		const records = [aRecord({ status: "closed", decided_by: USER })];
		const asChar = validateDeclaration(records, aDecl({ decision_id: "D2", supersedes: ["D1@v1"] }), 0, 3);
		expect(asChar.ok).toBe(false);
		if (!asChar.ok) expect(asChar.code).toBe("target_closed_denied");
		const asUser = validateDeclaration(
			records,
			aDecl({ decision_id: "D2", supersedes: ["D1@v1"], status: "closed", decided_by: USER }),
			0,
			3,
		);
		expect(asUser.ok).toBe(true);
	});

	it("同 id 隐式替代 closed 也必须由 User 以 closed 新版本执行", () => {
		const records = [aRecord({ status: "closed", decided_by: USER })];
		const bypass = validateDeclaration(
			records,
			aDecl({ decision_id: "D1", version: 2, status: "proposed", decided_by: char("dev") }),
			0,
			3,
		);
		expect(bypass.ok).toBe(false);
		if (!bypass.ok) expect(bypass.code).toBe("target_closed_denied");
	});

	it("活跃数到上限时仍允许等量替代，但拒绝新增第 17 条", () => {
		const records = Array.from({ length: 16 }, (_, index) => aRecord({ decision_id: `D${index + 1}`, version: 1 }));
		expect(
			validateDeclaration(records, aDecl({ decision_id: "D1", version: 2, decided_by: char("dev") }), 0, 3).ok,
		).toBe(true);
		const extra = validateDeclaration(records, aDecl({ decision_id: "D17" }), 0, 3);
		expect(extra.ok).toBe(false);
		if (!extra.ok) expect(extra.code).toBe("active_limit_reached");
	});

	it("content 上限按 UTF-8 字节而非 UTF-16 字符计数", () => {
		const result = validateDeclaration([], aDecl({ content: "你".repeat(30_000) }), 0, 3);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("invalid_declaration");
	});

	it("配额：declareCount ≥ limit → quota_exceeded；未达 → 通过（成功才计次）", () => {
		expect(validateDeclaration([], aDecl(), 3, 3).ok).toBe(false);
		if (!validateDeclaration([], aDecl(), 3, 3).ok) {
			const r = validateDeclaration([], aDecl(), 3, 3);
			if (!r.ok) expect(r.code).toBe("quota_exceeded");
		}
		expect(validateDeclaration([], aDecl(), 2, 3).ok).toBe(true);
	});

	it("配额：limit=Infinity（User 声明）不限额——count 任意值均通过（QA 集成层暴露，#107）", () => {
		// declareAsUser 不消耗角色配额（User = 最终权威）：count 传 Infinity 而
		// limit=DECLARE_PER_ROUND_LIMIT（有限）——配额检查须对 count 判 Infinity
		// 豁免（此前 Infinity>=3 误判拒绝；检查方向 = count 而非 limit）。
		expect(validateDeclaration([], aDecl(), Number.POSITIVE_INFINITY, 3).ok).toBe(true);
		expect(validateDeclaration([], aDecl(), 0, Number.POSITIVE_INFINITY).ok).toBe(true);
	});

	it("正常声明（proposed）→ ok + 记录字段完整", () => {
		const result = validateDeclaration([], aDecl(), 0, 3);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.record.status).toBe("proposed");
			expect(result.record.decision_id).toBe("D2");
			expect(result.record.version).toBe(1);
		}
	});
});

describe("#107 applyDeclaration: 状态链应用", () => {
	it("被替代目标置 superseded（历史保留），新记录入链", () => {
		const d1 = aRecord();
		const d2 = aRecord({ decision_id: "D2", supersedes: ["D1@v1"], status: "closed", decided_by: USER });
		const chain = applyDeclaration([d1], d2);
		expect(chain).toHaveLength(2);
		expect(chain[0]?.status).toBe("superseded");
		expect(chain[1]?.status).toBe("closed");
	});

	it("G4：同 id 新版本隐式淘汰旧版本（closed v2 无 supersedes 也淘汰 v1）", () => {
		const v1 = aRecord({ decision_id: "D1", version: 1 }); // D1@v1 proposed
		const v2 = aRecord({ decision_id: "D1", version: 2, status: "closed", decided_by: USER });
		const chain = applyDeclaration([v1], v2);
		expect(chain[0]?.status).toBe("superseded"); // v1 自动淘汰
		expect(chain[1]?.status).toBe("closed");
	});

	it("G4：proposed v2 也隐式淘汰 v1（非仅 closed——二轮审查细化）", () => {
		const v1 = aRecord({ decision_id: "D1", version: 1 });
		const v2 = aRecord({ decision_id: "D1", version: 2 }); // proposed
		const chain = applyDeclaration([v1], v2);
		expect(chain[0]?.status).toBe("superseded");
		expect(chain[1]?.status).toBe("proposed");
	});

	it("多目标替代：全部命中目标置 superseded", () => {
		const d1 = aRecord();
		const d2 = aRecord({ decision_id: "D2" });
		const d3 = aRecord({ decision_id: "D3", supersedes: ["D1@v1", "D2@v1"] });
		const chain = applyDeclaration([d1, d2], d3);
		expect(chain[0]?.status).toBe("superseded");
		expect(chain[1]?.status).toBe("superseded");
		expect(chain[2]?.status).toBe("proposed");
	});
});

describe("#107 computeSnapshot: 快照归约（唯一归约点）", () => {
	it("无 closed → current=null；active = 非 superseded 全集", () => {
		const records = [aRecord(), aRecord({ decision_id: "D2" }), aRecord({ decision_id: "D3", status: "superseded" })];
		const snap = computeSnapshot(records);
		expect(snap.current).toBeNull();
		expect(snap.active).toHaveLength(2);
	});

	it("current = 链末端 closed（最后声明的 closed 记录）", () => {
		const records = [
			aRecord({ status: "closed", decided_by: USER }),
			aRecord({ decision_id: "D2", status: "closed", decided_by: USER }),
		];
		const snap = computeSnapshot(records);
		expect(snap.current?.decision_id).toBe("D2");
	});

	it("superseded 记录不出现在 active 中", () => {
		const records = [
			aRecord({ status: "closed", decided_by: USER }),
			aRecord({ decision_id: "D2", status: "superseded" }),
		];
		const snap = computeSnapshot(records);
		expect(snap.active.some((r) => r.status === "superseded")).toBe(false);
	});
});

describe("#107 resume quota projection", () => {
	it("只统计当前讨论轮次内各 Character 的成功声明", () => {
		const records = [
			aRecord({ created_at: "2026-08-01T00:00:00.000Z", decided_by: char("dev") }),
			aRecord({ decision_id: "D2", created_at: "2026-08-02T00:00:00.000Z", decided_by: char("dev") }),
			aRecord({ decision_id: "D3", created_at: "2026-08-02T01:00:00.000Z", decided_by: char("qa") }),
			aRecord({ decision_id: "D4", created_at: "2026-08-02T02:00:00.000Z", decided_by: USER }),
		];
		const counts = computeDeclareCountsForRound(records, "2026-08-02T00:00:00.000Z");
		expect([...counts]).toEqual([
			["dev", 1],
			["qa", 1],
		]);
	});
});

describe("#107 parseDecisionLine: 坏行容忍", () => {
	it("空行/损坏行 → null（不抛）", () => {
		expect(parseDecisionLine("")).toBeNull();
		expect(parseDecisionLine("   ")).toBeNull();
		expect(parseDecisionLine("{not json")).toBeNull();
		expect(parseDecisionLine('{"decision_id": 1}')).toBeNull();
	});

	it("合法行 → 记录", () => {
		const line = JSON.stringify(aRecord());
		const parsed = parseDecisionLine(line);
		expect(parsed?.decision_id).toBe("D1");
		expect(parsed?.status).toBe("proposed");
	});
});
