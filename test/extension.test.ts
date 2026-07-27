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
	on: ReturnType<typeof vi.fn>;
	inputHandlers: InputHandler[];
}

function createMockExtensionAPI(): MockExtensionAPI {
	const inputHandlers: InputHandler[] = [];
	return {
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		on: vi.fn((_event: string, handler: InputHandler) => {
			if (_event === "input") inputHandlers.push(handler);
		}),
		inputHandlers,
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
		setMaxMessages: vi.fn(),
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
	};
} {
	const tools: CapturedTool[] = [];
	const api = {
		registerCommand: vi.fn(),
		on: vi.fn(),
		registerTool: vi.fn((tool: CapturedTool) => {
			tools.push(tool);
		}),
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

	it("registers an idle tavern-status command", async () => {
		const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
		const registerCommand = vi.fn((name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, command);
		});

		piTavern({ registerCommand, on: vi.fn(), registerTool: vi.fn() } as unknown as ExtensionAPI);

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
});
