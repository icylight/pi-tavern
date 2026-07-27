import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	discoverAndLoadExtensions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import piTavern from "../src/index.js";

describe("PiTavern extension", () => {
	it("loads and reloads through the pi extension loader", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-tavern-m0-"));
		const extensionPath = resolve("src/index.ts");

		try {
			const firstLoad = await discoverAndLoadExtensions([extensionPath], process.cwd(), agentDir);
			expect(firstLoad.errors).toEqual([]);
			expect(firstLoad.extensions).toHaveLength(1);
			expect(firstLoad.extensions[0]?.commands.has("tavern-status")).toBe(true);

			const secondLoad = await discoverAndLoadExtensions([extensionPath], process.cwd(), agentDir);
			expect(secondLoad.errors).toEqual([]);
			expect(secondLoad.extensions).toHaveLength(1);
			expect(secondLoad.extensions[0]?.commands.has("tavern-status")).toBe(true);
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("registers an idle tavern-status command", async () => {
		const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
		const registerCommand = vi.fn((name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, command);
		});

		piTavern({ registerCommand } as unknown as ExtensionAPI);

		const status = commands.get("tavern-status");
		expect(status).toBeDefined();

		const notify = vi.fn();
		await status?.handler("", {
			hasUI: true,
			ui: { notify },
		} as unknown as ExtensionCommandContext);

		expect(notify).toHaveBeenCalledWith("No active group chat", "info");
	});
});
