import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CharacterRuntime } from "../../src/character/character-runtime.js";
import type { JoinAttempt } from "../../src/character/join-attempt.js";
import { registerCommands } from "../../src/commands.js";
import type { CharacterCard } from "../../src/config/character-card.js";
import { TavernController } from "../../src/controller/tavern-controller.js";
import type { CreatorRuntime } from "../../src/creator/creator-runtime.js";
import { createGroupChatState } from "../../src/creator/group-chat-state.js";
import type { ActiveGroupChatDescriptor } from "../../src/discovery/active-descriptor.js";

const descriptor: ActiveGroupChatDescriptor = {
	instanceId: "instance-1",
	groupChatId: "group-1",
	name: "Architecture",
	cwd: "/project",
	pid: 1234,
	host: "127.0.0.1",
	port: 54321,
	startedAt: "2026-07-27T00:00:00.000Z",
};

function createRuntime(): CreatorRuntime {
	const state = createGroupChatState({
		groupChatId: "group-1",
		createdAt: "2026-07-27T00:00:00.000Z",
		groupMaxMessages: 10,
	});

	return {
		configMaxMessages: 12,
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
		setMaxMessages: vi.fn(async (maxMessages: number) => {
			state.groupChat.groupMaxMessages = maxMessages;
		}),
		close: vi.fn(async () => undefined),
	} as unknown as CreatorRuntime;
}

function register(
	controller: TavernController,
	overrides: Parameters<typeof registerCommands>[2] = {},
): Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">> {
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const pi = {
		registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI;
	registerCommands(pi, controller, {
		agentDir: "/isolated-agent",
		...overrides,
	});
	return commands;
}

function createContext(): {
	context: ExtensionCommandContext;
	notify: ReturnType<typeof vi.fn>;
	select: ReturnType<typeof vi.fn>;
	confirm: ReturnType<typeof vi.fn>;
} {
	const notify = vi.fn();
	const select = vi.fn();
	const confirm = vi.fn(async () => true);
	return {
		context: {
			cwd: "/project",
			hasUI: true,
			ui: { notify, select, confirm },
			sessionManager: { getSessionId: () => "session-1" },
		} as unknown as ExtensionCommandContext,
		notify,
		select,
		confirm,
	};
}

