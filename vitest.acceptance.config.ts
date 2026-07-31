import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/acceptance/**/*.test.ts"],
		testTimeout: 180_000,
		hookTimeout: 120_000,
	},
});
