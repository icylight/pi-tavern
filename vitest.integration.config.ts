import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// L2 integration layer — Arch owned.
		// In-process integration tests start real WebSocket servers; run via
		// `npm run test:integration` or as part of `npm run test:qa`.
		include: ["test/integration/**/*.test.ts"],
	},
});
