import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	discoverAndLoadExtensions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type InputEvent,
	type InputEventResult,
	type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type { CharacterRuntime } from "../src/character/character-runtime.js";
import type { JoinAttempt } from "../src/character/join-attempt.js";
import { TavernController } from "../src/controller/tavern-controller.js";
import type { CreatorRuntime } from "../src/creator/creator-runtime.js";
import { createGroupChatState } from "../src/creator/group-chat-state.js";
import type { ActiveGroupChatDescriptor } from "../src/discovery/active-descriptor.js";
import piTavern from "../src/index.js";

const descriptor: ActiveGroupChatDescriptor = {
	instanceId: "instance-1",
	groupChatId: "group-1",
	name: null,
	cwd: "/project",
	pid: 1234,
	host: "127.0.0.1",
	port: 54321,
	startedAt: "2026-07-27T00:00:00.000Z",
};

type InputHandler = (
	event: InputEvent,
	ctx: ExtensionContext,
) => Promise<InputEventResult | undefined> | InputEventResult | undefined;

type CapturedTool = {
	name: string;
	execute: (
		id: string,
		params: { content: string },
	) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
};

interface MockExtensionAPI {
	registerCommand: ReturnType<typeof vi.fn>;
	registerTool: ReturnType<typeof vi.fn>;
	registerEntryRenderer: ReturnType<typeof vi.fn>;
	registerMessageRenderer: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
	getActiveTools: ReturnType<typeof vi.fn>;
	setActiveTools: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	inputHandlers: InputHandler[];
	beforeAgentStartHandlers: Array<
		(event: { systemPrompt: string }) => { systemPrompt?: string } | undefined | undefined
	>;
}

function createMockExtensionAPI(): MockExtensionAPI {
	const inputHandlers: InputHandler[] = [];
	const beforeAgentStartHandlers: Array<
		(event: { systemPrompt: string }) => { systemPrompt?: string } | undefined | undefined
	> = [];
	return {
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		registerEntryRenderer: vi.fn(),
		registerMessageRenderer: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: vi.fn(() => []),
		setActiveTools: vi.fn(),
		on: vi.fn((_event: string, handler: unknown) => {
			if (_event === "input") inputHandlers.push(handler as InputHandler);
			if (_event === "before_agent_start")
				beforeAgentStartHandlers.push(
					handler as (event: { systemPrompt: string }) => { systemPrompt?: string } | undefined | undefined,
				);
		}),
		inputHandlers,
		beforeAgentStartHandlers,
	};
}

function createMockCreatorRuntime(): CreatorRuntime {
	const state = createGroupChatState({
		groupChatId: "group-1",
		createdAt: "2026-07-27T00:00:00.000Z",
		groupMaxMessages: 10,
	});

	// Class mocks require type assertion; new fields on CreatorRuntime will
	// not break compilation but tests will fail at runtime.
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
		setName: vi.fn(async () => "mock"),
		setMaxMessages: vi.fn(() => Promise.resolve()),
		close: vi.fn(async () => undefined),
		submitUserPersonaMessage: vi.fn(() => Promise.resolve("evt-1")),
	} as unknown as CreatorRuntime;
}

function stubContext(): ExtensionContext {
	return { cwd: "/project", ui: { notify: vi.fn() } } as unknown as ExtensionContext;
}

async function assertInputResult(controller: TavernController, expectedAction: "handled" | "continue"): Promise<void> {
	const mock = createMockExtensionAPI();
	piTavern(mock as unknown as ExtensionAPI, controller);

	expect(mock.inputHandlers).toHaveLength(1);

	const result = await mock.inputHandlers[0]?.(
		{ type: "input", text: "hello", source: "interactive" } as InputEvent,
		stubContext(),
	);

	expect(result).toEqual({ action: expectedAction });
}

