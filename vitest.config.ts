import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// Process-level acceptance tests spawn real pi processes and run via
		// `npm run test:acceptance`; they are excluded from the fast daily run.
		exclude: ["test/acceptance/**"],
	},
});
