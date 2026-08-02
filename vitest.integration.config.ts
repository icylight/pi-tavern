import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// L2 integration layer — QA owned (test boundary split 2026-08-02).
		// In-process integration tests start real WebSocket servers; run via
		// `npm run test:integration` or as part of `npm run test:qa`.
		include: ["test/integration/**/*.test.ts"],
	},
});
