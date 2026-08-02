import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/acceptance/**/*.test.ts"],
		testTimeout: 180_000,
		hookTimeout: 120_000,
		// Acceptance tests spawn real pi processes per worker (process-level
		// assertions). Default parallelism = CPU core count (8 workers × ~100%
		// each on this machine) makes the suite hog the box during dev/group
		// chat usage. Capping to 2 workers cuts peak CPU ~4x at the cost of a
		// longer run (~2-4 min vs ~1 min); it also reduces load-related flaky
		// timeouts (see #32). QA owns this file; change authorized by PM
		// 2026-08-02, QA regression review pending.
		maxWorkers: 2,
	},
});