function captureTools(): {
	tools: CapturedTool[];
	api: {
		registerCommand: ReturnType<typeof vi.fn>;
		on: ReturnType<typeof vi.fn>;
		registerTool: ReturnType<typeof vi.fn>;
		registerEntryRenderer: ReturnType<typeof vi.fn>;
		registerMessageRenderer: ReturnType<typeof vi.fn>;
		appendEntry: ReturnType<typeof vi.fn>;
		getActiveTools: ReturnType<typeof vi.fn>;
		setActiveTools: ReturnType<typeof vi.fn>;
	};
} {
	const tools: CapturedTool[] = [];
	const api = {
		registerCommand: vi.fn(),
		on: vi.fn(),
		registerTool: vi.fn((tool: CapturedTool) => {
			tools.push(tool);
		}),
		registerEntryRenderer: vi.fn(),
		registerMessageRenderer: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: vi.fn(() => []),
		setActiveTools: vi.fn(),
	};
	return { tools, api };
}

function createMockCharacterRuntime(speakResult: object): CharacterRuntime {
	return {
		character: { characterId: "dev", name: "Dev", description: "Dev" },
		close: vi.fn(async () => undefined),
		getGroupChatState: vi.fn(),
		speak: vi.fn(async () => speakResult),
	} as unknown as CharacterRuntime;
}

