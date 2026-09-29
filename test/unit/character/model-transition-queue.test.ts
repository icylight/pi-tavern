import { describe, expect, it } from "vitest";
import {
	type ModelIdentity,
	type ModelTransitionExecutor,
	ModelTransitionQueue,
	splitModelReference,
} from "../../../src/character/model-transition-queue.js";

/**
 * L2 队列单测（#180）：纯逻辑，零 pi 依赖——执行器以六方法注入接口装配。
 * 契约：docs/architecture/character-model-hook.md §4–§10。
 */

interface FakeExecutorOptions {
	model?: ModelIdentity;
	thinking?: string;
	/** 可解析的模型集合（"provider/id" 串）；未列出 = resolve 未命中。 */
	resolvable?: string[];
	/** applyModel 回执（默认 true）；同步应用模型到 getter。 */
	applyModelResult?: boolean | (() => boolean);
	/** applyModel 抛错。 */
	applyModelThrows?: Error;
	/** applyThinking 抛错。 */
	applyThinkingThrows?: Error;
	/** 模型 getter 不可观测。 */
	modelUnobservable?: boolean;
	/** thinking getter 不可观测。 */
	thinkingUnobservable?: boolean;
}

interface FakeExecutor extends ModelTransitionExecutor {
	readonly warnings: string[];
	readonly resolveCalls: string[];
	readonly applyModelCalls: Array<{ provider: string; id: string }>;
	readonly applyThinkingCalls: string[];
	setModel(identity: ModelIdentity): void;
	setThinking(level: string): void;
	setModelUnobservable(value: boolean): void;
}

const MODEL_A: ModelIdentity = { provider: "anthropic", id: "opus" };
const MODEL_B: ModelIdentity = { provider: "anthropic", id: "sonnet" };
const MODEL_C: ModelIdentity = { provider: "openai", id: "gpt" };

function keyOf(identity: ModelIdentity): string {
	return `${identity.provider}/${identity.id}`;
}

function createFakeExecutor(options: FakeExecutorOptions = {}): FakeExecutor {
	let model = options.model ?? MODEL_A;
	let thinking = options.thinking ?? "low";
	let modelUnobservable = options.modelUnobservable ?? false;
	const thinkingUnobservable = options.thinkingUnobservable ?? false;
	const resolvable = new Set((options.resolvable ?? [keyOf(MODEL_A), keyOf(MODEL_B), keyOf(MODEL_C)]).map((k) => k));
	const warnings: string[] = [];
	const resolveCalls: string[] = [];
	const applyModelCalls: Array<{ provider: string; id: string }> = [];
	const applyThinkingCalls: string[] = [];

	return {
		warnings,
		resolveCalls,
		applyModelCalls,
		applyThinkingCalls,
		getModelIdentity: () => (modelUnobservable ? undefined : model),
		getThinkingLevel: () => (thinkingUnobservable ? undefined : thinking),
		resolveModel: (provider, id) => {
			const key = `${provider}/${id}`;
			resolveCalls.push(key);
			return resolvable.has(key) ? { key } : undefined;
		},
		applyModel: async (resolved) => {
			const key = (resolved as { key: string }).key;
			const separator = key.indexOf("/");
			applyModelCalls.push({ provider: key.slice(0, separator), id: key.slice(separator + 1) });
			if (options.applyModelThrows) {
				throw options.applyModelThrows;
			}
			const accepted =
				typeof options.applyModelResult === "function"
					? options.applyModelResult()
					: (options.applyModelResult ?? true);
			if (accepted) {
				model = { provider: key.slice(0, separator), id: key.slice(separator + 1) };
			}
			return accepted;
		},
		applyThinking: (level) => {
			applyThinkingCalls.push(level);
			if (options.applyThinkingThrows) {
				throw options.applyThinkingThrows;
			}
			thinking = level;
		},
		notifyWarning: (message) => {
			warnings.push(message);
		},
		setModel: (identity) => {
			model = identity;
		},
		setThinking: (level) => {
			thinking = level;
		},
		setModelUnobservable: (value) => {
			modelUnobservable = value;
		},
	};
}

