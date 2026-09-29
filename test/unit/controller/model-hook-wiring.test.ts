import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CharacterRuntime } from "../../../src/character/character-runtime.js";
import type { JoinAttempt } from "../../../src/character/join-attempt.js";
import type {
	ModelIdentity,
	ModelTransitionExecutor,
	ModelTransitionSnapshot,
} from "../../../src/character/model-transition-queue.js";
import type { CharacterCard, ModelFieldStatus, ThinkingFieldStatus } from "../../../src/config/character-card.js";
import {
	type CharacterReloadHandoff,
	getReloadHandoffRegistry,
} from "../../../src/controller/reload-handoff-registry.js";
import { type ModelTransitionExecutorFactory, TavernController } from "../../../src/controller/tavern-controller.js";

/**
 * #180 L3：controller 五挂点接线钉——claim（capture+switch）/ leave 与断线
 * （restore）/ detachForReload（freeze+快照恰一次）/ takeReloadHandoff
 * （rehydrate 续跑）。执行器为注入工厂的 fake；队列、epoch、槽位、屏障全走
 * 真实实现（只断言行为面，不触内部字段）。
 *
 * CharacterRuntime.takeHandoff 为静态深装配（socket/磁盘重读），本层以
 * vi.mock 替换；takeHandoff 自身的 modelTransition 搬运由 acceptance 覆盖。
 */
const mocks = vi.hoisted(() => ({ takeHandoff: vi.fn() }));

vi.mock("../../../src/character/character-runtime.js", () => ({
	CharacterRuntime: { takeHandoff: mocks.takeHandoff },
}));

const DESCRIPTOR = {
	instanceId: "instance-1",
	groupChatId: "group-1",
	name: null,
	cwd: "/project",
	pid: 1234,
	host: "127.0.0.1" as const,
	port: 54321,
	startedAt: "2026-09-27T00:00:00.000Z",
};

function makeCard(model?: ModelFieldStatus, thinking?: ThinkingFieldStatus): CharacterCard {
	return {
		characterId: "char-1",
		name: "Char",
		description: "test",
		path: "/agent/characters/char.md",
		prompt: "prompt",
		...(model !== undefined ? { model } : {}),
		...(thinking !== undefined ? { thinking } : {}),
	};
}

interface ExecutorHarness {
	executor: ModelTransitionExecutor;
	calls: {
		resolved: string[];
		appliedModels: string[];
		appliedThinking: string[];
		warnings: string[];
	};
}

function makeRuntime(card: CharacterCard): CharacterRuntime {
	return {
		character: card,
		close: vi.fn(async () => undefined),
	} as unknown as CharacterRuntime;
}

function makeAttempt(runtime: CharacterRuntime): JoinAttempt {
	return {
		availableCharacters: [],
		isActive: true,
		claimCharacter: vi.fn(async () => runtime),
		close: vi.fn(async () => undefined),
	} as unknown as JoinAttempt;
}

/** 状态（模型/强度）跨执行器实例共享 = 同一 pi 会话；每次工厂调用记录一个 harness。 */
function createFactory(): {
	state: { model: ModelIdentity | undefined; thinking: string | undefined };
	harnesses: ExecutorHarness[];
	factory: ModelTransitionExecutorFactory;
} {
	const state: { model: ModelIdentity | undefined; thinking: string | undefined } = {
		model: { provider: "fixture", id: "beta" },
		thinking: "low",
	};
	const harnesses: ExecutorHarness[] = [];
	const factory: ModelTransitionExecutorFactory = () => {
		const calls: ExecutorHarness["calls"] = {
			resolved: [],
			appliedModels: [],
			appliedThinking: [],
			warnings: [],
		};
		const executor: ModelTransitionExecutor = {
			getModelIdentity: () => state.model,
			getThinkingLevel: () => state.thinking,
			resolveModel: (provider, id) => {
				calls.resolved.push(`${provider}/${id}`);
				return { provider, id };
			},
			applyModel: async (model) => {
				const target = model as ModelIdentity;
				calls.appliedModels.push(`${target.provider}/${target.id}`);
				state.model = target;
				return true;
			},
			applyThinking: (level) => {
				calls.appliedThinking.push(level);
				state.thinking = level;
			},
			notifyWarning: (message) => calls.warnings.push(message),
		};
		harnesses.push({ executor, calls });
		return executor;
	};
	return { state, harnesses, factory };
}

async function joinAndClaim(
	controller: TavernController,
	notify?: (message: string) => void,
): Promise<CharacterRuntime> {
	await controller.startJoining(DESCRIPTOR, "session-1");
	return controller.claimCharacter("char-1", {} as ExtensionAPI, notify);
}

