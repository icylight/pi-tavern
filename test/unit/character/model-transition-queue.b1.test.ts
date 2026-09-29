import { describe, expect, it } from "vitest";
import {
	type ModelIdentity,
	type ModelTransitionExecutor,
	ModelTransitionQueue,
} from "../../../src/character/model-transition-queue.js";

/**
 * L2 B1（二次 reload 落在 barrier 窗口内）——QA 独立复核钉。
 *
 * 形态来源：
 * - T1 = owner 探针 v1（离开的 restore 被吞：收尾停在 sonnet/high）
 * - T2 = owner 探针 v2（并发峰值 2）
 * - T3 = QA 对抗组（已冻队列的 barrier 仍写 remaining）
 * - T4/T5 = owner seq166 采纳的「恰好一次」保绿钉
 * - AD1/AD2 = QA 复核对抗组（3 跳接力 / 首跳排队 restore + 3 跳；scratch qa-l2-b1v2 落盘）
 *
 * 期望：T1/T2/T3 在未修树 = 红；修复（接力保留 inFlight + runBarrier frozen 判定）后全绿。
 * T4/T5 为保绿钉（防修复引入重复应用）；AD1/AD2 覆盖多跳接力链。
 */

const BASELINE: ModelIdentity = { provider: "anthropic", id: "haiku" };

interface Harness {
	executor: ModelTransitionExecutor;
	/** 释放第一笔 applyModel 的挂起（settle 前场景）；applyBeforeSettle=true 时先生效再挂起。 */
	release(): void;
	state(): {
		model: ModelIdentity;
		thinking: string;
		applyModelCalls: number;
		applyThinkingCalls: number;
		peakConcurrent: number;
		warnings: string[];
	};
}

