import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// PITAVERN_TEST=1 内联：测试命令（tavern-test-message 等）仅在此时注册。
		// 此前只由 `npm run test:acceptance` 注入，裸跑 vitest 会静默假红
		// （命令未注册 → 30s 超时，实证踩坑），内联后两条路径一致。
		env: { PITAVERN_TEST: "1" },
		globalSetup: ["./test/acceptance/global-setup.ts"], // tsx 预热（冷 15s→热 4.6s）
		include: ["test/acceptance/**/*.test.ts"],
		testTimeout: 180_000,
		hookTimeout: 120_000,
		// Acceptance tests spawn real pi processes per worker (process-level
		// assertions), isolated per file (own agentDir/port/processes) — file-level
		// parallelism is safe. 19 files / 4 workers = 5 批；the 90s/120s margins stay
		// as flake-proof upper bounds, speed comes from parallelism + 25ms dense
		// polling, not from cutting margins. 2026-09-29 降档 8 → 4（实测：8 并发
		// 全量 2/2 红、单跑 3/3 绿、4 并发全量 39/39 绿；失败形态 = join/收件
		// 30s 超时在文件间轮换）。跨 run 互杀（globalSetup pkill 作用域，见 #191）
		// 另行防护：错峰约定——跑 acceptance 前群聊报备，不并行起同类运行。
		// QA owns this file.
		maxWorkers: 4,
	},
});
