import { CharacterRuntime } from "../character/character-runtime.js";
import { JoinAttempt, type JoinAttemptOptions } from "../character/join-attempt.js";
import {
	CreatorRuntime,
	type ResumeCreatorRuntimeOptions,
	type StartNewCreatorRuntimeOptions,
} from "../creator/creator-runtime.js";
import type { ActiveGroupChatDescriptor } from "../data/discovery/active-descriptor.js";
import { getReloadHandoffRegistry } from "./reload-handoff-registry.js";

export type TavernState =
	| { type: "idle" }
	| { type: "joining"; attempt: JoinAttempt }
	| { type: "creator"; runtime: CreatorRuntime }
	| { type: "character"; runtime: CharacterRuntime };

export type TavernControllerCreatorStarter = (options: StartNewCreatorRuntimeOptions) => Promise<CreatorRuntime>;
export type TavernControllerResumeStarter = (options: ResumeCreatorRuntimeOptions) => Promise<CreatorRuntime>;
export type TavernControllerJoinStarter = (
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
				throw new Error("This pi session is already bound to a group chat; leave it first");
			}

			const runtime = await this.startCreator(options);
			this.setState({ type: "creator", runtime });
			return runtime;
		});
	}

	startResume(options: ResumeCreatorRuntimeOptions): Promise<CreatorRuntime> {
		return this.runTransition(async () => {
			if (this.state.type !== "idle") {
				throw new Error("This pi session is already bound to a group chat; leave it first");
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
				throw new Error("This pi session is already bound to a group chat; leave it first");
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
				throw new Error("This pi session is not joining a group chat");
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
				throw new Error("This command is only available to the group chat creator");
			}
			return this.state.runtime.setName(name);
		});
	}

	setMaxMessages(maxMessages: number): Promise<void> {
		return this.runTransition(async () => {
			if (this.state.type !== "creator") {
				throw new Error("This command is only available to the group chat creator");
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
	 * Confirmation gate for /new, /resume, /fork and /clone while bound to a
	 * group chat. Idle passes through immediately. A cancelled confirmation
	 * keeps the current runtime; a confirmed one exits first (never rolled
	 * back) and then lets the native pi session operation continue.
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
	 * session_shutdown: reload detaches and publishes a handoff (joining is
	 * closed and restarts idle); every other reason performs the unified
	 * permanent cleanup before pi continues to exit.
	 */
	async handleSessionShutdown(reason: string, piSessionId: string): Promise<void> {
		if (reason === "reload") {
			await this.detachForReload(piSessionId);
			return;
		}
		await this.leave();
	}

	/**
	 * Take a reload handoff published by the previous Extension Runtime of the
	 * same pi session and rebuild the controller state from it.
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
			// joining does not participate in reload handoff: close the join
			// connection, release any Character reservation, restart idle.
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
