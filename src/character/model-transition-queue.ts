/**
 * 角色模型/思考强度临时覆盖的转换队列（#180 L2）。
 *
 * 契约见 docs/architecture/character-model-hook.md §4–§11：纯逻辑，不 import
 * pi SDK、不依赖 node:fs；pi 侧能力经六方法注入接口（§10，签名已冻结）。
 * 队列持有本轮基线槽位与 lastModel/lastThinking 记录，按提交序单飞执行
 * capture → switch → restore；状态权威点（claim / leave / 断线 / reload）
 * 由 application 层提交任务并推进 epoch，队列不感知群聊状态。
 */

/** 模型二元组（provider/id 逐段精确比较，大小写敏感，与 pi find 同语义）。 */
export interface ModelIdentity {
	provider: string;
	id: string;
}

/** 本轮基线需要恢复的维度（基础检查通过 = true；显式 mask，不用属性存在性代替）。 */
export interface ProfileMask {
	model: boolean;
	thinking: boolean;
}

/** switch 目标：model 为角色卡原始串（拆分归队列），thinking 为任意非空字符串。 */
export interface ModelTransitionTarget {
	model?: string;
	thinking?: string;
}

/** 队列任务（纯数据，可随 reload 快照交接）。 */
export type ModelTransitionTask =
	| { kind: "capture"; epoch: number; mask: ProfileMask }
	| { kind: "switch"; epoch: number; target: ModelTransitionTarget }
	| { kind: "restore"; epoch: number };

/**
 * pi 集成侧执行器：六方法注入接口（§10，已冻结）。
 * 队列不见 pi 类型——resolveModel 结果不透明透传，applyModel 收解析结果。
 */
export interface ModelTransitionExecutor {
	/** 读生效模型二元组（getter 校正用）；不可观测时 undefined。 */
	getModelIdentity(): ModelIdentity | undefined;
	/** 读生效 thinking 强度；不可观测时 undefined。 */
	getThinkingLevel(): string | undefined;
	/** 解析模型（= modelRegistry.find）；未命中/不可用 undefined。 */
	resolveModel(provider: string, id: string): unknown | undefined;
	/** 应用模型（= ctx.setModel 返回值层）；内部二次鉴权可能 throw。 */
	applyModel(model: unknown): Promise<boolean>;
	/** 应用 thinking（cast 直传；非法值由 pi 钳制；仅 throw 层失败）。 */
	applyThinking(level: string): void;
	/** 单一 warning 通道（提示逻辑不落 runtime 层）。 */
	notifyWarning(message: string): void;
}

/** 在途任务快照（单飞保证至多一个；随 reload handoff 交给新队列收尾）。 */
export interface ModelTransitionInFlight {
	task: ModelTransitionTask;
	/** 在途阶段 settle promise（模型应用；永不 reject——失败在队列内归一，值不参与契约）。文档 §8 记为 completionPromise。 */
	completionPromise: Promise<unknown>;
	/** 同步 thinking 无在途窗口，仅 "model" 可被观测。 */
	phase: "model" | "thinking";
	/** 未执行部分（模型在途时 = 待应用的 thinking）。 */
	remaining: { thinking?: string };
}

/** reload 交接快照（§8）：pending 纯任务 + 记录 + 槽位表 + 至多一个在途。 */
export interface ModelTransitionSnapshot {
	pending: ModelTransitionTask[];
	lastModel: ModelIdentity | undefined;
	lastThinking: string | undefined;
	activeEpoch: number | null;
	/** 基线槽位表（epoch → 槽位）。跨 handoff 按引用共享：在途任务与新队列读写同一份。 */
	slots: Map<number, BaselineSlot>;
	inFlight: ModelTransitionInFlight | null;
}

export interface ModelTransitionQueueOptions {
	/** in-flight barrier 超时（ms）；超时只发 warning，不越障。 */
	barrierTimeoutMs?: number;
}

interface BaselineSlot {
	mask: ProfileMask;
	values: { model?: ModelIdentity; thinking?: string };
}

const DEFAULT_BARRIER_TIMEOUT_MS = 500;

/**
 * 拆分角色卡原始 model 串：按首个 "/" 拆、两段各 trim；无 "/" 或空段 = invalid。
 * id 可继续含 "/"；不做大小写归一（归一化 = 与 pi find 不同的第二事实源）。
 */
export function splitModelReference(raw: string): ModelIdentity | undefined {
	const separator = raw.indexOf("/");
	if (separator === -1) {
		return undefined;
	}
	const provider = raw.slice(0, separator).trim();
	const id = raw.slice(separator + 1).trim();
	if (provider === "" || id === "") {
		return undefined;
	}
	return { provider, id };
}