/** 挂起第一笔 applyModel 的执行器（可配「先生效后挂起」= v2 形态）。 */
function createHarness(options: { applyBeforeSettle?: boolean } = {}): Harness {
	let model: ModelIdentity = { ...BASELINE };
	let thinking = "low";
	let concurrent = 0;
	let peak = 0;
	let applyModelCalls = 0;
	let applyThinkingCalls = 0;
	const warnings: string[] = [];
	let releaseGate = () => {};
	const gate = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});

	return {
		executor: {
			getModelIdentity: () => model,
			getThinkingLevel: () => thinking,
			resolveModel: (provider, id) => ({ provider, id }),
			applyModel: async (resolved) => {
				applyModelCalls += 1;
				const isFirst = applyModelCalls === 1;
				concurrent += 1;
				peak = Math.max(peak, concurrent);
				const target = resolved as ModelIdentity;
				if (options.applyBeforeSettle === true && isFirst) {
					model = { provider: target.provider, id: target.id };
				}
				if (isFirst) {
					await gate;
				}
				if (options.applyBeforeSettle !== true) {
					model = { provider: target.provider, id: target.id };
				}
				concurrent -= 1;
				return true;
			},
			applyThinking: (level) => {
				applyThinkingCalls += 1;
				thinking = level;
			},
			notifyWarning: (message) => {
				warnings.push(message);
			},
		},
		release: () => releaseGate(),
		state: () => ({ model, thinking, applyModelCalls, applyThinkingCalls, peakConcurrent: peak, warnings }),
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("#203 无关 · L2 B1 复核钉", () => {
	it("T1：二次 reload 期间离开的 restore → 收尾必须回到基线", async () => {
		const h = createHarness();
		const q1 = new ModelTransitionQueue(h.executor);
		q1.submitCapture(1, { model: true, thinking: true });
		await q1.whenIdle();
		q1.submitSwitch(1, { model: "anthropic/sonnet", thinking: "high" });
		await tick();

		// reload#1：freeze → snapshot → A（持 barrier）
		q1.freeze();
		const A = ModelTransitionQueue.rehydrate(q1.snapshot(), h.executor);
		// 离开群聊：restore 排队
		A.submitRestore(1);
		// reload#2：freeze A → snapshot → B
		A.freeze();
		const B = ModelTransitionQueue.rehydrate(A.snapshot(), h.executor);

		h.release();
		await B.whenIdle();
		await tick();

		const s = h.state();
		expect(s.model).toEqual(BASELINE);
		expect(s.thinking).toBe("low");
	});

	it("T2：二次 reload 窗口内 → 并发写峰值 ≤ 1（单飞不破）", async () => {
		const h = createHarness({ applyBeforeSettle: true });
		const q1 = new ModelTransitionQueue(h.executor);
		q1.submitCapture(1, { model: true, thinking: true });
		await q1.whenIdle();
		q1.submitSwitch(1, { model: "anthropic/sonnet", thinking: "high" });
		await tick();

		q1.freeze();
		const A = ModelTransitionQueue.rehydrate(q1.snapshot(), h.executor);
		A.submitRestore(1);
		A.freeze();
		const B = ModelTransitionQueue.rehydrate(A.snapshot(), h.executor);

		h.release();
		await B.whenIdle();
		await tick();

		expect(h.state().peakConcurrent).toBeLessThanOrEqual(1);
	});

	it("T3：已冻队列（无接力者）不得写 remaining", async () => {
		const h = createHarness();
		const q1 = new ModelTransitionQueue(h.executor);
		q1.submitCapture(1, { model: true, thinking: true });
		await q1.whenIdle();
		q1.submitSwitch(1, { model: "anthropic/sonnet", thinking: "high" });
		await tick();

		q1.freeze();
		const A = ModelTransitionQueue.rehydrate(q1.snapshot(), h.executor);
		A.freeze(); // 二次 handoff 前冻结；无接力者

		h.release();
		await A.whenIdle();
		await tick();

		// 冻队列不执行剩余部分：thinking 不得被写成 high。
		expect(h.state().thinking).toBe("low");
	});

	it("T4：冻队列完成 + 有接力者 → remaining 恰好应用一次", async () => {
		const h = createHarness();
		const q1 = new ModelTransitionQueue(h.executor);
		q1.submitCapture(1, { model: true, thinking: true });
		await q1.whenIdle();
		q1.submitSwitch(1, { model: "anthropic/sonnet", thinking: "high" });
		await tick();

		q1.freeze();
		const A = ModelTransitionQueue.rehydrate(q1.snapshot(), h.executor);
		A.freeze();
		const B = ModelTransitionQueue.rehydrate(A.snapshot(), h.executor);

		h.release();
		await B.whenIdle();
		await tick();

		const s = h.state();
		expect(s.applyThinkingCalls).toBe(1);
		expect(s.thinking).toBe("high");
	});

	it("T5：freeze / settle 两种交错 → 应用计数恒为 1", async () => {
		// 交错 a：先 freeze 后 settle
		{
			const h = createHarness();
			const q1 = new ModelTransitionQueue(h.executor);
			q1.submitCapture(1, { model: true, thinking: true });
			await q1.whenIdle();
			q1.submitSwitch(1, { model: "anthropic/sonnet", thinking: "high" });
			await tick();
			q1.freeze();
			const A = ModelTransitionQueue.rehydrate(q1.snapshot(), h.executor);
			A.freeze();
			const B = ModelTransitionQueue.rehydrate(A.snapshot(), h.executor);
			h.release();
			await B.whenIdle();
			await tick();
			expect(h.state().applyThinkingCalls).toBe(1);
		}
		// 交错 b：先 settle 后 freeze（剩余部分由未冻的接力者承担）
		{
			const h = createHarness();
			const q1 = new ModelTransitionQueue(h.executor);
			q1.submitCapture(1, { model: true, thinking: true });
			await q1.whenIdle();
			q1.submitSwitch(1, { model: "anthropic/sonnet", thinking: "high" });
			await tick();
			q1.freeze();
			const A = ModelTransitionQueue.rehydrate(q1.snapshot(), h.executor);
			h.release();
			await tick();
			A.freeze();
			const B = ModelTransitionQueue.rehydrate(A.snapshot(), h.executor);
			await B.whenIdle();
			await tick();
			expect(h.state().applyThinkingCalls).toBe(1);
		}
	});

	// ── QA 对抗组（AD1/AD2）：3 跳接力链————超出 T1–T5 的覆盖面 ──
	it("AD1：3 跳接力（q1→A→B→C）→ remaining 恰好一次、收尾 sonnet/high、峰值 ≤1", async () => {
		const h = createHarness();
		const q1 = new ModelTransitionQueue(h.executor);
		q1.submitCapture(1, { model: true, thinking: true });
		await q1.whenIdle();
		q1.submitSwitch(1, { model: "anthropic/sonnet", thinking: "high" });
		await tick();

		// 三连跳：每次 freeze→snapshot→rehydrate，均在第一个 apply 挂起期间。
		q1.freeze();
		const A = ModelTransitionQueue.rehydrate(q1.snapshot(), h.executor);
		A.freeze();
		const B = ModelTransitionQueue.rehydrate(A.snapshot(), h.executor);
		B.freeze();
		const C = ModelTransitionQueue.rehydrate(B.snapshot(), h.executor);

		h.release();
		await C.whenIdle();
		await tick();

		const s = h.state();
		expect(s.applyThinkingCalls).toBe(1);
		expect(s.thinking).toBe("high");
		expect(s.model).toEqual({ provider: "anthropic", id: "sonnet" });
		expect(s.peakConcurrent).toBeLessThanOrEqual(1);
	});

	it("AD2：首跳排队 restore + 3 跳接力 → 收尾回基线、applyModel 恰好 2 次、末跳 inFlight=null", async () => {
		const h = createHarness();
		const q1 = new ModelTransitionQueue(h.executor);
		q1.submitCapture(1, { model: true, thinking: true });
		await q1.whenIdle();
		q1.submitSwitch(1, { model: "anthropic/sonnet", thinking: "high" });
		await tick();

		q1.freeze();
		const A = ModelTransitionQueue.rehydrate(q1.snapshot(), h.executor);
		A.submitRestore(1); // 离开群聊：restore 排队（首跳）
		A.freeze();
		const B = ModelTransitionQueue.rehydrate(A.snapshot(), h.executor);
		B.freeze();
		const C = ModelTransitionQueue.rehydrate(B.snapshot(), h.executor);

		h.release();
		await C.whenIdle();
		await tick();

		const s = h.state();
		expect(s.model).toEqual(BASELINE);
		expect(s.thinking).toBe("low");
		// restore 的 model 恢复 = 第 2 次 applyModel；不得有第 3 次（重复恢复）。
		expect(s.applyModelCalls).toBe(2);
		// 接力完成后，任何快照都不应再携带 inFlight。
		expect(C.snapshot().inFlight).toBeNull();
		expect(C.snapshot().pending).toEqual([]);
	});
});
