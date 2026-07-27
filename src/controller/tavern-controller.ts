import { CreatorRuntime, type StartNewCreatorRuntimeOptions } from "../creator/creator-runtime.js";

export type TavernState = { type: "idle" } | { type: "creator"; runtime: CreatorRuntime };

export type TavernControllerCreatorStarter = (options: StartNewCreatorRuntimeOptions) => Promise<CreatorRuntime>;

export class TavernController {
	private state: TavernState = { type: "idle" };
	private transitionTail = Promise.resolve();

	constructor(
		private readonly startCreator: TavernControllerCreatorStarter = (options) => CreatorRuntime.startNew(options),
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
			this.state = { type: "creator", runtime };
			return runtime;
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
			this.state.runtime.setMaxMessages(maxMessages);
		});
	}

	leave(): Promise<void> {
		return this.runTransition(async () => {
			if (this.state.type === "idle") {
				return;
			}

			const runtime = this.state.runtime;
			try {
				await runtime.close();
			} finally {
				this.state = { type: "idle" };
			}
		});
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
