import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CharacterRuntime } from "../character/character-runtime.js";
import { JoinAttempt, type JoinAttemptOptions } from "../character/join-attempt.js";
import { planModelProfile } from "../character/model-profile.js";
import {
	type ModelIdentity,
	type ModelTransitionExecutor,
	ModelTransitionQueue,
	type ModelTransitionSnapshot,
} from "../character/model-transition-queue.js";
import type { CharacterCard } from "../config/character-card.js";
import {
	CreatorRuntime,
	type ResumeCreatorRuntimeOptions,
	type StartNewCreatorRuntimeOptions,
} from "../creator/creator-runtime.js";
import type { ActiveGroupChatDescriptor } from "../data/discovery/active-descriptor.js";
import {
	ERROR_ALREADY_BOUND_TO_GROUP_CHAT,
	ERROR_CREATOR_ONLY,
	ERROR_NOT_JOINING_GROUP_CHAT,
} from "../shared/messages.js";
import { getReloadHandoffRegistry } from "./reload-handoff-registry.js";

type TavernState =
	| { type: "idle" }
	| { type: "joining"; attempt: JoinAttempt }
	| { type: "creator"; runtime: CreatorRuntime }
	| { type: "character"; runtime: CharacterRuntime };

export type TavernControllerCreatorStarter = (options: StartNewCreatorRuntimeOptions) => Promise<CreatorRuntime>;
type TavernControllerResumeStarter = (options: ResumeCreatorRuntimeOptions) => Promise<CreatorRuntime>;
type TavernControllerJoinStarter = (
	descriptor: ActiveGroupChatDescriptor,
	sessionId: string,
	options: JoinAttemptOptions,
) => Promise<JoinAttempt>;

/**
 * model hook 执行器装配工厂（adapter 装配、controller 持有），#180：
 * 注入缺省 = 功能关闭（测试与旧组合根行为零变化）。notify 为单一 warning
 * 通道（入口适配：命令路径 ctx.ui.notify / headless stderr）。
 */
export type ModelTransitionExecutorFactory = (
	pi: ExtensionAPI,
	notifyWarning: (message: string) => void,
) => ModelTransitionExecutor;

export class TavernController {
	private state: TavernState = { type: "idle" };
	private transitionTail = Promise.resolve();
	private connectionToken: object | null = null;
	onStateChange: (() => void) | undefined;
	/**
	 * #180 模型转换队列：单实例跨 join 轮次（leave 提交的 restore 先于下一轮
	 * capture，FIFO 屏障防瞬态 profile 被误存为基线）；懒创建——首轮配置了
	 * model/thinking 才建，reload 后由 handoff 快照 rehydrate。
	 */
	private modelQueue: ModelTransitionQueue | undefined;
	/** 轮次计数：reload 后从快照 activeEpoch/slots 取 max 续算，不回退重用 epoch。 */
	private modelHookEpoch = 0;
	/** 本轮（Character 态）epoch；离开路径据此提交 restore，null = 不在轮内。 */
	private modelHookActiveEpoch: number | null = null;

	constructor(
		private readonly startCreator: TavernControllerCreatorStarter = (options) => CreatorRuntime.startNew(options),
		private readonly startJoin: TavernControllerJoinStarter = (descriptor, sessionId, options) =>
			JoinAttempt.connect(descriptor, sessionId, options),
		private readonly startResumeStarter: TavernControllerResumeStarter = (options) => CreatorRuntime.resume(options),
		private readonly createModelExecutor?: ModelTransitionExecutorFactory,
	) {}

	getState(): TavernState {
		return this.state;
	}

	startNew(options: StartNewCreatorRuntimeOptions): Promise<CreatorRuntime> {
		return this.runTransition(async () => {
			if (this.state.type !== "idle") {
				throw new Error(ERROR_ALREADY_BOUND_TO_GROUP_CHAT);
			}

			const runtime = await this.startCreator(options);
			this.setState({ type: "creator", runtime });
			return runtime;
		});
	}

	startResume(options: ResumeCreatorRuntimeOptions): Promise<CreatorRuntime> {
		return this.runTransition(async () => {
			if (this.state.type !== "idle") {
				throw new Error(ERROR_ALREADY_BOUND_TO_GROUP_CHAT);
			}

			const runtime = await this.startResumeStarter(options);
			this.setState({ type: "creator", runtime });
			return runtime;
		});
	}

