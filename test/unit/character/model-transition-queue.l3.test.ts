import { describe, expect, it } from "vitest";
import {
	type ModelApplyOutcome,
	type ModelIdentity,
	type ModelTransitionExecutor,
	ModelTransitionQueue,
} from "../../../src/character/model-transition-queue.js";

/**
 * L3 尾单②「两侧统一删」钉——合并形态（统一删 4 钉 + E1 边界钉，单文件）。
 *
 * 来源（QA 探针，tmp/qa-l3-slots/）：
 * - 统一删 4 钉（原 qa-l3-unified-delete.pin.test.ts）：D1-D4 ≡ restore-slot P1/P2
 *   + lifecycle L1/L2，去重复后保留此规格化形态；
 * - E1（原 qa-l3-abandoned-boundary.pin.test.ts）：断言原文保留。
 *
 * 定稿方向：restore 槽位语义两侧统一为「删」——failed（未达标收尾）删；
 * abandoned（冻中断、接力链 barrier 还要读槽）留。依据（QA 实证）：
 * - 失败槽位无清理路径（跨 epoch 残留，Map 无按轮清理）；
 * - 无消费方（保留的槽位无后续读取者）。
 *
 * 未修树基线（main）：**2 红 3 绿**——
 * - D1 红：常规 runRestore 未达标 ⇒ 现状保留槽位（size=1）；目标删除（size=0）；
 * - D2 红：失败槽位 + 新 epoch capture ⇒ 现状残留（size=2）；目标无遗留（size=1）；
 * - D3 绿（保绿）：barrier 路径未达标 ⇒ 现状已删（size=0），统一后不得回退；
 * - D4 绿（保绿对照）：失败槽 + 同 epoch 再 capture ⇒ 覆盖不增长（修前修后均绿）；
 * - E1 绿（护栏）：冻中断不删槽（现状本不删），接力 barrier 读 target 应用 thinking 余量。
 *
 * L3 落地（常规路径补删 + 生命周期清理）后：5/5 绿。
 * E1 三态区分力：未修 main 绿 / 正确（failed 删）绿 / naive（无条件删）红——
 * naive 变体在原 8 钉 + B1 7 钉 + 队列主测 63/63 全绿；E1 是唯一识别者。
 * 约束：探针不改生产代码。
 */

const BASELINE: ModelIdentity = { provider: "anthropic", id: "haiku" };
const OTHER: ModelIdentity = { provider: "anthropic", id: "sonnet" };

interface Harness {
	executor: ModelTransitionExecutor;
	release(value: ModelApplyOutcome): void;
	setObserved(model: ModelIdentity | undefined): void;
	setThinking(level: string): void;
	appliedThinking: string[];
}

