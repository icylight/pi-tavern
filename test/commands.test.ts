import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { registerCommands } from "../src/commands.js";
import { TavernController } from "../src/controller/tavern-controller.js";
import type { CreatorRuntime } from "../src/creator/creator-runtime.js";
import { createGroupChatState } from "../src/creator/group-chat-state.js";

function createRuntime(): CreatorRuntime {
	const state = createGroupChatState({
		groupChatId: "group-1",
		createdAt: "2026-07-27T00:00:00.000Z",
		groupMaxMessages: 10,
	});

	return {
		state,
		activeDescriptor: {
			instanceId: "instance-1",
			groupChatId: "group-1",
			name: null,
			cwd: "/project",
			pid: 1234,
			host: "127.0.0.1",
			port: 54321,
			startedAt: "2026-07-27T00:00:00.000Z",
		},
		setName: vi.fn(async (name: string) => {
			const normalized = name.replace(/[\r\n]+/g, " ").trim() || null;
			state.groupChat.name = normalized;
			return normalized;
		}),
		setMaxMessages: vi.fn((maxMessages: number) => {
			state.groupChat.groupMaxMessages = maxMessages;
		}),
		close: vi.fn(async () => undefined),
	} as unknown as CreatorRuntime;
}

function register(controller: TavernController): Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">> {
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const pi = {
		registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI;
	registerCommands(pi, controller, { agentDir: "/isolated-agent" });
	return commands;
}

function createContext(): {
	context: ExtensionCommandContext;
	notify: ReturnType<typeof vi.fn>;
} {
	const notify = vi.fn();
	return {
		context: {
			cwd: "/project",
			hasUI: true,
			ui: { notify },
		} as unknown as ExtensionCommandContext,
		notify,
	};
}

describe("creator commands", () => {
	it("registers the M1 creator command set", () => {
		const commands = register(new TavernController());

		expect([...commands.keys()]).toEqual([
			"tavern-new",
			"tavern-status",
			"tavern-name",
			"tavern-set-max",
			"tavern-leave",
		]);
	});

	it("creates a group chat using the command cwd and isolated agent directory", async () => {
		const runtime = createRuntime();
		const starter = vi.fn(async () => runtime);
		const controller = new TavernController(starter);
		const commands = register(controller);
		const { context, notify } = createContext();

		await commands.get("tavern-new")?.handler("", context);

		expect(starter).toHaveBeenCalledWith({
			cwd: "/project",
			agentDir: "/isolated-agent",
			configMaxMessages: 10,
		});
		expect(controller.getState()).toEqual({ type: "creator", runtime });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("group-1"), "info");
	});

	it("shows authoritative creator status", async () => {
		const runtime = createRuntime();
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });
		const commands = register(controller);
		const { context, notify } = createContext();

		await commands.get("tavern-status")?.handler("", context);

		const message = notify.mock.calls[0]?.[0] as string;
		expect(message).toContain("group-1");
		expect(message).toContain("127.0.0.1:54321");
		expect(message).toContain("Online Characters: 0");
		expect(message).toContain("Group max messages: 10");
		expect(message).toContain("Round: not started");
	});

	it("updates the name and absolute group message limit", async () => {
		const runtime = createRuntime();
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });
		const commands = register(controller);
		const { context } = createContext();

		await commands.get("tavern-name")?.handler(" Architecture Review ", context);
		await commands.get("tavern-set-max")?.handler("14", context);

		expect(runtime.setName).toHaveBeenCalledWith("Architecture Review");
		expect(runtime.setMaxMessages).toHaveBeenCalledWith(14);
	});

	it("rejects relative or invalid message limits", async () => {
		const runtime = createRuntime();
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });
		const commands = register(controller);
		const { context, notify } = createContext();

		for (const input of ["+2", "-2", "1.5", "9007199254740992"]) {
			await commands.get("tavern-set-max")?.handler(input, context);
		}

		expect(runtime.setMaxMessages).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(4);
		for (const call of notify.mock.calls) {
			expect(call[1]).toBe("error");
		}
	});

	it("reports creator-only commands while idle and leaves idempotently", async () => {
		const runtime = createRuntime();
		const controller = new TavernController(async () => runtime);
		const commands = register(controller);
		const { context, notify } = createContext();

		await commands.get("tavern-name")?.handler("Name", context);
		await commands.get("tavern-set-max")?.handler("10", context);
		await commands.get("tavern-leave")?.handler("", context);
		expect(notify).toHaveBeenCalledWith("No active group chat", "info");

		await commands.get("tavern-new")?.handler("", context);
		await commands.get("tavern-leave")?.handler("", context);
		await commands.get("tavern-leave")?.handler("", context);

		expect(runtime.close).toHaveBeenCalledTimes(1);
		expect(controller.getState()).toEqual({ type: "idle" });
	});
});
