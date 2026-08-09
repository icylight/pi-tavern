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

import type { CharacterRuntime } from "../../src/character/character-runtime.js";
import type { JoinAttempt } from "../../src/character/join-attempt.js";
import { DEFAULT_TEMPLATES } from "../../src/config/message-templates.js";
import type { CreatorReloadHandoff } from "../../src/controller/reload-handoff-registry.js";
import { TavernController } from "../../src/controller/tavern-controller.js";
import type { CreatorRuntime } from "../../src/creator/creator-runtime.js";
import type { ActiveGroupChatDescriptor } from "../../src/data/discovery/active-descriptor.js";
import { createGroupChatState } from "../../src/data/group-chat-state.js";
import piTavern from "../../src/index.js";

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

type SessionHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

type CapturedTool = {
	name: string;
	parameters: { type?: unknown };
	execute: (
		id: string,
		params: Record<string, unknown>,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details?: Record<string, unknown>;
		isError?: boolean;
	}>;
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
	sessionHandlers: Map<string, SessionHandler[]>;
}

function createMockExtensionAPI(): MockExtensionAPI {
	const inputHandlers: InputHandler[] = [];
	const beforeAgentStartHandlers: Array<
		(event: { systemPrompt: string }) => { systemPrompt?: string } | undefined | undefined
	> = [];
	const sessionHandlers = new Map<string, SessionHandler[]>();
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
			if (
				_event === "session_start" ||
				_event === "session_shutdown" ||
				_event === "session_before_switch" ||
				_event === "session_before_fork"
			) {
				const handlers = sessionHandlers.get(_event) ?? [];
				handlers.push(handler as SessionHandler);
				sessionHandlers.set(_event, handlers);
			}
		}),
		inputHandlers,
		beforeAgentStartHandlers,
		sessionHandlers,
	};
}

function createMockCreatorRuntime(): CreatorRuntime {
	const state = createGroupChatState({
		groupChatId: "group-1",
		createdAt: "2026-07-27T00:00:00.000Z",
		groupMaxMessages: 10,
	});

	// 类 mock 需要类型断言；CreatorRuntime 新增字段不会破坏编译，
	// 但测试会在运行时失败。
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
		publicMessageList: [],
		whisperMessageList: [],
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
		markIncrementPending: vi.fn(),
		speak: vi.fn(async () => speakResult),
		boardWrite: vi.fn(),
	} as unknown as CharacterRuntime;
}

async function createCharacterController(speakResult: object): Promise<TavernController> {
	const runtime = createMockCharacterRuntime(speakResult);
	return createCharacterControllerWithRuntime(runtime);
}

