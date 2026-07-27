import { describe, expect, it } from "vitest";

import { TavernController } from "../../src/controller/tavern-controller.js";

describe("TavernController", () => {
	it("starts idle", () => {
		const controller = new TavernController();

		expect(controller.getState()).toEqual({ type: "idle" });
	});
});