describe("splitModelReference", () => {
	it.each([
		["anthropic/claude", { provider: "anthropic", id: "claude" }],
		[" anthropic / claude ", { provider: "anthropic", id: "claude" }],
		["a/b/c", { provider: "a", id: "b/c" }],
		["Anthropic/x", { provider: "Anthropic", id: "x" }],
		["x/y ", { provider: "x", id: "y" }],
	])("splits %j into %j", (raw, expected) => {
		expect(splitModelReference(raw)).toEqual(expected);
	});

	it.each([["noslash"], ["/x"], ["x/"], ["/"], [""], ["   "], [" / "]])("rejects %j", (raw) => {
		expect(splitModelReference(raw)).toBeUndefined();
	});

	it("never throws on arbitrary input", () => {
		for (const raw of ["\u0000/\u0001", "//", "a//b", "\t/\t", "\uFF0F"]) {
			expect(() => splitModelReference(raw)).not.toThrow();
		}
	});
});

describe("capture", () => {
	it("records both baseline dimensions when the mask is fully open", async () => {
		const executor = createFakeExecutor({ model: MODEL_A, thinking: "medium" });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: true });
		await queue.whenIdle();

		// 直接改 getter 状态模拟「中途被切走」（不经执行器，避免污染调用记录）。
		executor.setModel(MODEL_B);
		executor.setThinking("high");
		queue.submitRestore(1);
		await queue.whenIdle();

		expect(executor.applyModelCalls).toEqual([{ provider: "anthropic", id: "opus" }]);
		expect(executor.applyThinkingCalls).toEqual(["medium"]);
		expect(executor.warnings).toEqual([]);
	});

	it("skips the thinking dimension when the mask closes it", async () => {
		const executor = createFakeExecutor({ model: MODEL_A, thinking: "medium" });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: false });
		await queue.whenIdle();
		executor.setModel(MODEL_B);
		executor.setThinking("high");
		queue.submitRestore(1);
		await queue.whenIdle();

		expect(executor.applyThinkingCalls).toEqual([]);
		expect(executor.applyModelCalls).toEqual([{ provider: "anthropic", id: "opus" }]);
	});

	it("keeps the mask but warns when the getter is unavailable", async () => {
		const executor = createFakeExecutor({ modelUnobservable: true, thinkingUnobservable: true });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: true });
		await queue.whenIdle();

		expect(executor.warnings).toEqual([
			"Model hook: baseline model unavailable; restore of that dimension will be skipped",
			"Model hook: baseline thinking unavailable; restore of that dimension will be skipped",
		]);
	});

	it("does not let a later capture overwrite an earlier epoch slot", async () => {
		const executor = createFakeExecutor({ model: MODEL_A });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: false });
		// 第二轮 capture 前先改到 B：epoch2 基线应为 B，epoch1 保留 A。
		await queue.whenIdle();
		executor.setModel(MODEL_B);
		queue.submitCapture(2, { model: true, thinking: false });
		await queue.whenIdle();

		executor.setModel(MODEL_C);
		queue.submitRestore(1);
		await queue.whenIdle();
		expect(executor.applyModelCalls).toEqual([{ provider: "anthropic", id: "opus" }]);

		executor.setModel(MODEL_C);
		queue.submitRestore(2);
		await queue.whenIdle();
		expect(executor.applyModelCalls).toEqual([
			{ provider: "anthropic", id: "opus" },
			{ provider: "anthropic", id: "sonnet" },
		]);
	});
});