	startJoining(
		descriptor: ActiveGroupChatDescriptor,
		sessionId: string,
		options: JoinAttemptOptions = {},
	): Promise<JoinAttempt> {
		return this.runTransition(async () => {
			if (this.state.type !== "idle") {
				throw new Error(ERROR_ALREADY_BOUND_TO_GROUP_CHAT);
			}

			const token = {};
			const attempt = await this.startJoin(descriptor, sessionId, {
				...(options.cursorStorePath !== undefined ? { cursorStorePath: options.cursorStorePath } : {}),
				...(options.messageTemplates !== undefined ? { messageTemplates: options.messageTemplates } : {}),
				...(options.speakSoftLimitChars !== undefined ? { speakSoftLimitChars: options.speakSoftLimitChars } : {}),
				//  路径透传到 runtime，reload 才能重读磁盘配置（缺此转发则 reload 不做配置加载）。
				...(options.agentDir !== undefined ? { agentDir: options.agentDir } : {}),
				...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
				onDisconnected: () => {
					void this.handleConnectionClosed(token);
				},
			});
			this.connectionToken = token;
			this.setState({ type: "joining", attempt });
			return attempt;
		});
	}

	claimCharacter(
		characterId: string,
		pi?: ExtensionAPI,
		notifyWarning?: (message: string) => void,
	): Promise<CharacterRuntime> {
		return this.runTransition(async () => {
			if (this.state.type !== "joining") {
				throw new Error(ERROR_NOT_JOINING_GROUP_CHAT);
			}

			const attempt = this.state.attempt;
			try {
				const runtime = await attempt.claimCharacter(characterId, pi);
				this.setState({ type: "character", runtime });
				this.beginModelProfile(runtime.character, pi, notifyWarning);
				return runtime;
			} catch (error) {
				if (!attempt.isActive) {
					this.connectionToken = null;
					this.setState({ type: "idle" });
				}
				throw error;
			}
		});
	}

	setName(name: string): Promise<string | null> {
		return this.runTransition(async () => {
			if (this.state.type !== "creator") {
				throw new Error(ERROR_CREATOR_ONLY);
			}
			return this.state.runtime.setName(name);
		});
	}

	setMaxMessages(maxMessages: number): Promise<void> {
		return this.runTransition(async () => {
			if (this.state.type !== "creator") {
				throw new Error(ERROR_CREATOR_ONLY);
			}
			await this.state.runtime.setMaxMessages(maxMessages);
		});
	}

	leave(): Promise<void> {
		return this.runTransition(async () => {
			if (this.state.type === "idle") {
				return;
			}

			const owner = this.state.type === "joining" ? this.state.attempt : this.state.runtime;
			try {
				await owner.close();
			} finally {
				this.connectionToken = null;
				this.setState({ type: "idle" });
				// 离开 Character 态 = 提交本轮 restore（§3/§5）：提交先于下一轮
				// capture（transition 串行 + 队列 FIFO 双保险），执行 async best-effort。
				this.endModelProfile();
			}
		});
	}

	/**
	 * 绑定群聊时 /new、/resume、/fork、/clone 的确认门。idle 直接放行。
	 * 取消确认 = 保留当前 runtime；确认 = 先退出（绝不回退）再让原生 pi
	 * 会话操作继续。
	 */
	async prepareForSessionOperation(confirm: () => Promise<boolean>): Promise<{ cancel: boolean }> {
		if (this.state.type === "idle") {
			return { cancel: false };
		}
		const confirmed = await confirm();
		if (!confirmed) {
			return { cancel: true };
		}
		await this.leave();
		return { cancel: false };
	}

	/**
	 * session_shutdown：reload 会拆离并发布交接（joining 被关闭并重启回
	 * idle）；其余原因在 pi 继续退出前执行统一的永久清理。
	 */
	async handleSessionShutdown(reason: string, piSessionId: string): Promise<void> {
		if (reason === "reload") {
			await this.detachForReload(piSessionId);
			return;
		}
		await this.leave();
	}

	/**
	 * 接管同一 pi session 的旧 Extension Runtime 发布的 reload 交接，
	 * 并据此重建 controller 状态（含 model hook 队列 rehydrate）。
	 */
	async takeReloadHandoff(piSessionId: string, pi?: ExtensionAPI, notify?: (message: string) => void): Promise<void> {
		const handoff = getReloadHandoffRegistry().take(piSessionId);
		if (!handoff) {
			return;
		}
		await this.runTransition(async () => {
			if (handoff.kind === "creator") {
				const runtime = await CreatorRuntime.takeHandoff(handoff);
				this.setState({ type: "creator", runtime });
			} else {
				const runtime = await CharacterRuntime.takeHandoff(handoff, pi, notify);
				this.setState({ type: "character", runtime });
				this.adoptModelProfile(handoff.modelTransition, pi, notify);
			}
		});
	}

	private async detachForReload(piSessionId: string): Promise<void> {
		const state = this.state;
		if (state.type === "joining") {
			// joining 不参与 reload 交接：关闭 join 连接、
			// 释放角色预留、重启回 idle。
			await state.attempt.close();
			this.connectionToken = null;
			this.setState({ type: "idle" });
			return;
		}
		if (state.type === "creator") {
			await state.runtime.detachForReload(piSessionId);
			return;
		}
		if (state.type === "character") {
			// 单一快照来源（契约 §8 调用约定）：每次 handoff 只对当前活跃队列
			// freeze + snapshot 一次；已冻结旧队列不得再次快照——其 inFlight
			// 的 remaining 会被接力 barrier 重复应用。
			const snapshot = this.freezeModelProfile();
			await state.runtime.detachForReload(piSessionId, snapshot);
			return;
		}
	}