function isSameIdentity(left: ModelIdentity | undefined, right: ModelIdentity): boolean {
	return left !== undefined && left.provider === right.provider && left.id === right.id;
}

/** warning 文案（含目标与失败动作；单元测试与 acceptance 按子串断言）。 */
const warningText = {
	invalidReference: (raw: string) =>
		`Model hook: invalid model reference "${raw}" (expected provider/id); keeping current model`,
	modelNotFound: (target: ModelIdentity) =>
		`Model hook: model "${target.provider}/${target.id}" not found; keeping current model`,
	modelApplyFailed: (target: ModelIdentity, detail: string) =>
		`Model hook: failed to apply model "${target.provider}/${target.id}" (${detail}); keeping current model`,
	modelNotReached: (target: ModelIdentity) =>
		`Model hook: model "${target.provider}/${target.id}" was not applied; keeping current model`,
	thinkingSkipped: (level: string, target: ModelIdentity) =>
		`Model hook: skipping thinking level "${level}" because model "${target.provider}/${target.id}" was not applied`,
	thinkingFailed: (level: string, detail: string) =>
		`Model hook: failed to apply thinking level "${level}" (${detail})`,
	observeFailed: () => "Model hook: unable to observe current model/thinking level; keeping last known values",
	baselineMissing: (dimension: "model" | "thinking") =>
		`Model hook: baseline ${dimension} unavailable; restore of that dimension will be skipped`,
	restoreThinkingSkipped: (target: ModelIdentity) =>
		`Model hook: skipping thinking level restore because current model differs from baseline "${target.provider}/${target.id}"`,
	barrierTimeout: (ms: number) =>
		`Model hook: reload barrier timed out after ${ms}ms; waiting for the in-flight model switch to settle`,
	thinkingSkippedUnknown: (level: string) =>
		`Model hook: skipping thinking level "${level}" because the target model could not be determined`,
	unexpected: (detail: string) => `Model hook: unexpected failure (${detail})`,
} as const;

/** 模型应用结果：回执与失败原因（错误在队列内归一，不向调用方 reject）。 */
interface ModelApplyOutcome {
	accepted: boolean;
	detail?: string;
}

/**
 * 单飞 FIFO 转换队列。提交方法按调用序入队（串行状态机保证提交序），
 * 队列保证执行序与 at-most-one 并发写。
 */
export class ModelTransitionQueue {
	private tasks: ModelTransitionTask[] = [];
	private running = false;
	private frozen = false;
	private barrier: Promise<void> | null = null;
	private inFlight: ModelTransitionInFlight | null = null;
	private slots = new Map<number, BaselineSlot>();
	private lastModel: ModelIdentity | undefined;
	private lastThinking: string | undefined;
	private activeEpoch: number | null = null;
	private readonly barrierTimeoutMs: number;
	private idleWaiters: Array<() => void> = [];

	constructor(
		private readonly executor: ModelTransitionExecutor,
		options: ModelTransitionQueueOptions = {},
	) {
		this.barrierTimeoutMs = options.barrierTimeoutMs ?? DEFAULT_BARRIER_TIMEOUT_MS;
	}

	/** 进入 Character 态：标记当前轮并拍基线（仅 mask 开启维度）。 */
	submitCapture(epoch: number, mask: ProfileMask): void {
		this.activeEpoch = epoch;
		this.enqueue({ kind: "capture", epoch, mask });
	}

	/**
	 * 提交切换；执行前校验 epoch 仍为当前轮，过期即丢弃（契约 §5 规则 1）。
	 * 队列不感知群聊状态：activeEpoch 仅在本轮 capture 时设置、在离开路径提交
	 * restore 时清空——故 epoch 校验同时覆盖「状态 = Character」与「epoch = 当前轮」
	 * 两重语义（挂点保证 leave 必经 submitRestore）。
	 */
	submitSwitch(epoch: number, target: ModelTransitionTarget): void {
		this.enqueue({ kind: "switch", epoch, target });
	}

	/**
	 * 提交恢复（无条件执行、不校验 epoch/状态）。提交即代表离开 Character 态
	 * ——等待中的 switch 因 activeEpoch 清空被丢弃，在途 switch 由其后的
	 * restore 兜底（顺序屏障）。
	 */
	submitRestore(epoch: number): void {
		if (this.activeEpoch === epoch) {
			this.activeEpoch = null;
		}
		this.enqueue({ kind: "restore", epoch });
	}