describe("switch", () => {
	it("short-circuits when the current model already matches", async () => {
		const executor = createFakeExecutor({ model: MODEL_B });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: false });
		queue.submitSwitch(1, { model: "anthropic/sonnet" });
		await queue.whenIdle();

		expect(executor.resolveCalls).toEqual([]);
		expect(executor.applyModelCalls).toEqual([]);
	});

	it("warns once for an invalid reference and never calls the executor", async () => {
		const executor = createFakeExecutor({ model: MODEL_A });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: false });
		queue.submitSwitch(1, { model: "bare-id" });
		await queue.whenIdle();

		expect(executor.resolveCalls).toEqual([]);
		expect(executor.warnings).toHaveLength(1);
		expect(executor.warnings[0]).toContain("invalid model reference");
		expect(executor.warnings[0]).toContain("bare-id");
	});

	it("warns for both dimensions when an invalid reference carries thinking", async () => {
		const executor = createFakeExecutor({ model: MODEL_A });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: true });
		queue.submitSwitch(1, { model: "bare-id", thinking: "high" });
		await queue.whenIdle();

		expect(executor.applyThinkingCalls).toEqual([]);
		expect(executor.warnings).toHaveLength(2);
		expect(executor.warnings[1]).toContain("skipping thinking level");
	});

	it("warns and skips thinking when the model cannot be resolved", async () => {
		const executor = createFakeExecutor({ model: MODEL_A, resolvable: [] });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: true });
		queue.submitSwitch(1, { model: "ghost/model", thinking: "high" });
		await queue.whenIdle();

		expect(executor.applyModelCalls).toEqual([]);
		expect(executor.applyThinkingCalls).toEqual([]);
		expect(executor.warnings[0]).toContain("not found");
		expect(executor.warnings[1]).toContain("skipping thinking level");
	});

	it("applies model then thinking in order", async () => {
		const executor = createFakeExecutor({ model: MODEL_A });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: true });
		queue.submitSwitch(1, { model: "anthropic/sonnet", thinking: "high" });
		await queue.whenIdle();

		expect(executor.applyModelCalls).toEqual([{ provider: "anthropic", id: "sonnet" }]);
		expect(executor.applyThinkingCalls).toEqual(["high"]);
		expect(executor.warnings).toEqual([]);
	});

	it("applies thinking-only switches without touching the model", async () => {
		const executor = createFakeExecutor({ model: MODEL_A });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: true });
		queue.submitSwitch(1, { thinking: "high" });
		await queue.whenIdle();

		expect(executor.applyModelCalls).toEqual([]);
		expect(executor.resolveCalls).toEqual([]);
		expect(executor.applyThinkingCalls).toEqual(["high"]);
	});

	it("passes the trimmed pair to resolveModel without case normalisation", async () => {
		const executor = createFakeExecutor({ model: MODEL_A, resolvable: ["anthropic/sonnet", "Anthropic/sonnet"] });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: false });
		queue.submitSwitch(1, { model: " anthropic / sonnet " });
		await queue.whenIdle();
		expect(executor.resolveCalls).toEqual(["anthropic/sonnet"]);

		queue.submitSwitch(1, { model: "Anthropic/sonnet" });
		await queue.whenIdle();
		expect(executor.resolveCalls).toEqual(["anthropic/sonnet", "Anthropic/sonnet"]);
	});

	it("treats a rejected receipt with an unreached target as failure", async () => {
		const executor = createFakeExecutor({ model: MODEL_A, applyModelResult: false });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: true });
		queue.submitSwitch(1, { model: "anthropic/sonnet", thinking: "high" });
		await queue.whenIdle();

		expect(executor.applyThinkingCalls).toEqual([]);
		expect(executor.warnings.some((w) => w.includes("was not applied"))).toBe(true);
	});

	it("continues when the receipt is rejected but the getter shows the target", async () => {
		// 副作用已发生、回执不可靠（§8 校正规则）：实际值达标即继续，仅提示。
		const executor = createFakeExecutor({ model: MODEL_A });
		const original = executor.applyModel;
		executor.applyModel = async (resolved) => {
			await original(resolved);
			return false;
		};
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: true });
		queue.submitSwitch(1, { model: "anthropic/sonnet", thinking: "high" });
		await queue.whenIdle();

		expect(executor.applyThinkingCalls).toEqual(["high"]);
		expect(executor.warnings.some((w) => w.includes("failed to apply model"))).toBe(true);
	});

	it("swallows a thrown applyModel into a warning", async () => {
		const executor = createFakeExecutor({ model: MODEL_A, applyModelThrows: new Error("auth check failed") });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: true });
		queue.submitSwitch(1, { model: "anthropic/sonnet", thinking: "high" });
		await queue.whenIdle();

		expect(executor.applyThinkingCalls).toEqual([]);
		expect(executor.warnings.some((w) => w.includes("auth check failed"))).toBe(true);
	});

	it("keeps the model when applyThinking throws", async () => {
		const executor = createFakeExecutor({ model: MODEL_A, applyThinkingThrows: new Error("clamp exploded") });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: true });
		queue.submitSwitch(1, { model: "anthropic/sonnet", thinking: "ultra" });
		await queue.whenIdle();

		expect(executor.getModelIdentity()).toEqual(MODEL_B);
		expect(executor.warnings.some((w) => w.includes("failed to apply thinking level"))).toBe(true);
	});

	it("falls back to the receipt when the getter is unobservable", async () => {
		const executor = createFakeExecutor({ model: MODEL_A, applyModelResult: true });
		executor.setModelUnobservable(true);
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: false });
		queue.submitSwitch(1, { model: "anthropic/sonnet" });
		await queue.whenIdle();

		expect(executor.applyModelCalls).toEqual([{ provider: "anthropic", id: "sonnet" }]);
	});
});

