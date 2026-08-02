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
		// assertions), isolated per file (own agentDir/port/processes) — file-level
		// parallelism is safe (Arch 2026-08-02). 13 files / 8 workers = 2 batches
		// (~50-60s on idle 8-core); the #43 90s/120s margins stay as flake-proof
		// upper bounds, speed comes from parallelism + 25ms dense polling, not
		// from cutting margins. Load-related flake watch: if #32-era timeouts
		// reappear, step down to 4. QA owns this file.
		maxWorkers: 8,
	},
});