describe("TavernController model hook 接线（#180 L3）", () => {
	it("claim 提交 capture+switch；leave 恢复 capture 基线（双维，model→thinking 顺序）", async () => {
		const card = makeCard({ status: "ok", model: "fixture/alpha" }, { status: "ok", level: "high" });
		const attempt = makeAttempt(makeRuntime(card));
		const { harnesses, factory } = createFactory();
		const controller = new TavernController(undefined, async () => attempt, undefined, factory);

		await joinAndClaim(controller);
		const harness = harnesses[0];
		expect(harness).toBeDefined();
		if (harness === undefined) return;
		await vi.waitFor(() => expect(harness.calls.appliedThinking).toEqual(["high"]));
		expect(harness.calls.resolved).toEqual(["fixture/alpha"]);
		expect(harness.calls.appliedModels).toEqual(["fixture/alpha"]);

		await controller.leave();
		await vi.waitFor(() => expect(harness.calls.appliedModels).toEqual(["fixture/alpha", "fixture/beta"]));
		expect(harness.calls.appliedThinking).toEqual(["high", "low"]);
	});

	it("未配置双维：不建队列、不调执行器（现有行为零变化）", async () => {
		const attempt = makeAttempt(makeRuntime(makeCard()));
		const { harnesses, factory } = createFactory();
		const controller = new TavernController(undefined, async () => attempt, undefined, factory);

		await joinAndClaim(controller);
		await controller.leave();

		expect(harnesses).toHaveLength(0);
	});

	it("invalid 维度：只经 notify 提示一次，不提交（队列零任务）", async () => {
		const attempt = makeAttempt(makeRuntime(makeCard({ status: "invalid", raw: 42 })));
		const { harnesses, factory } = createFactory();
		const notify = vi.fn();
		const controller = new TavernController(undefined, async () => attempt, undefined, factory);

		await joinAndClaim(controller, notify);
		await controller.leave();

		expect(harnesses).toHaveLength(0);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[0]).toContain("model");
	});

	it("断线回 idle 视为离开：提交 restore（兼队列丢唤醒回归钉）", async () => {
		// 本钉同时锁队列 kick 丢失唤醒：restore 在「run 循环退出 → finally 回调」
		// 窗口入队时（本测试的形状）未被补 kick 的实现会把 restore 永久搁置——
		// 钉在未修队列上 3/3 红、修复后 3/3 绿，为确定性判别器。
		const card = makeCard(undefined, { status: "ok", level: "high" });
		const attempt = makeAttempt(makeRuntime(card));
		const { harnesses, factory } = createFactory();
		let disconnect: (() => void) | undefined;
		const controller = new TavernController(
			undefined,
			async (_descriptor, _sessionId, options) => {
				disconnect = options.onDisconnected;
				return attempt;
			},
			undefined,
			factory,
		);

		await joinAndClaim(controller);
		const harness = harnesses[0];
		if (harness === undefined) throw new Error("executor not created");
		await vi.waitFor(() => expect(harness.calls.appliedThinking).toEqual(["high"]));

		disconnect?.();
		await vi.waitFor(() => expect(controller.getState()).toEqual({ type: "idle" }));
		await vi.waitFor(() => expect(harness.calls.appliedThinking).toEqual(["high", "low"]));
	});

	it("reload：detach 携带快照恰一次；take 后队列续跑（槽位/epoch 随 handoff 重建）", async () => {
		const card = makeCard({ status: "ok", model: "fixture/alpha" }, { status: "ok", level: "high" });
		const runtime = makeRuntime(card);
		const captured: { snapshot: ModelTransitionSnapshot | undefined; calls: number } = {
			snapshot: undefined,
			calls: 0,
		};
		runtime.detachForReload = vi.fn(async (_piSessionId: string, snapshot?: ModelTransitionSnapshot) => {
			captured.calls += 1;
			captured.snapshot = snapshot;
			return { kind: "character" } as unknown as CharacterReloadHandoff;
		});
		const attempt = makeAttempt(runtime);
		const { harnesses, factory } = createFactory();
		const controller = new TavernController(undefined, async () => attempt, undefined, factory);

		await joinAndClaim(controller);
		const first = harnesses[0];
		if (first === undefined) throw new Error("executor not created");
		await vi.waitFor(() => expect(first.calls.appliedModels).toEqual(["fixture/alpha"]));

		await controller.handleSessionShutdown("reload", "pi-session-1");

		expect(captured.calls).toBe(1);
		const snapshot = captured.snapshot;
		expect(snapshot).toBeDefined();
		if (snapshot === undefined) return;
		expect(snapshot.pending).toEqual([]);
		expect(snapshot.activeEpoch).toBe(1);
		expect(snapshot.slots.size).toBe(1);
		expect(snapshot.inFlight).toBeNull();

		// take 侧：注册表投递同一快照，rehydrate 用新执行器重建队列。
		const reloaded = makeRuntime(card);
		mocks.takeHandoff.mockResolvedValueOnce(reloaded);
		getReloadHandoffRegistry().publish({
			kind: "character",
			piSessionId: "pi-session-1",
			expiresAt: Date.now() + 60_000,
			modelTransition: snapshot,
			cleanup: async () => undefined,
		} as unknown as CharacterReloadHandoff);
		await controller.takeReloadHandoff("pi-session-1", {} as ExtensionAPI, () => undefined);
		expect(controller.getState()).toEqual({ type: "character", runtime: reloaded });

		// 续跑证明：reload 后正常离开仍回基线（rehydrate 槽位 + 续算 epoch 生效）。
		await controller.leave();
		const second = harnesses[1];
		expect(second).toBeDefined();
		if (second === undefined) return;
		await vi.waitFor(() => expect(second.calls.appliedModels).toEqual(["fixture/beta"]));
		expect(second.calls.appliedThinking).toEqual(["low"]);
	});

	it("外部模型事件校正：无队列时 no-op，不抛错", () => {
		const controller = new TavernController();

		expect(() => controller.noteModelIdentity({ provider: "fixture", id: "gamma" })).not.toThrow();
		expect(() => controller.noteThinkingLevel("high")).not.toThrow();
	});
});