	/** 外部（ctx）模型事件校正记录（用户手动换模型绕过队列的场景）。 */
	noteModelIdentity(identity: ModelIdentity | undefined): void {
		if (identity !== undefined) {
			this.lastModel = identity;
		}
	}

	/** 外部（ctx）thinking 事件校正记录。 */
	noteThinkingLevel(level: string | undefined): void {
		if (level !== undefined) {
			this.lastThinking = level;
		}
	}

	/** 空闲等待（测试与交接用）：在途任务结束（冻结后 pending 保留）即返回。 */
	whenIdle(): Promise<void> {
		if (!this.running) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.idleWaiters.push(resolve);
		});
	}

	/** detach 前冻结：在途任务完成后不再取 pending；在途任务不再执行剩余部分。 */
	freeze(): void {
		this.frozen = true;
	}

	/** 交接快照：pending 纯任务 + 记录 + 槽位表（引用共享）+ 至多一个在途。 */
	snapshot(): ModelTransitionSnapshot {
		return {
			pending: [...this.tasks],
			lastModel: this.lastModel,
			lastThinking: this.lastThinking,
			activeEpoch: this.activeEpoch,
			slots: this.slots,
			inFlight: this.inFlight,
		};
	}

	/**
	 * 用快照重建队列（reload 后新 runtime）。in-flight 存在时先过 barrier：
	 * 等旧 setModel settle → getter 校正记录 → 按需执行剩余 thinking
	 * （不制造第二个并发写），然后继续 pending。
	 * B1：在途引用随快照接力（下一队列 barrier 完成时按 frozen 分支决定
	 * 应用或继续传递），否则二次 handoff 时快照 inFlight 恒 null、串行保证丢失。
	 */
	static rehydrate(
		snapshot: ModelTransitionSnapshot,
		executor: ModelTransitionExecutor,
		options: ModelTransitionQueueOptions = {},
	): ModelTransitionQueue {
		const queue = new ModelTransitionQueue(executor, options);
		queue.tasks = [...snapshot.pending];
		queue.lastModel = snapshot.lastModel;
		queue.lastThinking = snapshot.lastThinking;
		queue.activeEpoch = snapshot.activeEpoch;
		queue.slots = snapshot.slots;
		if (snapshot.inFlight !== null) {
			// B1：登记在途引用——barrier 未完成时再次快照仍携带（接力可无限延续）。
			queue.inFlight = snapshot.inFlight;
			queue.barrier = queue.runBarrier(snapshot.inFlight);
		}
		if (queue.tasks.length > 0 || queue.barrier !== null) {
			queue.kick();
		}
		return queue;
	}

	private enqueue(task: ModelTransitionTask): void {
		this.tasks.push(task);
		this.kick();
	}

	private kick(): void {
		if (this.running) {
			return;
		}
		this.running = true;
		void this.run().finally(() => {
			this.running = false;
			const waiters = this.idleWaiters;
			this.idleWaiters = [];
			for (const resolve of waiters) {
				resolve();
			}
		});
	}

	private async run(): Promise<void> {
		if (this.barrier !== null) {
			const barrier = this.barrier;
			this.barrier = null;
			await barrier;
		}
		while (!this.frozen) {
			const task = this.tasks.shift();
			if (task === undefined) {
				break;
			}
			await this.runTaskSafely(task);
		}
	}

	/** 任务异常不得中断队列（best-effort，失败经单一 warning 通道暴露）。 */
	private async runTaskSafely(task: ModelTransitionTask): Promise<void> {
		try {
			await this.runTask(task);
		} catch (error) {
			this.warn(warningText.unexpected(error instanceof Error ? error.message : String(error)));
		}
	}

	private async runTask(task: ModelTransitionTask): Promise<void> {
		if (task.kind === "capture") {
			this.runCapture(task);
			return;
		}
		if (task.kind === "restore") {
			await this.runRestore(task);
			return;
		}
		await this.runSwitch(task);
	}

	/** capture：按 mask 拍槽位（记录优先；getter 可观测则顺带校正）。 */
	private runCapture(task: Extract<ModelTransitionTask, { kind: "capture" }>): void {
		const slot: BaselineSlot = { mask: { ...task.mask }, values: {} };
		if (task.mask.model) {
			this.refreshModel(false);
			if (this.lastModel === undefined) {
				this.warn(warningText.baselineMissing("model"));
			} else {
				slot.values.model = this.lastModel;
			}
		}
		if (task.mask.thinking) {
			this.refreshThinking(false);
			if (this.lastThinking === undefined) {
				this.warn(warningText.baselineMissing("thinking"));
			} else {
				slot.values.thinking = this.lastThinking;
			}
		}
		this.slots.set(task.epoch, slot);
	}

	/** switch：epoch 校验 → model 维（解析/达标短路/resolve/apply/校正）→ thinking 维。 */
	private async runSwitch(task: Extract<ModelTransitionTask, { kind: "switch" }>): Promise<void> {
		if (this.activeEpoch !== task.epoch) {
			return;
		}
		const raw = task.target.model;
		const parsed = raw !== undefined ? splitModelReference(raw) : undefined;
		if (raw !== undefined && parsed === undefined) {
			this.warn(warningText.invalidReference(raw));
			if (task.target.thinking !== undefined) {
				this.warn(`Model hook: skipping thinking level "${task.target.thinking}" (invalid model reference)`);
			}
			return;
		}
		if (parsed !== undefined) {
			// 达标短路：实际值（getter 优先）已等于目标则不调用执行器。
			this.refreshModel(false);
			if (!isSameIdentity(this.lastModel, parsed)) {
				const outcome = await this.applyModelDimension(parsed, task, task.target.thinking);
				if (outcome !== "reached") {
					return;
				}
			}
		}
		if (task.target.thinking !== undefined) {
			this.applyThinkingDimension(task.target.thinking);
		}
	}

	/** restore：无条件执行；按 mask 逐维恢复，逐维达标短路（幂等）。 */
	private async runRestore(task: Extract<ModelTransitionTask, { kind: "restore" }>): Promise<void> {
		const slot = this.slots.get(task.epoch);
		if (slot === undefined) {
			return;
		}
		this.refreshModel(false);
		this.refreshThinking(false);
		let finished = true;
		if (slot.mask.model) {
			if (slot.values.model === undefined) {
				this.warn(warningText.baselineMissing("model"));
				if (slot.mask.thinking) {
					this.warn(warningText.baselineMissing("thinking"));
				}
				this.slots.delete(task.epoch);
				return;
			}
			if (!isSameIdentity(this.lastModel, slot.values.model)) {
				const outcome = await this.applyModelDimension(
					slot.values.model,
					task,
					slot.mask.thinking ? slot.values.thinking : undefined,
				);
				if (outcome !== "reached") {
					finished = false;
				}
			}
			if (finished && slot.mask.thinking && !isSameIdentity(this.lastModel, slot.values.model)) {
				this.warn(warningText.restoreThinkingSkipped(slot.values.model));
				this.slots.delete(task.epoch);
				return;
			}
		}
		if (finished && slot.mask.thinking) {
			if (slot.values.thinking === undefined) {
				this.warn(warningText.baselineMissing("thinking"));
			} else if (this.lastThinking !== slot.values.thinking) {
				this.applyThinkingDimension(slot.values.thinking);
			}
		}
		if (finished) {
			this.slots.delete(task.epoch);
		}
	}

	/**
	 * model 维执行（switch/restore 共用）：resolve → apply → getter 校正。
	 * 返回 "reached"（含回执失败但实际达标）/ "failed" / "abandoned"（freeze
	 * 中断，剩余部分归新队列 barrier）。
	 */
	private async applyModelDimension(
		target: ModelIdentity,
		task: ModelTransitionTask,
		thinkingRemainder: string | undefined,
	): Promise<"reached" | "failed" | "abandoned"> {
		const resolved = this.executor.resolveModel(target.provider, target.id);
		if (resolved === undefined) {
			this.warn(warningText.modelNotFound(target));
			this.warnSkippedThinking(thinkingRemainder, target);
			return "failed";
		}
		const applyOutcome = this.callApplyModel(resolved);
		this.inFlight = {
			task,
			completionPromise: applyOutcome,
			phase: "model",
			remaining: thinkingRemainder !== undefined ? { thinking: thinkingRemainder } : {},
		};
		const outcome = await applyOutcome;
		this.inFlight = null;
		if (this.frozen) {
			return "abandoned";
		}
		const observed = this.refreshModel(true);
		if (observed === undefined) {
			// getter 不可观测：回执是唯一信号（§8 校正规则：不可观测则保留记录）。
			if (!outcome.accepted) {
				this.warnFailure(target, thinkingRemainder, outcome);
				return "failed";
			}
			return "reached";
		}
		if (!isSameIdentity(observed, target)) {
			this.warnFailure(target, thinkingRemainder, outcome);
			return "failed";
		}
		if (!outcome.accepted) {
			// 回执不可靠（副作用可能已发生）：实际值达标即继续，仅提示动作与原因。
			this.warn(warningText.modelApplyFailed(target, outcome.detail ?? "setModel reported failure"));
		}
		return "reached";
	}

	/** 失败统一形态：一条失败 warning（+ 有 thinking 目标时一条跳过 warning）。 */
	private warnFailure(target: ModelIdentity, thinkingRemainder: string | undefined, outcome: ModelApplyOutcome): void {
		this.warn(
			outcome.detail === undefined
				? warningText.modelNotReached(target)
				: warningText.modelApplyFailed(target, outcome.detail),
		);
		this.warnSkippedThinking(thinkingRemainder, target);
	}

	/** thinking 维应用：cast 直传；throw 层归 warning，不回滚 model。 */
	private applyThinkingDimension(level: string): void {
		try {
			this.executor.applyThinking(level);
		} catch (error) {
			this.warn(warningText.thinkingFailed(level, error instanceof Error ? error.message : String(error)));
		}
		this.refreshThinking(true);
	}

	/** applyModel 归一：实际 promise 与回执（永不 reject）。 */
	private async callApplyModel(model: unknown): Promise<ModelApplyOutcome> {
		try {
			const accepted = await this.executor.applyModel(model);
			return { accepted };
		} catch (error) {
			return { accepted: false, detail: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * barrier：等旧 setModel settle → 校正记录 → 执行剩余 thinking（model 达标
	 * 才设置；未达标跳过 + warning）。超时只发 warning、继续等待，不制造
	 * 第二个并发写（model hook 可停滞，主流程不阻塞）。
	 */
	private async runBarrier(inFlight: ModelTransitionInFlight): Promise<void> {
		const timer = setTimeout(() => {
			this.warn(warningText.barrierTimeout(this.barrierTimeoutMs));
		}, this.barrierTimeoutMs);
		timer.unref?.();
		try {
			await inFlight.completionPromise;
		} finally {
			clearTimeout(timer);
		}
		// B1：已冻队列不应用 remaining、也不清在途引用——剩余部分归接力者
		// （下一个非冻队列看到同一个 completionPromise 已 settle 时直接应用）；
		// 否则冻队列会抢先写，且清掉引用后接力链断裂（remaining 永久丢失）。
		if (this.frozen) {
			return;
		}
		this.refreshModel(true);
		this.refreshThinking(true);
		const level = inFlight.remaining.thinking;
		if (level !== undefined) {
			this.applyBarrierThinking(inFlight.task, level);
		}
		if (inFlight.task.kind === "restore") {
			this.slots.delete(inFlight.task.epoch);
		}
		// 恰好一次：应用后清引用，后续快照不再携带（断链时剩余部分丢弃）。
		this.inFlight = null;
	}

	/**
	 * barrier 后的 thinking 收尾判定（与 switch/restore 常规路径同语义）：目标
	 * 二元组达标才应用——把 thinking 写到非基线模型上会给出错误的能力假设。
	 * 目标不可判定（跨版本 handoff 快照等防御路径）同样跳过 + warning。
	 */
	private applyBarrierThinking(task: ModelTransitionTask, level: string): void {
		const target = this.barrierModelTarget(task);
		if (target === undefined) {
			this.warn(warningText.thinkingSkippedUnknown(level));
			return;
		}
		if (!isSameIdentity(this.lastModel, target)) {
			this.warn(warningText.thinkingSkipped(level, target));
			return;
		}
		this.applyThinkingDimension(level);
	}

	/** 在途任务的目标模型（switch 原始串 / restore 槽位二元组）；不可判定时 undefined。 */
	private barrierModelTarget(task: ModelTransitionTask): ModelIdentity | undefined {
		if (task.kind === "switch") {
			return task.target.model !== undefined ? splitModelReference(task.target.model) : undefined;
		}
		return this.slots.get(task.epoch)?.values.model;
	}

	/** getter 校正记录（§6）：可观测则覆盖；不可观测保留记录并提示。 */
	private refreshModel(warnOnFailure: boolean): ModelIdentity | undefined {
		const observed = this.executor.getModelIdentity();
		if (observed !== undefined) {
			this.lastModel = observed;
			return observed;
		}
		if (warnOnFailure) {
			this.warn(warningText.observeFailed());
		}
		return undefined;
	}

	private refreshThinking(warnOnFailure: boolean): string | undefined {
		const observed = this.executor.getThinkingLevel();
		if (observed !== undefined) {
			this.lastThinking = observed;
			return observed;
		}
		if (warnOnFailure) {
			this.warn(warningText.observeFailed());
		}
		return undefined;
	}

	private warnSkippedThinking(level: string | undefined, target: ModelIdentity): void {
		if (level !== undefined) {
			this.warn(warningText.thinkingSkipped(level, target));
		}
	}

	private warn(message: string): void {
		this.executor.notifyWarning(message);
	}
}