function createHarness(): Harness {
	let observed: ModelIdentity | undefined = { ...BASELINE };
	let thinking = "low";
	const appliedThinking: string[] = [];
	let pending: ((outcome: ModelApplyOutcome) => void) | undefined;
	let firstApply = true;
	return {
		executor: {
			getModelIdentity: () => observed,
			getThinkingLevel: () => thinking,
			resolveModel: (provider, id) => ({ provider, id }),
			applyModel: () => {
				if (!firstApply) {
					return Promise.resolve(true);
				}
				firstApply = false;
				// 接口回执 = boolean（§10 返回值层）；harness 以 ModelApplyOutcome
				// 形状 release，仅在此边界取 accepted（断言语义不变，类型对齐 tsc）。
				return new Promise<boolean>((resolve) => {
					pending = (outcome) => resolve(outcome.accepted);
				});
			},
			applyThinking: (level) => {
				appliedThinking.push(level);
				thinking = level;
			},
			notifyWarning: () => undefined,
		},
		release: (outcome) => pending?.(outcome),
		setObserved: (model) => {
			observed = model;
		},
		setThinking: (level) => {
			thinking = level;
		},
		appliedThinking,
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/** 制造「restore 在途」并失败（未达标）：挂起 applyModel → 释放失败回执 + 观测不变。 */
async function armFailingRestore(h: Harness, queue: ModelTransitionQueue, mode: "normal" | "barrier"): Promise<void> {
	h.setObserved(OTHER);
	queue.submitRestore(1);
	await tick();
	if (mode === "barrier") {
		queue.freeze();
		const next = ModelTransitionQueue.rehydrate(queue.snapshot(), h.executor);
		h.release({ accepted: false });
		await next.whenIdle();
		await tick();
	} else {
		h.release({ accepted: false });
		await queue.whenIdle();
		await tick();
	}
}

describe("L3 尾单②：两侧统一删（定稿方向红钉）", () => {
	it("D1（目标红）：常规 runRestore 未达标 → 槽位删除", async () => {
		const h = createHarness();
		const q = new ModelTransitionQueue(h.executor);
		q.submitCapture(1, { model: true, thinking: true });
		await q.whenIdle();

		await armFailingRestore(h, q, "normal");
		expect(q.snapshot().slots.size).toBe(0);
	});

	it("D2（目标红）：失败槽位 + 新 epoch capture → 无遗留", async () => {
		const h = createHarness();
		const q = new ModelTransitionQueue(h.executor);
		q.submitCapture(1, { model: true, thinking: true });
		await q.whenIdle();

		await armFailingRestore(h, q, "normal");
		q.submitCapture(2, { model: true, thinking: true });
		await q.whenIdle();
		await tick();

		const snapshot = q.snapshot();
		expect(snapshot.slots.size).toBe(1);
		expect([...snapshot.slots.keys()]).toEqual([2]);
	});

	it("D3（保绿）：barrier 路径未达标 → 槽位删除（不得回退）", async () => {
		const h = createHarness();
		const q = new ModelTransitionQueue(h.executor);
		q.submitCapture(1, { model: true, thinking: true });
		await q.whenIdle();

		h.setObserved(OTHER);
		q.submitRestore(1);
		await tick();
		q.freeze();
		const next = ModelTransitionQueue.rehydrate(q.snapshot(), h.executor);
		h.release({ accepted: false });
		await next.whenIdle();
		await tick();
		expect(next.snapshot().slots.size).toBe(0);
	});

	it("D4（保绿对照）：失败槽 + 同 epoch 再 capture → 覆盖不增长", async () => {
		const h = createHarness();
		const q = new ModelTransitionQueue(h.executor);
		q.submitCapture(1, { model: true, thinking: true });
		await q.whenIdle();

		await armFailingRestore(h, q, "normal");
		q.submitCapture(1, { model: true, thinking: true });
		await q.whenIdle();
		await tick();

		expect(q.snapshot().slots.size).toBe(1);
	});
});

describe("L3 尾单②边界钉：abandoned（冻中断）→ 槽位留给接力 barrier", () => {
	it("E1（护栏）：settle 先于 rehydrate → 冻中断不删槽，接力 barrier 完成 thinking", async () => {
		const h = createHarness();
		const q = new ModelTransitionQueue(h.executor);
		q.submitCapture(1, { model: true, thinking: true }); // 槽位 = haiku / low
		await q.whenIdle();

		// 双维漂移：model → sonnet，thinking → medium。
		h.setObserved(OTHER);
		h.setThinking("medium");

		q.submitRestore(1); // applyModel 挂起（在途）
		await tick();
		q.freeze();
		const snap = q.snapshot(); // inFlight 已捕获（settle 前）

		// setModel 在后台成功 settle；旧冻队列收尾（abandoned）。
		h.setObserved(BASELINE);
		h.release({ accepted: true });
		await tick(); // 排空微任务——naive 实现在此删槽，正确实现保留

		// 现在才重建接力队列（barrier 等到已 settle 的 promise）。
		const next = ModelTransitionQueue.rehydrate(snap, h.executor);
		await next.whenIdle();
		await tick();

		// 接力 barrier 读 target（haiku）→ thinking 余量已应用（{} = 提前删槽致丢失）。
		expect(h.appliedThinking).toEqual(["low"]);
		expect(next.snapshot().slots.size).toBe(0); // 收尾清槽仍发生
	});
});
