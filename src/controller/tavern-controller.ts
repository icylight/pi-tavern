import { CharacterRuntime } from "../character/character-runtime.js";
import { JoinAttempt, type JoinAttemptOptions } from "../character/join-attempt.js";
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

export class TavernController {
	private state: TavernState = { type: "idle" };
	private transitionTail = Promise.resolve();
	private connectionToken: object | null = null;
	onStateChange: (() => void) | undefined;

	constructor(
		private readonly startCreator: TavernControllerCreatorStarter = (options) => CreatorRuntime.startNew(options),
		private readonly startJoin: TavernControllerJoinStarter = (descriptor, sessionId, options) =>
			JoinAttempt.connect(descriptor, sessionId, options),
		private readonly startResumeStarter: TavernControllerResumeStarter = (options) => CreatorRuntime.resume(options),
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
		pi?: import("@earendil-works/pi-coding-agent").ExtensionAPI,
	): Promise<CharacterRuntime> {
		return this.runTransition(async () => {
			if (this.state.type !== "joining") {
				throw new Error(ERROR_NOT_JOINING_GROUP_CHAT);
			}

			const attempt = this.state.attempt;
			try {
				const runtime = await attempt.claimCharacter(characterId, pi);
				this.setState({ type: "character", runtime });
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
	 * 并据此重建 controller 状态。
	 */
	async takeReloadHandoff(
		piSessionId: string,
		pi?: import("@earendil-works/pi-coding-agent").ExtensionAPI,
		notify?: (message: string) => void,
	): Promise<void> {
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
			await state.runtime.detachForReload(piSessionId);
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
		});
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