	private handleConnectionClosed(token: object): Promise<void> {
		return this.runTransition(async () => {
			if (this.connectionToken !== token) {
				return;
			}
			this.connectionToken = null;
			this.setState({ type: "idle" });
			// 断线回 idle = 离开（§3 定案）：提交本轮 restore。
			this.endModelProfile();
		});
	}

	/** 外部模型事件（手动换模型/强度）校正队列记录（§6）；无队列时 no-op。 */
	noteModelIdentity(identity: ModelIdentity | undefined): void {
		this.modelQueue?.noteModelIdentity(identity);
	}

	/** 外部 thinking 事件校正队列记录（§6）；无队列时 no-op。 */
	noteThinkingLevel(level: string | undefined): void {
		this.modelQueue?.noteThinkingLevel(level);
	}

	/**
	 * 进入 Character 态：按角色卡 profile 提交 capture + switch（§7/§11）。
	 * 未配置维度完全不进队列（行为不变）；invalid 维度只提示不提交；
	 * 队列执行 async best-effort，失败只经 warning 通道，不阻塞加入。
	 */
	private beginModelProfile(
		card: CharacterCard | undefined,
		pi: ExtensionAPI | undefined,
		notifyWarning: ((message: string) => void) | undefined,
	): void {
		// 旧测试替身可不带 character 字段；无卡 = 无 profile 可提交（生产路径恒有卡）。
		if (card === undefined) {
			return;
		}
		const plan = planModelProfile(card);
		if (plan.mask.model || plan.mask.thinking) {
			const queue = this.ensureModelQueue(pi, notifyWarning);
			if (queue !== undefined) {
				const epoch = ++this.modelHookEpoch;
				this.modelHookActiveEpoch = epoch;
				queue.submitCapture(epoch, plan.mask);
				queue.submitSwitch(epoch, plan.target);
			}
		}
		for (const warning of plan.warnings) {
			notifyWarning?.(warning);
		}
	}

	/** 离开 Character 态（主动 leave / 断线回 idle）：提交本轮 restore。 */
	private endModelProfile(): void {
		const epoch = this.modelHookActiveEpoch;
		if (epoch === null || this.modelQueue === undefined) {
			return;
		}
		this.modelQueue.submitRestore(epoch);
		this.modelHookActiveEpoch = null;
	}

	/** reload 拆离：freeze + 快照（恰一次），随 handoff 交接给新 runtime。 */
	private freezeModelProfile(): ModelTransitionSnapshot | undefined {
		if (this.modelQueue === undefined) {
			return undefined;
		}
		this.modelQueue.freeze();
		return this.modelQueue.snapshot();
	}

	/** reload 接管：用新 pi 组装的执行器重建队列，续算 epoch 并恢复本轮引用。 */
	private adoptModelProfile(
		snapshot: ModelTransitionSnapshot | undefined,
		pi: ExtensionAPI | undefined,
		notify: ((message: string) => void) | undefined,
	): void {
		if (snapshot === undefined || this.createModelExecutor === undefined || pi === undefined) {
			return;
		}
		this.modelQueue = ModelTransitionQueue.rehydrate(
			snapshot,
			this.createModelExecutor(pi, notify ?? (() => undefined)),
		);
		this.modelHookEpoch = Math.max(this.modelHookEpoch, snapshot.activeEpoch ?? 0, ...snapshot.slots.keys());
		this.modelHookActiveEpoch = snapshot.activeEpoch;
	}

	private ensureModelQueue(
		pi: ExtensionAPI | undefined,
		notifyWarning: ((message: string) => void) | undefined,
	): ModelTransitionQueue | undefined {
		if (this.modelQueue !== undefined) {
			return this.modelQueue;
		}
		if (this.createModelExecutor === undefined || pi === undefined) {
			return undefined;
		}
		this.modelQueue = new ModelTransitionQueue(this.createModelExecutor(pi, notifyWarning ?? (() => undefined)));
		return this.modelQueue;
	}

	private setState(state: TavernState): void {
		this.state = state;
		this.onStateChange?.();
	}

	private async runTransition<T>(operation: () => Promise<T>): Promise<T> {
		const previousTransition = this.transitionTail;
		let releaseTransition: () => void = () => undefined;
		this.transitionTail = new Promise<void>((resolve) => {
			releaseTransition = resolve;
		});

		await previousTransition;
		try {
			return await operation();
		} finally {
			releaseTransition();
		}
	}
}
