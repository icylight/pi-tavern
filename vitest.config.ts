import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// L1 unit/component layer — Dev owned (test boundary split 2026-08-02).
		// Component tests mirror src/ structure and run via `npm test` /
		// `npm run test:unit`. Integration (test/integration, QA owned) and
		// acceptance (test/acceptance, QA owned) run via their own configs.
		include: ["test/unit/**/*.test.ts"],
	},
});