describe("epoch and state validation", () => {
	it("drops a switch whose epoch is no longer active", async () => {
		const executor = createFakeExecutor({ model: MODEL_A });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: false });
		queue.submitCapture(2, { model: true, thinking: false });
		queue.submitSwitch(1, { model: "anthropic/sonnet" });
		await queue.whenIdle();

		expect(executor.applyModelCalls).toEqual([]);
	});

	it("drops a queued switch once a restore supersedes the epoch", async () => {
		const executor = createFakeExecutor({ model: MODEL_A });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: false });
		queue.submitSwitch(1, { model: "anthropic/sonnet" });
		queue.submitRestore(1);
		queue.submitSwitch(1, { model: "openai/gpt" });
		await queue.whenIdle();

		expect(executor.applyModelCalls).toEqual([]);
	});

	it("switch 在途时 leave：restore 排队兜底，最终回到基线", async () => {
		// 契约 §5 规则 1/2 的竞态合并场景：switch 的 applyModel 在途 → leave 提交
		// restore（无条件执行、不校验状态）→ 两者在同一 FIFO 上串行：switch 先落定，
		// restore 随后把模型拉回基线。
		const executor = createFakeExecutor({ model: MODEL_A, thinking: "low" });
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const original = executor.applyModel;
		executor.applyModel = async (resolved) => {
			await gate;
			return original(resolved);
		};
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: true });
		await queue.whenIdle();
		queue.submitSwitch(1, { model: "anthropic/sonnet", thinking: "high" });
		// switch 进入在途（applyModel 挂在 gate 上）后提交 leave。
		await new Promise((resolve) => setTimeout(resolve, 5));
		queue.submitRestore(1);
		release();
		await queue.whenIdle();

		expect(executor.getModelIdentity()).toEqual(MODEL_A);
		expect(executor.getThinkingLevel()).toBe("low");
	});

	it("still restores when a new epoch already started", async () => {
		const executor = createFakeExecutor({ model: MODEL_A });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: false });
		await queue.whenIdle();
		executor.setModel(MODEL_B);
		queue.submitRestore(1);
		queue.submitCapture(2, { model: true, thinking: false });
		await queue.whenIdle();

		expect(executor.applyModelCalls).toEqual([{ provider: "anthropic", id: "opus" }]);
	});
});

describe("restore", () => {
	it("restores both dimensions", async () => {
		const executor = createFakeExecutor({ model: MODEL_A, thinking: "low" });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: true });
		queue.submitSwitch(1, { model: "openai/gpt", thinking: "high" });
		await queue.whenIdle();
		queue.submitRestore(1);
		await queue.whenIdle();

		expect(executor.getModelIdentity()).toEqual(MODEL_A);
		expect(executor.getThinkingLevel()).toBe("low");
	});

	it("leaves the model alone for a thinking-only mask", async () => {
		const executor = createFakeExecutor({ model: MODEL_A, thinking: "low" });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: false, thinking: true });
		queue.submitSwitch(1, { thinking: "high" });
		await queue.whenIdle();
		executor.setModel(MODEL_C); // 用户手动换模型：未配置维度不回滚
		queue.submitRestore(1);
		await queue.whenIdle();

		expect(executor.getModelIdentity()).toEqual(MODEL_C);
		expect(executor.getThinkingLevel()).toBe("low");
	});

	it("is idempotent when the values already match", async () => {
		const executor = createFakeExecutor({ model: MODEL_A, thinking: "low" });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: true });
		await queue.whenIdle();
		queue.submitRestore(1);
		await queue.whenIdle();

		expect(executor.applyModelCalls).toEqual([]);
		expect(executor.applyThinkingCalls).toEqual([]);
	});

	it("skips everything with a warning when the recorded model is missing", async () => {
		const executor = createFakeExecutor({ modelUnobservable: true, thinking: "low" });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: true });
		await queue.whenIdle();
		executor.setModelUnobservable(false);
		queue.submitRestore(1);
		await queue.whenIdle();

		expect(executor.applyModelCalls).toEqual([]);
		expect(executor.applyThinkingCalls).toEqual([]);
		expect(executor.warnings.filter((w) => w.includes("baseline"))).toHaveLength(3);
	});

	it("skips thinking when the model cannot reach the baseline", async () => {
		const executor = createFakeExecutor({ model: MODEL_A, thinking: "low", resolvable: [] });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: true });
		await queue.whenIdle();
		executor.setModel(MODEL_B);
		queue.submitRestore(1);
		await queue.whenIdle();

		expect(executor.applyThinkingCalls).toEqual([]);
		expect(executor.warnings.some((w) => w.includes("not found"))).toBe(true);
		expect(executor.warnings.some((w) => w.includes("skipping thinking level"))).toBe(true);
	});
});