async function createCharacterController(speakResult: object): Promise<TavernController> {
	const runtime = createMockCharacterRuntime(speakResult);
	const attempt = {
		availableCharacters: [{ character_id: "dev", name: "Dev", description: "Dev" }],
		isActive: true,
		claimCharacter: vi.fn(async () => runtime),
		close: vi.fn(async () => undefined),
	} as unknown as JoinAttempt;
	const controller = new TavernController(undefined, async () => attempt);
	await controller.startJoining(descriptor, "session-1");
	await controller.claimCharacter("dev");
	return controller;
}

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

	it("registers the tavern_speak tool and reports error when not a character", async () => {
		const { tools, api } = captureTools();
		piTavern(api as unknown as ExtensionAPI);

		expect(tools).toHaveLength(1);
		expect(tools[0]?.name).toBe("tavern_speak");

		const tool = tools[0];
		if (!tool) throw new Error("no tool");
		expect(tool).toBeDefined();
		const result = await tool.execute("call-1", { content: "Hello" });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("not currently joined");
	});

	it("tavern_speak returns published result when character speaks successfully", async () => {
		const controller = await createCharacterController({
			published: true,
			eventId: "evt-1",
			sequence: 3,
			round: { roundMaxMessages: 10, usedMessages: 3, remainingMessages: 7 },
		});

		const { tools, api } = captureTools();
		piTavern(api as unknown as ExtensionAPI, controller);

		const tool = tools[0];
		if (!tool) throw new Error("no tool");
		expect(tool).toBeDefined();
		const result = await tool.execute("call-1", { content: "My message" });
		expect(result.content[0]?.text).toContain("Message published");
		expect(result.content[0]?.text).toContain("3/10");
	});

	it("tavern_speak returns hand-raised result when round limit reached", async () => {
		const controller = await createCharacterController({
			published: false,
			reason: "round_limit_reached",
			handRaised: true,
			round: { roundMaxMessages: 10, usedMessages: 10, remainingMessages: 0 },
		});

		const { tools, api } = captureTools();
		piTavern(api as unknown as ExtensionAPI, controller);

		const tool = tools[0];
		if (!tool) throw new Error("no tool");
		expect(tool).toBeDefined();
		const result = await tool.execute("call-1", { content: "Too late" });
		expect(result.content[0]?.text).toContain("round limit reached");
	});

	it("enables tavern_speak when entering character state", () => {
		const runtime = createMockCharacterRuntime({});
		const controller = new TavernController();
		// Set internal state to character
		(controller as unknown as { state: { type: string; runtime: unknown } }).state = {
			type: "character",
			runtime,
		};

		const mock = createMockExtensionAPI();
		vi.mocked(mock.getActiveTools).mockReturnValue(["existing_tool"]);
		piTavern(mock as unknown as ExtensionAPI, controller);

		// Trigger state change to sync tools
		controller.onStateChange?.();

		expect(mock.setActiveTools).toHaveBeenCalledWith(["existing_tool", "tavern_speak"]);
	});

	it("does not enable tavern_speak when already active", () => {
		const runtime = createMockCharacterRuntime({});
		const controller = new TavernController();
		(controller as unknown as { state: { type: string; runtime: unknown } }).state = {
			type: "character",
			runtime,
		};

		const mock = createMockExtensionAPI();
		vi.mocked(mock.getActiveTools).mockReturnValue(["tavern_speak"]);
		piTavern(mock as unknown as ExtensionAPI, controller);

		controller.onStateChange?.();

		expect(mock.setActiveTools).not.toHaveBeenCalled();
	});

	it("removes tavern_speak when leaving character state", () => {
		const controller = new TavernController();

		const mock = createMockExtensionAPI();
		vi.mocked(mock.getActiveTools).mockReturnValue(["tavern_speak", "other"]);
		piTavern(mock as unknown as ExtensionAPI, controller);

		controller.onStateChange?.();

		expect(mock.setActiveTools).toHaveBeenCalledWith(["other"]);
	});

	it("does not remove other tools when tavern_speak is not present", () => {
		const controller = new TavernController();

		const mock = createMockExtensionAPI();
		vi.mocked(mock.getActiveTools).mockReturnValue(["other"]);
		piTavern(mock as unknown as ExtensionAPI, controller);

		controller.onStateChange?.();

		expect(mock.setActiveTools).not.toHaveBeenCalled();
	});

	it("registers an idle tavern-status command", async () => {
		const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
		const registerCommand = vi.fn((name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, command);
		});

		piTavern({
			registerCommand,
			on: vi.fn(),
			registerTool: vi.fn(),
			registerEntryRenderer: vi.fn(),
			registerMessageRenderer: vi.fn(),
			appendEntry: vi.fn(),
			getActiveTools: vi.fn(() => []),
			setActiveTools: vi.fn(),
		} as unknown as ExtensionAPI);

		const status = commands.get("tavern-status");
		expect(status).toBeDefined();

		const notify = vi.fn();
		await status?.handler("", {
			hasUI: true,
			ui: { notify },
		} as unknown as ExtensionCommandContext);

		expect(notify).toHaveBeenCalledWith("No active group chat", "info");
	});

	it("submits a user persona message when in creator state", async () => {
		const runtime = createMockCreatorRuntime();
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });

		const mock = createMockExtensionAPI();
		piTavern(mock as unknown as ExtensionAPI, controller);

		expect(mock.inputHandlers).toHaveLength(1);

		const ctx = stubContext();
		const result = await mock.inputHandlers[0]?.(
			{ type: "input", text: "hello", source: "interactive" } as InputEvent,
			ctx,
		);

		expect(result).toEqual({ action: "handled" });
		expect(runtime.submitUserPersonaMessage).toHaveBeenCalledWith("hello");
	});

	it("appends creator-display entry when user persona message is submitted", async () => {
		const runtime = createMockCreatorRuntime();
		// Wire submitUserPersonaMessage to fire onPublicMessage like the real impl
		runtime.submitUserPersonaMessage = vi.fn(async (content: string) => {
			runtime.onPublicMessage?.({
				sender: { type: "user_persona" },
				content,
				event_id: "evt-1",
				sequence: 1,
				timestamp: "2026-01-01T00:00:00.000Z",
				round: { round_max_messages: 10, used_messages: 0, remaining_messages: 10 },
			});
			return "evt-1";
		});
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });

		const mock = createMockExtensionAPI();
		piTavern(mock as unknown as ExtensionAPI, controller);

		// Trigger the onStateChange to wire up creator display
		controller.onStateChange?.();

		// Trigger input to submit a user persona message
		const ctx = stubContext();
		await mock.inputHandlers[0]?.({ type: "input", text: "hello", source: "interactive" } as InputEvent, ctx);

		expect(mock.appendEntry).toHaveBeenCalledWith("pi-tavern.creator-display", {
			kind: "public_message",
			group_chat_id: "group-1",
			event: {
				event_id: "evt-1",
				sequence: 1,
				timestamp: "2026-01-01T00:00:00.000Z",
				sender: { type: "user_persona" },
				content: "hello",
				round: { round_max_messages: 10, used_messages: 0, remaining_messages: 10 },
			},
		});
	});

	it("appends error notification when creator-display projection fails", async () => {
		const runtime = createMockCreatorRuntime();
		// Wire submitUserPersonaMessage to fire onPublicMessage like the real impl
		runtime.submitUserPersonaMessage = vi.fn(async (content: string) => {
			runtime.onPublicMessage?.({
				sender: { type: "user_persona" },
				content,
				event_id: "evt-1",
				sequence: 1,
				timestamp: "2026-01-01T00:00:00.000Z",
				round: { round_max_messages: 10, used_messages: 0, remaining_messages: 10 },
			});
			return "evt-1";
		});
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });

		const mock = createMockExtensionAPI();
		// First appendEntry throws, second succeeds
		let callCount = 0;
		vi.mocked(mock.appendEntry).mockImplementation(() => {
			callCount++;
			if (callCount === 1) throw new Error("render failure");
		});

		piTavern(mock as unknown as ExtensionAPI, controller);
		controller.onStateChange?.();

		const ctx = stubContext();
		await mock.inputHandlers[0]?.({ type: "input", text: "hello", source: "interactive" } as InputEvent, ctx);

		// First call was the content projection
		expect(mock.appendEntry).toHaveBeenNthCalledWith(1, "pi-tavern.creator-display", {
			kind: "public_message",
			group_chat_id: "group-1",
			event: {
				event_id: "evt-1",
				sequence: 1,
				timestamp: "2026-01-01T00:00:00.000Z",
				sender: { type: "user_persona" },
				content: "hello",
				round: { round_max_messages: 10, used_messages: 0, remaining_messages: 10 },
			},
		});
		// Second call is the error notification
		expect(mock.appendEntry).toHaveBeenNthCalledWith(2, "pi-tavern.creator-display", {
			kind: "public_message",
			group_chat_id: "group-1",
			event: {
				event_id: "evt-1",
				sequence: 1,
				timestamp: "2026-01-01T00:00:00.000Z",
				sender: { type: "user_persona" },
				content: "TUI projection failed: render failure",
				round: { round_max_messages: 10, used_messages: 0, remaining_messages: 10 },
			},
		});
	});

	it("notifies error and still handles input when submitUserPersonaMessage fails", async () => {
		const runtime = createMockCreatorRuntime();
		vi.mocked(runtime.submitUserPersonaMessage).mockRejectedValue(new Error("disk full"));
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });

		const mock = createMockExtensionAPI();
		piTavern(mock as unknown as ExtensionAPI, controller);

		const ctx = stubContext();
		const result = await mock.inputHandlers[0]?.(
			{ type: "input", text: "hello", source: "interactive" } as InputEvent,
			ctx,
		);

		expect(result).toEqual({ action: "handled" });
		expect(ctx.ui.notify).toHaveBeenCalledWith("disk full", "error");
	});

	it("passes through user input when the controller is idle", async () => {
		const controller = new TavernController();
		await assertInputResult(controller, "continue");
	});

	it("passes through user input when the controller is joining", async () => {
		const attempt = {
			availableCharacters: [],
			isActive: true,
			claimCharacter: vi.fn(),
			close: vi.fn(async () => undefined),
			refreshAvailableCharacters: vi.fn(),
		} as unknown as JoinAttempt;
		const controller = new TavernController(undefined, async () => attempt);
		await controller.startJoining(descriptor, "session-1");

		await assertInputResult(controller, "continue");
	});

	it("passes through user input when the controller is character", async () => {
		const characterRuntime = {
			character: { characterId: "dev", name: "Dev", description: "Dev" },
			close: vi.fn(async () => undefined),
			getGroupChatState: vi.fn(),
		} as unknown as CharacterRuntime;
		const attempt = {
			availableCharacters: [{ character_id: "dev", name: "Dev", description: "Dev" }],
			isActive: true,
			claimCharacter: vi.fn(async () => characterRuntime),
			close: vi.fn(async () => undefined),
		} as unknown as JoinAttempt;
		const controller = new TavernController(undefined, async () => attempt);
		await controller.startJoining(descriptor, "session-1");
		await controller.claimCharacter("dev");

		await assertInputResult(controller, "continue");
	});

	it("passes through extension-sourced input even in creator state", async () => {
		const runtime = createMockCreatorRuntime();
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });

		const mock = createMockExtensionAPI();
		piTavern(mock as unknown as ExtensionAPI, controller);

		expect(mock.inputHandlers).toHaveLength(1);

		const ctx = stubContext();
		const result = await mock.inputHandlers[0]?.(
			{ type: "input", text: "auto-generated", source: "extension" } as InputEvent,
			ctx,
		);

		expect(result).toEqual({ action: "continue" });
		expect(runtime.submitUserPersonaMessage).not.toHaveBeenCalled();
	});

	it("accepts rpc-sourced input as user persona message in creator state", async () => {
		const runtime = createMockCreatorRuntime();
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });

		const mock = createMockExtensionAPI();
		piTavern(mock as unknown as ExtensionAPI, controller);

		const ctx = stubContext();
		const result = await mock.inputHandlers[0]?.(
			{ type: "input", text: "rpc message", source: "rpc" } as InputEvent,
			ctx,
		);

		expect(result).toEqual({ action: "handled" });
		expect(runtime.submitUserPersonaMessage).toHaveBeenCalledWith("rpc message");
	});

	it("injects character prompt when in character state", () => {
		const characterRuntime = {
			character: {
				characterId: "dev",
				name: "Developer",
				description: "Dev",
				path: "/chars/dev.md",
				prompt: "You are a skilled developer.",
			},
			close: vi.fn(),
			getGroupChatState: vi.fn(),
			updateStreaming: vi.fn(),
		} as unknown as CharacterRuntime;
		const controller = new TavernController();
		// Use internal state setter to bypass transition lock for test setup
		(controller as unknown as { state: { type: string; runtime: CharacterRuntime } }).state = {
			type: "character",
			runtime: characterRuntime,
		};

		const mock = createMockExtensionAPI();
		piTavern(mock as unknown as ExtensionAPI, controller);

		expect(mock.beforeAgentStartHandlers).toHaveLength(1);

		const result = mock.beforeAgentStartHandlers[0]?.({ systemPrompt: "Base system prompt." });
		expect(result?.systemPrompt).toContain("Base system prompt.");
		expect(result?.systemPrompt).toContain("Character Persona: Developer");
		expect(result?.systemPrompt).toContain("You are a skilled developer.");
	});

	it("does not inject character prompt when in idle state", () => {
		const controller = new TavernController();
		const mock = createMockExtensionAPI();
		piTavern(mock as unknown as ExtensionAPI, controller);

		expect(mock.beforeAgentStartHandlers).toHaveLength(1);
		const result = mock.beforeAgentStartHandlers[0]?.({ systemPrompt: "Base." });
		expect(result).toBeUndefined();
	});

	it("does not inject character prompt when in creator state", () => {
		const runtime = createMockCreatorRuntime();
		const controller = new TavernController(async () => runtime);
		controller.startNew({ cwd: "/project", agentDir: "/agent" });

		const mock = createMockExtensionAPI();
		piTavern(mock as unknown as ExtensionAPI, controller);

		const result = mock.beforeAgentStartHandlers[0]?.({ systemPrompt: "Base." });
		expect(result).toBeUndefined();
	});
});
