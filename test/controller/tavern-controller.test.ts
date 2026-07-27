import { describe, expect, it, vi } from "vitest";
import type { CharacterRuntime } from "../../src/character/character-runtime.js";
import type { JoinAttempt } from "../../src/character/join-attempt.js";
import { TavernController, type TavernControllerCreatorStarter } from "../../src/controller/tavern-controller.js";
import type { CreatorRuntime } from "../../src/creator/creator-runtime.js";

function createRuntime(): CreatorRuntime {
	return {
		close: vi.fn(async () => undefined),
	} as unknown as CreatorRuntime;
}

function createJoinAttempt(characterRuntime: CharacterRuntime): JoinAttempt {
	return {
		availableCharacters: [],
		isActive: true,
		claimCharacter: vi.fn(async () => characterRuntime),
		close: vi.fn(async () => undefined),
	} as unknown as JoinAttempt;
}

function createCharacterRuntime(): CharacterRuntime {
	return {
		close: vi.fn(async () => undefined),
	} as unknown as CharacterRuntime;
}

describe("TavernController", () => {
	it("starts idle", () => {
		const controller = new TavernController();

		expect(controller.getState()).toEqual({ type: "idle" });
	});

	it("commits creator state only after startup succeeds", async () => {
		const runtime = createRuntime();
		let finishStarting: ((runtime: CreatorRuntime) => void) | undefined;
		const starter: TavernControllerCreatorStarter = () =>
			new Promise((resolve) => {
				finishStarting = resolve;
			});
		const controller = new TavernController(starter);
		const startPromise = controller.startNew({ cwd: "/project", agentDir: "/agent" });

		expect(controller.getState()).toEqual({ type: "idle" });
		await vi.waitFor(() => expect(finishStarting).toBeTypeOf("function"));
		finishStarting?.(runtime);
		await expect(startPromise).resolves.toBe(runtime);
		expect(controller.getState()).toEqual({ type: "creator", runtime });
	});

	it("stays idle when creator startup fails", async () => {
		const controller = new TavernController(async () => {
			throw new Error("startup failed");
		});

		await expect(controller.startNew({ cwd: "/project", agentDir: "/agent" })).rejects.toThrow("startup failed");
		expect(controller.getState()).toEqual({ type: "idle" });
	});

	it("rejects starting another group chat while one is active", async () => {
		const runtime = createRuntime();
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });

		await expect(controller.startNew({ cwd: "/project", agentDir: "/agent" })).rejects.toThrow(
			"already bound to a group chat",
		);
	});

	it("leaves creator state idempotently and returns to idle", async () => {
		const runtime = createRuntime();
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });

		await controller.leave();
		await controller.leave();

		expect(runtime.close).toHaveBeenCalledTimes(1);
		expect(controller.getState()).toEqual({ type: "idle" });
	});

	it("returns to idle even when runtime cleanup reports an error", async () => {
		const runtime = createRuntime();
		vi.mocked(runtime.close).mockRejectedValue(new Error("cleanup failed"));
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });

		await expect(controller.leave()).rejects.toThrow("cleanup failed");
		expect(controller.getState()).toEqual({ type: "idle" });
	});

	it("serializes creator metadata updates before leave", async () => {
		const runtime = createRuntime();
		let finishNaming: (() => void) | undefined;
		runtime.setName = vi.fn(
			() =>
				new Promise<string | null>((resolve) => {
					finishNaming = () => resolve("Architecture");
				}),
		);
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });

		const namingPromise = controller.setName("Architecture");
		await vi.waitFor(() => expect(finishNaming).toBeTypeOf("function"));
		const leavePromise = controller.leave();

		expect(runtime.close).not.toHaveBeenCalled();
		finishNaming?.();
		await expect(namingPromise).resolves.toBe("Architecture");
		await leavePromise;
		expect(runtime.close).toHaveBeenCalledTimes(1);
		expect(controller.getState()).toEqual({ type: "idle" });
	});

	it("commits joining and character states only after each stage succeeds", async () => {
		const characterRuntime = createCharacterRuntime();
		const attempt = createJoinAttempt(characterRuntime);
		const joinStarter = vi.fn(async () => attempt);
		const controller = new TavernController(undefined, joinStarter);

		await expect(
			controller.startJoining(
				{
					instanceId: "instance-1",
					groupChatId: "group-1",
					name: null,
					cwd: "/project",
					pid: 1234,
					host: "127.0.0.1",
					port: 54321,
					startedAt: "2026-07-27T00:00:00.000Z",
				},
				"session-1",
			),
		).resolves.toBe(attempt);
		expect(controller.getState()).toEqual({ type: "joining", attempt });

		await expect(controller.claimCharacter("architect")).resolves.toBe(characterRuntime);
		expect(controller.getState()).toEqual({
			type: "character",
			runtime: characterRuntime,
		});
	});

	it("keeps joining on a retryable claim conflict but returns idle after a fatal claim failure", async () => {
		const characterRuntime = createCharacterRuntime();
		const attempt = createJoinAttempt(characterRuntime);
		vi.mocked(attempt.claimCharacter).mockRejectedValueOnce(new Error("Character is no longer available"));
		const controller = new TavernController(undefined, async () => attempt);
		await controller.startJoining(
			{
				instanceId: "instance-1",
				groupChatId: "group-1",
				name: null,
				cwd: "/project",
				pid: 1234,
				host: "127.0.0.1",
				port: 54321,
				startedAt: "2026-07-27T00:00:00.000Z",
			},
			"session-1",
		);

		await expect(controller.claimCharacter("architect")).rejects.toThrow("no longer available");
		expect(controller.getState()).toEqual({ type: "joining", attempt });

		Object.defineProperty(attempt, "isActive", { value: false });
		vi.mocked(attempt.claimCharacter).mockRejectedValueOnce(new Error("local load failed"));
		await expect(controller.claimCharacter("architect")).rejects.toThrow("local load failed");
		expect(controller.getState()).toEqual({ type: "idle" });
	});

	it("leaves joining and character owners through the same transition", async () => {
		const characterRuntime = createCharacterRuntime();
		const attempt = createJoinAttempt(characterRuntime);
		const controller = new TavernController(undefined, async () => attempt);
		const descriptor = {
			instanceId: "instance-1",
			groupChatId: "group-1",
			name: null,
			cwd: "/project",
			pid: 1234,
			host: "127.0.0.1" as const,
			port: 54321,
			startedAt: "2026-07-27T00:00:00.000Z",
		};

		await controller.startJoining(descriptor, "session-1");
		await controller.leave();
		expect(attempt.close).toHaveBeenCalledTimes(1);
		expect(controller.getState()).toEqual({ type: "idle" });

		await controller.startJoining(descriptor, "session-1");
		await controller.claimCharacter("architect");
		await controller.leave();
		expect(characterRuntime.close).toHaveBeenCalledTimes(1);
		expect(controller.getState()).toEqual({ type: "idle" });
	});
});