describe("record correction", () => {
	it("takes external model events into account", async () => {
		const executor = createFakeExecutor({ model: MODEL_A });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: false });
		await queue.whenIdle();
		executor.setModelUnobservable(true);
		queue.noteModelIdentity(MODEL_B);
		queue.submitSwitch(1, { model: "anthropic/sonnet" });
		await queue.whenIdle();

		expect(executor.applyModelCalls).toEqual([]);
	});

	it("warns when the getter cannot be observed during a task", async () => {
		const executor = createFakeExecutor({ model: MODEL_A });
		executor.setModelUnobservable(true);
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: false });
		queue.submitSwitch(1, { model: "anthropic/sonnet" });
		await queue.whenIdle();

		expect(executor.warnings.some((w) => w.includes("unable to observe"))).toBe(true);
	});
});

describe("single-flight", () => {
	it("never runs two model applications concurrently", async () => {
		const executor = createFakeExecutor({ model: MODEL_A });
		let concurrent = 0;
		let peak = 0;
		const original = executor.applyModel;
		executor.applyModel = async (resolved) => {
			concurrent += 1;
			peak = Math.max(peak, concurrent);
			await new Promise((resolve) => setTimeout(resolve, 5));
			const result = await original(resolved);
			concurrent -= 1;
			return result;
		};
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: false });
		queue.submitSwitch(1, { model: "anthropic/sonnet" });
		queue.submitSwitch(1, { model: "openai/gpt" });
		queue.submitSwitch(1, { model: "anthropic/opus" });
		await queue.whenIdle();

		expect(peak).toBe(1);
		expect(executor.applyModelCalls).toHaveLength(3);
	});
});