describe("PiTavern commands", () => {
	it("registers the M2 command set", () => {
		// Isolate from PITAVERN_TEST env leakage — test-only commands
		// (tavern-test-*) are conditionally registered and should not
		// appear in the base command set assertion.
		const saved = process.env.PITAVERN_TEST;
		delete process.env.PITAVERN_TEST;
		try {
			const commands = register(new TavernController());

			expect([...commands.keys()]).toEqual([
				"tavern-new",
				"tavern-resume",
				"tavern-join",
				"tavern-status",
				"tavern-name",
				"tavern-set-max",
				"tavern-leave",
			]);
		} finally {
			if (saved !== undefined) process.env.PITAVERN_TEST = saved;
		}
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
			configMaxMessages: 20,
			characters: [],
		});
		expect(controller.getState()).toEqual({ type: "creator", runtime });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("group-1"), "info");
	});

	it("loads the merged config snapshot when creating a group chat", async () => {
		const runtime = createRuntime();
		const starter = vi.fn(async () => runtime);
		const controller = new TavernController(starter);
		const character = {
			characterId: "architect.md",
			name: "Architect",
			description: "Architecture",
			path: "/architect.md",
			prompt: "Prompt",
		} satisfies CharacterCard;
		const commands = register(controller, {
			loadConfig: vi.fn(async () => ({
				configMaxMessages: 18,
				characters: [character],
			})),
		});
		const { context } = createContext();

		await commands.get("tavern-new")?.handler("", context);

		expect(starter).toHaveBeenCalledWith({
			cwd: "/project",
			agentDir: "/isolated-agent",
			configMaxMessages: 18,
			characters: [character],
		});
	});

	it("discovers one group chat and selects a Character before committing character state", async () => {
		const characterRuntime = {
			character: { name: "Architect" },
			close: vi.fn(async () => undefined),
			getGroupChatState: vi.fn(),
		} as unknown as CharacterRuntime;
		const attempt = {
			availableCharacters: [
				{
					character_id: "architect.md",
					name: "Architect",
					description: "Architecture",
				},
			],
			isActive: true,
			claimCharacter: vi.fn(async () => characterRuntime),
			close: vi.fn(async () => undefined),
		} as unknown as JoinAttempt;
		const joinStarter = vi.fn(async () => attempt);
		const controller = new TavernController(undefined, joinStarter);
		const commands = register(controller, {
			discoverGroupChats: vi.fn(async () => [descriptor]),
		});
		const { context, notify } = createContext();
		vi.mocked(context.ui.select).mockResolvedValue("Architect — Architecture");

		await commands.get("tavern-join")?.handler("", context);

		expect(joinStarter).toHaveBeenCalledWith(
			descriptor,
			"session-1",
			expect.objectContaining({ onDisconnected: expect.any(Function) }),
		);
		expect(attempt.claimCharacter).toHaveBeenCalledWith("architect.md", expect.any(Object));
		expect(controller.getState()).toEqual({
			type: "character",
			runtime: characterRuntime,
		});
		expect(notify).toHaveBeenCalledWith("Joined Architecture as Architect", "info");
	});

	it("reports no discoverable group chat without entering joining", async () => {
		const controller = new TavernController();
		const commands = register(controller, {
			discoverGroupChats: vi.fn(async () => []),
		});
		const { context, notify } = createContext();

		await commands.get("tavern-join")?.handler("", context);

		expect(controller.getState()).toEqual({ type: "idle" });
		expect(notify).toHaveBeenCalledWith("No active group chat found for this project", "info");
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
		expect(message).toContain("Config max messages: 12");
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

	it("resumes a selected group chat with its session path", async () => {
		const runtime = createRuntime();
		const resumeStarter = vi.fn(async () => runtime);
		const controller = new TavernController(undefined, undefined, resumeStarter);
		const commands = register(controller, {
			listGroupChatSessions: vi.fn(async () => [
				{
					path: "/isolated-agent/chats/old.jsonl",
					groupChatId: "group-old",
					name: null,
					firstMessage: "User Persona:\nLet's design",
					created: new Date("2026-07-01T00:00:00.000Z"),
					active: false,
				},
			]),
		});
		const { context, select } = createContext();
		select.mockResolvedValue("Let's design (2026-07-01)");

		await commands.get("tavern-resume")?.handler("", context);

		expect(resumeStarter).toHaveBeenCalledWith({
			cwd: "/project",
			agentDir: "/isolated-agent",
			sessionPath: "/isolated-agent/chats/old.jsonl",
			configMaxMessages: 20,
			characters: [],
		});
		expect(controller.getState()).toEqual({ type: "creator", runtime });
	});

	it("excludes active group chats from the resume list", async () => {
		const controller = new TavernController();
		const commands = register(controller, {
			listGroupChatSessions: vi.fn(async () => [
				{
					path: "/isolated-agent/chats/active.jsonl",
					groupChatId: "group-active",
					name: "Active Chat",
					firstMessage: "",
					created: new Date("2026-07-01T00:00:00.000Z"),
					active: true,
				},
				{
					path: "/isolated-agent/chats/old.jsonl",
					groupChatId: "group-old",
					name: "Old Chat",
					firstMessage: "",
					created: new Date("2026-07-02T00:00:00.000Z"),
					active: false,
				},
			]),
		});
		const { context, select } = createContext();
		select.mockResolvedValue("Old Chat (2026-07-02)");

		await commands.get("tavern-resume")?.handler("", context);

		const options = select.mock.calls[0]?.[1] as string[];
		expect(options.some((option) => option.includes("Active Chat"))).toBe(false);
		expect(options.some((option) => option.includes("Old Chat"))).toBe(true);
		expect(select.mock.calls[0]?.[0]).toBe("Resume group chat:");
	});

	it("deletes a group chat history after confirmation", async () => {
		const controller = new TavernController();
		const deleteSession = vi.fn(async () => ({ ok: true, method: "trash" as const }));
		const commands = register(controller, {
			listGroupChatSessions: vi.fn(async () => [
				{
					path: "/isolated-agent/chats/old.jsonl",
					groupChatId: "group-old",
					name: "Old Chat",
					firstMessage: "",
					created: new Date("2026-07-01T00:00:00.000Z"),
					active: false,
				},
			]),
			deleteGroupChatSession: deleteSession,
		});
		const { context, select, confirm, notify } = createContext();
		select.mockResolvedValueOnce("Delete a group chat history…").mockResolvedValueOnce("Old Chat (2026-07-01)");

		await commands.get("tavern-resume")?.handler("", context);

		expect(confirm).toHaveBeenCalledWith(
			"Delete group chat history?",
			expect.stringContaining("/isolated-agent/chats/old.jsonl"),
		);
		expect(deleteSession).toHaveBeenCalledWith("/isolated-agent/chats/old.jsonl");
		expect(notify).toHaveBeenCalledWith("Deleted group chat history (trash)", "info");
	});

	it("does not delete when the confirmation is cancelled", async () => {
		const controller = new TavernController();
		const deleteSession = vi.fn(async () => ({ ok: true, method: "trash" as const }));
		const commands = register(controller, {
			listGroupChatSessions: vi.fn(async () => [
				{
					path: "/isolated-agent/chats/old.jsonl",
					groupChatId: "group-old",
					name: "Old Chat",
					firstMessage: "",
					created: new Date("2026-07-01T00:00:00.000Z"),
					active: false,
				},
			]),
			deleteGroupChatSession: deleteSession,
		});
		const { context, select, confirm } = createContext();
		select.mockResolvedValueOnce("Delete a group chat history…").mockResolvedValueOnce("Old Chat (2026-07-01)");
		confirm.mockResolvedValue(false);

		await commands.get("tavern-resume")?.handler("", context);

		expect(deleteSession).not.toHaveBeenCalled();
	});

	it("reports no resumable group chats", async () => {
		const controller = new TavernController();
		const commands = register(controller, {
			listGroupChatSessions: vi.fn(async () => []),
		});
		const { context, notify } = createContext();

		await commands.get("tavern-resume")?.handler("", context);

		expect(notify).toHaveBeenCalledWith("No resumable group chat found for this project", "info");
	});

	it("rejects resume while already bound to a group chat", async () => {
		const runtime = createRuntime();
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });
		const commands = register(controller, {
			listGroupChatSessions: vi.fn(async () => [
				{
					path: "/isolated-agent/chats/old.jsonl",
					groupChatId: "group-old",
					name: "Old Chat",
					firstMessage: "",
					created: new Date("2026-07-01T00:00:00.000Z"),
					active: false,
				},
			]),
		});
		const { context, select, notify } = createContext();
		select.mockResolvedValue("Old Chat (2026-07-01)");

		await commands.get("tavern-resume")?.handler("", context);

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("already bound to a group chat"), "error");
	});
});
