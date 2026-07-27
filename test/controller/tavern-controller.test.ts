import { describe, expect, it, vi } from "vitest";
import { TavernController, type TavernControllerCreatorStarter } from "../../src/controller/tavern-controller.js";
import type { CreatorRuntime } from "../../src/creator/creator-runtime.js";

function createRuntime(): CreatorRuntime {
	return {
		close: vi.fn(async () => undefined),
	} as unknown as CreatorRuntime;
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
});