describe("freeze, snapshot and rehydrate", () => {
	it("stops taking pending tasks after freeze and preserves them in the snapshot", async () => {
		const executor = createFakeExecutor({ model: MODEL_A });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: false });
		queue.freeze();
		queue.submitSwitch(1, { model: "anthropic/sonnet" });
		await queue.whenIdle();

		expect(executor.applyModelCalls).toEqual([]);
		expect(queue.snapshot().pending).toEqual([{ kind: "switch", epoch: 1, target: { model: "anthropic/sonnet" } }]);
	});

	it("shares the slot table with the rehydrated queue", async () => {
		const executor = createFakeExecutor({ model: MODEL_A });
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: false });
		await queue.whenIdle();
		queue.freeze();
		const snapshot = queue.snapshot();

		executor.setModel(MODEL_B);
		const revived = ModelTransitionQueue.rehydrate(snapshot, executor);
		revived.submitRestore(1);
		await revived.whenIdle();

		expect(executor.applyModelCalls).toEqual([{ provider: "anthropic", id: "opus" }]);
	});

	it("carries out the remaining thinking after the reload barrier", async () => {
		const executor = createFakeExecutor({ model: MODEL_A });
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const original = executor.applyModel;
		executor.applyModel = async (resolved) => {
			await gate;
			return original(resolved);
		};
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: true });
		queue.submitSwitch(1, { model: "anthropic/sonnet", thinking: "high" });
		// 让 switch 进入在途（applyModel 已挂起）。
		await new Promise((resolve) => setTimeout(resolve, 5));
		queue.freeze();
		const snapshot = queue.snapshot();
		expect(snapshot.inFlight).not.toBeNull();

		const revived = ModelTransitionQueue.rehydrate(snapshot, executor);
		release();
		await revived.whenIdle();

		expect(executor.applyThinkingCalls).toEqual(["high"]);
		expect(executor.getThinkingLevel()).toBe("high");
	});

	it("skips the remaining thinking after the barrier when the model missed the target", async () => {
		const executor = createFakeExecutor({ model: MODEL_A, applyModelResult: false });
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const original = executor.applyModel;
		executor.applyModel = async (resolved) => {
			await gate;
			return original(resolved);
		};
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: true });
		queue.submitSwitch(1, { model: "anthropic/sonnet", thinking: "high" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		queue.freeze();
		const snapshot = queue.snapshot();

		const revived = ModelTransitionQueue.rehydrate(snapshot, executor);
		release();
		await revived.whenIdle();

		expect(executor.applyThinkingCalls).toEqual([]);
		expect(executor.warnings.some((w) => w.includes("skipping thinking level"))).toBe(true);
	});

	it("skips the barrier thinking when the snapshot target cannot be determined", async () => {
		// 跨版本 handoff 防御路径：旧快照里的 switch target 在当代解析不出二元组。
		const executor = createFakeExecutor({ model: MODEL_A });
		const revived = ModelTransitionQueue.rehydrate(
			{
				pending: [],
				lastModel: MODEL_A,
				lastThinking: "low",
				activeEpoch: 1,
				slots: new Map(),
				inFlight: {
					task: { kind: "switch", epoch: 1, target: { model: "bare-id", thinking: "high" } },
					completionPromise: Promise.resolve(),
					phase: "model",
					remaining: { thinking: "high" },
				},
			},
			executor,
		);
		await revived.whenIdle();

		expect(executor.applyThinkingCalls).toEqual([]);
		expect(executor.warnings.some((w) => w.includes("could not be determined"))).toBe(true);
	});

	it("warns on barrier timeout without crossing the barrier", async () => {
		const executor = createFakeExecutor({ model: MODEL_A });
		const never = new Promise<boolean>(() => undefined);
		const stuck = {
			task: { kind: "switch", epoch: 1, target: { model: "anthropic/sonnet" } },
			completionPromise: never,
			phase: "model",
			remaining: {},
		} as const;

		const revived = ModelTransitionQueue.rehydrate(
			{
				pending: [{ kind: "switch", epoch: 1, target: { thinking: "high" } }],
				lastModel: MODEL_A,
				lastThinking: "low",
				activeEpoch: 1,
				slots: new Map(),
				inFlight: stuck,
			},
			executor,
			{ barrierTimeoutMs: 20 },
		);
		await new Promise((resolve) => setTimeout(resolve, 60));

		expect(executor.warnings.some((w) => w.includes("barrier timed out"))).toBe(true);
		// pending 未被越过：thinking 切换仍然不能执行，且仍留在 pending 里。
		expect(executor.applyThinkingCalls).toEqual([]);
		expect(revived.snapshot().pending).toEqual([{ kind: "switch", epoch: 1, target: { thinking: "high" } }]);
	});
});

describe("best-effort resilience", () => {
	it("keeps running the queue after an unexpected task failure", async () => {
		const executor = createFakeExecutor({ model: MODEL_A });
		const original = executor.resolveModel;
		// 确定性故障注入：只让 sonnet 这条抛错（不依赖任务执行时序）。
		executor.resolveModel = (provider, id) => {
			if (`${provider}/${id}` === "anthropic/sonnet") {
				throw new Error("registry exploded");
			}
			return original(provider, id);
		};
		const queue = new ModelTransitionQueue(executor);
		queue.submitCapture(1, { model: true, thinking: false });
		queue.submitSwitch(1, { model: "anthropic/sonnet" });
		queue.submitSwitch(1, { model: "openai/gpt" });
		await queue.whenIdle();

		expect(executor.warnings.some((w) => w.includes("unexpected failure"))).toBe(true);
		expect(executor.applyModelCalls).toEqual([{ provider: "openai", id: "gpt" }]);
	});
});
