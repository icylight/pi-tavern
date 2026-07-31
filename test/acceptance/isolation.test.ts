import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PiProcess } from "./pi-process.js";

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

describe("acceptance: a developer pi's activity does not pollute the daily pi", () => {
	let root: string;
	let projectDir: string;
	const processes: PiProcess[] = [];

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-tavern-acc-isolate-"));
		projectDir = join(root, "project");
		await mkdir(projectDir, { recursive: true });
	});

	afterAll(async () => {
		for (const process_ of processes) {
			await process_.kill("SIGTERM");
		}
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
	});

	it("keeps every tavern artifact inside the developer agent dir", async () => {
		const homeDir = join(root, "fake-home"); // stands in for the daily pi's home
		const devAgentDir = join(root, "dev-agent");
		const projectFilesBefore = await readdir(projectDir).catch(() => []);

		const dev = PiProcess.spawn({
			label: "dev",
			agentDir: devAgentDir,
			sessionDir: join(devAgentDir, "sessions"),
			cwd: projectDir,
			// Override HOME so the pi's default agent dir is isolated from the
			// developer agent dir we configured explicitly.
			env: { HOME: homeDir },
		});
		processes.push(dev);

		const descriptor = await dev.startGroupChat(projectDir, devAgentDir);
		await dev.runCommand("/tavern-test-message Hello");
		await dev.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);
		await dev.runCommand("/tavern-leave");

		// The group chat record lives under the developer agent dir.
		const chatsDir = join(devAgentDir, "tavern");
		expect(await exists(chatsDir)).toBe(true);
		const tavernFiles = await readdir(chatsDir, { recursive: true });
		expect(tavernFiles.some((f) => f.endsWith(".jsonl"))).toBe(true);
		expect(descriptor.port).toBeGreaterThan(0);

		// Nothing was written into the daily pi's home directory.
		const homePiDir = join(homeDir, ".pi");
		const homeContents = (await readdir(homePiDir, { recursive: true }).catch(() => [])) as string[];
		expect(homeContents.some((f) => f.includes("tavern"))).toBe(false);

		// The project directory was not modified (config files are read-only inputs).
		const projectFilesAfter = await readdir(projectDir).catch(() => []);
		expect(projectFilesAfter).toEqual(projectFilesBefore);
	}, 120_000);
});
