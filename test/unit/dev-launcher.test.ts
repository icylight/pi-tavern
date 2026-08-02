import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("development launcher", () => {
	it("isolates the agent directory and loads the workspace extension", async () => {
		const script = await readFile(resolve("scripts/pi-dev.sh"), "utf8");

		expect(script).toContain('PI_CODING_AGENT_DIR="$REPO_ROOT/.dev/pi-agent"');
		expect(script).toContain('"$REPO_ROOT/references/pi/pi-test.sh"');
		expect(script).toContain('-e "$REPO_ROOT/src/index.ts"');
	});
});
