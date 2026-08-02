import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// PITAVERN_TEST=1 内联：测试命令（tavern-test-message 等）仅在此时注册。
		// 此前只由 `npm run test:acceptance` 注入，裸跑 vitest 会静默假红
		// （命令未注册 → 30s 超时，QA 2026-08-02 实证踩坑），内联后两条路径一致。
		env: { PITAVERN_TEST: "1" },
		globalSetup: ["./test/acceptance/global-setup.ts"], // #45 P1：tsx 预热（冷 15s→热 4.6s，QA 2026-08-02）
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
		maxWorkers: 4,
	},
});