async function createCharacterControllerWithRuntime(runtime: CharacterRuntime): Promise<TavernController> {
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
	}, 30_000); // Loader 做了两遍真实发现；并发负载（acceptance 套件）下可能超出 vitest 默认 5s 超时（#32）。按测试扩展逐个说明：对负载敏感，非功能失败；#34（maxWorkers: 2）降低争用，保留此裕量。

	it("registers the tavern_speak, tavern_board, tavern_whoami and tavern_history tools and reports error when not a character", async () => {
		const { tools, api } = captureTools();
		piTavern(api as unknown as ExtensionAPI);

		expect(tools).toHaveLength(5);
		expect(tools[0]?.name).toBe("tavern_speak");
		expect(tools[1]?.name).toBe("tavern_board");
		expect(tools[2]?.name).toBe("tavern_whoami");
		expect(tools[3]?.name).toBe("tavern_history");
		// #154 T7：LLM-only 只读工具（不注册 slash command）。
		expect(tools[4]?.name).toBe("tavern_template_defaults");

		const tool = tools[0];
		if (!tool) throw new Error("no tool");
		expect(tool).toBeDefined();
		const result = await tool.execute("call-1", { content: "Hello" });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("not currently joined");
	});

	it("T7 (#154): tavern_template_defaults 只读工具——门禁（creator/joining 拒绝）+ 内容含默认值/key/规则/骨架", async () => {
		// idle 态：放行，返回完整契约信息。
		const idleController = new TavernController();
		const { tools, api } = captureTools();
		piTavern(api as unknown as ExtensionAPI, idleController);
		const tool = tools[4];
		if (!tool) throw new Error("no tool");
		expect(tool.parameters).toEqual({ type: "object", properties: {}, additionalProperties: false });

		const idleResult = await tool.execute("call-1", {});
		expect(idleResult.isError).not.toBe(true);
		const text = idleResult.content[0]?.text ?? "";
		expect(text).toContain("public_message");
		expect(text).toContain("seconds_ago");
		expect(text).toContain("minutes_ago");
		expect(text).toContain("{sender}");
		expect(text).toContain("{count}");
		expect(text).toContain("JSON 骨架");
		// 本期三类 key：whisper 两 key 随 #152 一并引入（契约留痕），不暴露。
		expect(text).not.toContain("whisper");

		// creator 态：拒绝（门禁同 CE2 语义；不泄漏内部状态细节）。
		const runtime = createMockCreatorRuntime();
		const creatorController = new TavernController(async () => runtime);
		const { tools: creatorTools, api: creatorApi } = captureTools();
		piTavern(creatorApi as unknown as ExtensionAPI, creatorController);
		const creatorTool = creatorTools[4];
		if (!creatorTool) throw new Error("no tool");
		await creatorController.startNew({ cwd: "/project", agentDir: "/agent" });
		const rejected = await creatorTool.execute("call-1", {});
		expect(rejected.isError).toBe(true);
		expect(rejected.content[0]?.text).toContain("only available when idle or joined as a Character");
	});

	it("tavern_history returns a formatted history page and rejects when not a character (P1-4)", async () => {
		const historyPage = {
			messages: [
				{
					jsonrpc: "2.0",
					method: "public_message",
					params: {
						event_id: "evt-1",
						sequence: 12,
						timestamp: "2026-08-08T00:00:00.000Z",
						sender: { type: "user_persona" },
						content: "hello from history",
						round: { round_max_messages: 20, used_messages: 1, remaining_messages: 19 },
					},
				},
			],
			cursor: "opaque-1",
			hasMore: true,
			totalMessages: 12,
		};
		const runtime = {
			character: { characterId: "dev", name: "Dev", description: "Dev" },
			close: vi.fn(async () => undefined),
			getGroupChatState: vi.fn(),
			markIncrementPending: vi.fn(),
			speak: vi.fn(),
			boardWrite: vi.fn(),
			fetchMessageHistoryPage: vi.fn(async () => historyPage),
		} as unknown as CharacterRuntime;
		const controller = await createCharacterControllerWithRuntime(runtime);
		const { tools, api } = captureTools();
		piTavern(api as unknown as ExtensionAPI, controller);

		const tool = tools.find((t) => t.name === "tavern_history");
		if (!tool) throw new Error("no tavern_history tool");

		// 无 cursor = 最近一页；输出含消息内容 + cursor/has_more/total 供 AI 自主续页。
		const result = await tool.execute("call-1", {});
		expect(result.isError).toBeUndefined();
		const text = result.content[0]?.text as string;
		expect(text).toContain("hello from history");
		expect(text).toContain("cursor=opaque-1");
		expect(text).toContain("has_more=true");
		expect(text).toContain("total=12");
		expect(runtime.fetchMessageHistoryPage).toHaveBeenCalledWith(null);

		// 带 cursor = 向更早续页（透传）。
		await tool.execute("call-2", { cursor: "opaque-1" });
		expect(runtime.fetchMessageHistoryPage).toHaveBeenCalledWith("opaque-1");
	});

	it("T3 (#154): tavern_history 用自定义 public_message 模板渲染（三面同变）", async () => {
		const historyPage = {
			messages: [
				{
					jsonrpc: "2.0",
					method: "public_message",
					params: {
						event_id: "evt-1",
						sequence: 12,
						timestamp: "2026-08-08T00:00:00.000Z",
						sender: { type: "user_persona" },
						content: "hello from history",
						round: { round_max_messages: 20, used_messages: 1, remaining_messages: 19 },
					},
				},
			],
			cursor: null,
			hasMore: false,
			totalMessages: 1,
		};
		const runtime = {
			character: { characterId: "dev", name: "Dev", description: "Dev" },
			close: vi.fn(async () => undefined),
			getGroupChatState: vi.fn(),
			markIncrementPending: vi.fn(),
			speak: vi.fn(),
			boardWrite: vi.fn(),
			fetchMessageHistoryPage: vi.fn(async () => historyPage),
			messageTemplates: { ...DEFAULT_TEMPLATES, public_message: "[{sender}]→{content}" },
		} as unknown as CharacterRuntime;
		const controller = await createCharacterControllerWithRuntime(runtime);
		const { tools, api } = captureTools();
		piTavern(api as unknown as ExtensionAPI, controller);

		const tool = tools.find((t) => t.name === "tavern_history");
		if (!tool) throw new Error("no tavern_history tool");

		const result = await tool.execute("call-1", {});
		const text = result.content[0]?.text as string;
		expect(text).toContain("[User Persona]→hello from history");
	});

	it("tavern_history reports a clear error when not in character state (creator/idle)", async () => {
		const { tools, api } = captureTools();
		piTavern(api as unknown as ExtensionAPI);

		const tool = tools.find((t) => t.name === "tavern_history");
		if (!tool) throw new Error("no tavern_history tool");
		const result = await tool.execute("call-1", {});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("not currently joined");
	});

	it("tavern_whoami returns the registered character identity when in character state (ISSUE-007)", async () => {
		const controller = await createCharacterController({});
		const runtime = (controller.getState() as { type: "character"; runtime: CharacterRuntime }).runtime;

		const { tools, api } = captureTools();
		piTavern(api as unknown as ExtensionAPI, controller);

		const tool = tools[2];
		if (!tool) throw new Error("no whoami tool");
		expect(tool).toBeDefined();
		const result = await tool.execute("call-1", {});
		expect(result.isError).toBeUndefined();
		// 字段命名与身份行契约（cab1fd7）共享：
		// name / character_id / description，唯一来源 = runtime.character。
		expect(result.details).toEqual({
			name: runtime.character.name,
			character_id: runtime.character.characterId,
			description: runtime.character.description,
		});
		expect(result.content[0]?.text).toContain(runtime.character.name);
		expect(result.content[0]?.text).toContain(runtime.character.characterId);
	});

	it("tavern_whoami reports a clear error when not in character state (creator/idle)", async () => {
		const { tools, api } = captureTools();
		piTavern(api as unknown as ExtensionAPI);

		const tool = tools[2];
		if (!tool) throw new Error("no whoami tool");
		const result = await tool.execute("call-1", {});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("not currently joined");
	});

	it("tavern_board 工具参数判别：非法组合工具层即拒——不发 wire 请求、不断连（PR #116 F11）", async () => {
		const runtime = createMockCharacterRuntime({});
		const controller = await createCharacterControllerWithRuntime(runtime);
		const { tools, api } = captureTools();
		piTavern(api as unknown as ExtensionAPI, controller);

		const tool = tools[1];
		if (!tool) throw new Error("no tavern_board tool");
		expect(tool.parameters.type).toBe("object");

		// 非法组合（服务端判别 union 必拒）：remove 缺 id / remove 带 content / clear 带 note
		const invalid = [
			{ action: "remove" },
			{ action: "remove", note: { content: "x" } },
			{ action: "clear", note: { id: "n1" } },
		];
		for (const params of invalid) {
			const result = await tool.execute("call-f11", params);
			expect(result.isError).toBe(true);
		}

		// 错误在工具层拦截：不发 wire 请求（boardWrite 未被调用）、不断连（close 未被调用）
		expect(runtime.boardWrite).not.toHaveBeenCalled();
		expect(runtime.close).not.toHaveBeenCalled();
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

	it("fails tavern_speak when the runtime connection dropped but the controller is still in character state (BC-17)", async () => {
		// 窗口期：WebSocket 已关闭（runtime 断连）但 controller 尚未完成
		// idle 转换。工具必须报告发送失败，而不是假装消息已发出。
		const runtime = createMockCharacterRuntime({});
		runtime.speak = vi.fn(async () => {
			throw new Error("PiTavern connection is not open");
		});
		const attempt = {
			availableCharacters: [{ character_id: "dev", name: "Dev", description: "Dev" }],
			isActive: true,
			claimCharacter: vi.fn(async () => runtime),
			close: vi.fn(async () => undefined),
		} as unknown as JoinAttempt;
		const controller = new TavernController(undefined, async () => attempt);
		await controller.startJoining(descriptor, "session-1");
		await controller.claimCharacter("dev");
		expect(controller.getState().type).toBe("character");

		const { tools, api } = captureTools();
		piTavern(api as unknown as ExtensionAPI, controller);

		const tool = tools[0];
		if (!tool) throw new Error("no tool");
		const result = await tool.execute("call-1", { content: "Lost message" });

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Failed to send message");
		expect(result.content[0]?.text).toContain("PiTavern connection is not open");
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

	it("#128 tavern_speak 未读先读：未知数量使用通用告知，不伪造至少 0 条", async () => {
		const controller = await createCharacterController({
			published: false,
			reason: "unread_first",
			first: true,
			unreadExact: false,
		});

		const { tools, api } = captureTools();
		piTavern(api as unknown as ExtensionAPI, controller);

		const tool = tools[0];
		if (!tool) throw new Error("no tool");
		const result = await tool.execute("call-unread-first", { content: "Need more context" });
		expect(result.content[0]?.text).toContain("有未读消息");
		expect(result.content[0]?.text).not.toContain("至少 0 条");
		expect(result.content[0]?.text).toContain("not counted against the round quota");
		expect(result.content[0]?.text).toContain("no hand was raised");
	});

	it("ISSUE-013 B3: stale speak flags the increment; notice only, no in-tool pull", async () => {
		const runtime = createMockCharacterRuntime({
			published: false,
			reason: "stale",
			missingFrom: 3,
			missingTo: 5,
			autoRecover: true,
			round: { roundMaxMessages: 10, usedMessages: 0, remainingMessages: 10 },
		});
		runtime.fetchMessagesSince = vi.fn();
		const controller = await createCharacterControllerWithRuntime(runtime);

		const { tools, api } = captureTools();
		piTavern(api as unknown as ExtensionAPI, controller);

		const tool = tools[0];
		if (!tool) throw new Error("no tool");
		const result = await tool.execute("call-1", { content: "Stale message" });

		// 工具报告拒绝时附带缺失的消息区间，而非泛化错误。
		expect(result.isError).not.toBe(true);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("out of sync");
		expect(text).toContain("messages 3..5 arrived");
		expect(text).toContain("not counted against the round quota");
		expect(text).toContain("no hand was raised");
		// 最终设计（User "怎么简单怎么来"）：工具内不拉取、不带消息文本——
		// 只打 A2 增量标记，由 settle 钩子经统一管线拉取一次，
		// LLM 下一轮带完整上下文重新决策。
		expect(runtime.fetchMessagesSince).not.toHaveBeenCalled();
		expect(text).not.toContain("[seq 3]");
		expect(runtime.markIncrementPending).toHaveBeenCalledTimes(1);
	});

	it("ISSUE-013 B5: no auto-recovery flag when the budget is exhausted", async () => {
		const runtime = createMockCharacterRuntime({
			published: false,
			reason: "stale",
			missingFrom: 3,
			missingTo: 5,
			autoRecover: false,
			round: { roundMaxMessages: 10, usedMessages: 0, remainingMessages: 10 },
		});
		runtime.fetchMessagesSince = vi.fn();
		const controller = await createCharacterControllerWithRuntime(runtime);

		const { tools, api } = captureTools();
		piTavern(api as unknown as ExtensionAPI, controller);

		const tool = tools[0];
		if (!tool) throw new Error("no tool");
		const result = await tool.execute("call-1", { content: "Stale again" });

		// 预算耗尽：提示保留，但不打 A2 增量标记
		// （本轮不再自动恢复），工具内也不拉取。
		expect(runtime.markIncrementPending).not.toHaveBeenCalled();
		expect(runtime.fetchMessagesSince).not.toHaveBeenCalled();
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("out of sync");
		expect(text).toContain("Auto-recovery budget exhausted this round");
	});

	it("enables tavern_speak when entering character state", () => {
		const runtime = createMockCharacterRuntime({});
		const controller = new TavernController();
		// 设置内部状态为 character
		(controller as unknown as { state: { type: string; runtime: unknown } }).state = {
			type: "character",
			runtime,
		};

		const mock = createMockExtensionAPI();
		vi.mocked(mock.getActiveTools).mockReturnValue(["existing_tool"]);
		piTavern(mock as unknown as ExtensionAPI, controller);

		// 触发状态变更以同步工具
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
		// 将 submitUserPersonaMessage 接入 onPublicMessage 触发（与真实实现一致）
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

		// 触发 onStateChange 以接入 creator 显示
		controller.onStateChange?.();

		// 触发输入提交 user persona 消息
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
		// 将 submitUserPersonaMessage 接入 onPublicMessage 触发（与真实实现一致）
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
		// 第一次 appendEntry 抛错，第二次成功
		let callCount = 0;
		vi.mocked(mock.appendEntry).mockImplementation(() => {
			callCount++;
			if (callCount === 1) throw new Error("render failure");
		});

		piTavern(mock as unknown as ExtensionAPI, controller);
		controller.onStateChange?.();

		const ctx = stubContext();
		await mock.inputHandlers[0]?.({ type: "input", text: "hello", source: "interactive" } as InputEvent, ctx);

		// 第一次调用是内容投影
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
		// 第二次调用是错误通知
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
		// 用内部状态 setter 绕过转换锁，便于测试准备
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

	function sessionContext(confirm: ReturnType<typeof vi.fn>): ExtensionContext {
		return {
			ui: { confirm, notify: vi.fn() },
			sessionManager: { getSessionId: () => "pi-session-1" },
		} as unknown as ExtensionContext;
	}

	it("cancels /new while bound when the user declines", async () => {
		const runtime = createMockCreatorRuntime();
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });

		const mock = createMockExtensionAPI();
		piTavern(mock as unknown as ExtensionAPI, controller);

		const confirm = vi.fn(async () => false);
		const result = await mock.sessionHandlers.get("session_before_switch")?.[0]?.(
			{ type: "session_before_switch", reason: "new" },
			sessionContext(confirm),
		);

		expect(result).toEqual({ cancel: true });
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(controller.getState().type).toBe("creator");
		expect(runtime.close).not.toHaveBeenCalled();
	});

	it("exits the group chat first when the user confirms /resume", async () => {
		const runtime = createMockCreatorRuntime();
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });

		const mock = createMockExtensionAPI();
		piTavern(mock as unknown as ExtensionAPI, controller);

		const confirm = vi.fn(async () => true);
		const result = await mock.sessionHandlers.get("session_before_switch")?.[0]?.(
			{ type: "session_before_switch", reason: "resume" },
			sessionContext(confirm),
		);

		expect(result).toEqual({ cancel: false });
		expect(runtime.close).toHaveBeenCalledTimes(1);
		expect(controller.getState()).toEqual({ type: "idle" });
	});

	it("applies the same exit gate to /fork and /clone", async () => {
		const runtime = createMockCreatorRuntime();
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });

		const mock = createMockExtensionAPI();
		piTavern(mock as unknown as ExtensionAPI, controller);

		const confirm = vi.fn(async () => false);
		const result = await mock.sessionHandlers.get("session_before_fork")?.[0]?.(
			{ type: "session_before_fork", entryId: "e1", position: "before" },
			sessionContext(confirm),
		);

		expect(result).toEqual({ cancel: true });
		expect(controller.getState().type).toBe("creator");
	});

	it("closes the bound runtime before pi continues to quit", async () => {
		const runtime = createMockCreatorRuntime();
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });

		const mock = createMockExtensionAPI();
		piTavern(mock as unknown as ExtensionAPI, controller);

		await mock.sessionHandlers.get("session_shutdown")?.[0]?.(
			{ type: "session_shutdown", reason: "quit" },
			sessionContext(vi.fn()),
		);

		expect(runtime.close).toHaveBeenCalledTimes(1);
		expect(controller.getState()).toEqual({ type: "idle" });
	});

	function tuiContext(): ExtensionContext & {
		ui: {
			setStatus: ReturnType<typeof vi.fn>;
			setWidget: ReturnType<typeof vi.fn>;
			notify: ReturnType<typeof vi.fn>;
			confirm: ReturnType<typeof vi.fn>;
		};
	} {
		return {
			ui: {
				setStatus: vi.fn(),
				setWidget: vi.fn(),
				notify: vi.fn(),
				confirm: vi.fn(),
			},
			sessionManager: { getSessionId: () => "pi-session-1" },
		} as unknown as ExtensionContext & {
			ui: {
				setStatus: ReturnType<typeof vi.fn>;
				setWidget: ReturnType<typeof vi.fn>;
				notify: ReturnType<typeof vi.fn>;
				confirm: ReturnType<typeof vi.fn>;
			};
		};
	}

	it("renders footer status and widget from the creator state", async () => {
		const runtime = createMockCreatorRuntime();
		runtime.state.groupChat.name = "Architecture Review";
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });

		const mock = createMockExtensionAPI();
		piTavern(mock as unknown as ExtensionAPI, controller);
		const ctx = tuiContext();

		await mock.sessionHandlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-tavern", "Tavern Creator · Architecture Review");
		expect(ctx.ui.setWidget).toHaveBeenCalledWith("pi-tavern", ["1 人在线"], { placement: "belowEditor" });
		expect(controller.getState().type).toBe("creator");
	});

	it("clears status and widget when idle", async () => {
		const controller = new TavernController();
		const mock = createMockExtensionAPI();
		piTavern(mock as unknown as ExtensionAPI, controller);
		const ctx = tuiContext();

		await mock.sessionHandlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

		expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-tavern", undefined);
		expect(ctx.ui.setWidget).toHaveBeenCalledWith("pi-tavern", undefined, { placement: "belowEditor" });
	});

	it("keeps group chat state intact when TUI rendering fails", async () => {
		const runtime = createMockCreatorRuntime();
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });

		const mock = createMockExtensionAPI();
		piTavern(mock as unknown as ExtensionAPI, controller);
		const ctx = tuiContext();
		ctx.ui.setStatus = vi.fn(() => {
			throw new Error("TUI unavailable");
		});
		ctx.ui.setWidget = vi.fn(() => {
			throw new Error("TUI unavailable");
		});

		await mock.sessionHandlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

		// 渲染失败不得关闭 runtime 或改变业务状态。
		expect(controller.getState().type).toBe("creator");
		expect(runtime.close).not.toHaveBeenCalled();

		// 后续成员状态变更仍能刷新而不崩溃。
		expect(() => runtime.onMembersChanged?.()).not.toThrow();
	});

	it("detaches the creator for a reload shutdown without closing", async () => {
		const runtime = createMockCreatorRuntime();
		runtime.detachForReload = vi.fn(
			async (_piSessionId: string) => ({ kind: "creator" as const }) as unknown as CreatorReloadHandoff,
		);
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });

		const mock = createMockExtensionAPI();
		piTavern(mock as unknown as ExtensionAPI, controller);

		await mock.sessionHandlers.get("session_shutdown")?.[0]?.(
			{ type: "session_shutdown", reason: "reload" },
			sessionContext(vi.fn()),
		);

		expect(runtime.detachForReload).toHaveBeenCalledWith("pi-session-1");
		expect(runtime.close).not.toHaveBeenCalled();
	});
	it("J4 断言②a: character 断连离开后 syncActiveTools 移除 tavern_speak（#83 风暴→failConnection→工具消失链）", async () => {
		const controller = await createCharacterController({ published: true, eventId: "evt-1", sequence: 1 });
		const api = createMockExtensionAPI();
		api.getActiveTools.mockReturnValue(["tavern_speak", "tavern_whoami", "other_tool"]);
		piTavern(api as unknown as ExtensionAPI, controller);
		expect(controller.getState().type).toBe("character");

		// 断连后离开（character → idle）→ onStateChange → syncActiveTools → 移除 tavern_speak
		await controller.leave();

		const lastCall = api.setActiveTools.mock.calls.at(-1)?.[0] as string[];
		expect(lastCall).toBeDefined();
		expect(lastCall).not.toContain("tavern_speak");
		expect(lastCall).toContain("other_tool");
	});
});
