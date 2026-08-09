import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

import { describe, expect, it, vi } from "vitest";
import type { CharacterRuntime } from "../../src/character/character-runtime.js";
import type { JoinAttempt } from "../../src/character/join-attempt.js";
import { registerCommands } from "../../src/commands.js";
import type { CharacterCard } from "../../src/config/character-card.js";
import { TavernController } from "../../src/controller/tavern-controller.js";
import type { CreatorRuntime } from "../../src/creator/creator-runtime.js";
import { createBoardStore } from "../../src/data/board-store.js";
import type { ActiveGroupChatDescriptor } from "../../src/data/discovery/active-descriptor.js";
import { createGroupChatState } from "../../src/data/group-chat-state.js";
import {
	CHARACTER_EDIT_PROMPT,
	ERROR_CHARACTER_EDIT_STATE,
	ERROR_TEMPLATE_EDIT_STATE,
	NOTIFY_COMMAND_QUEUED,
	TEMPLATE_EDIT_PROMPT,
} from "../../src/shared/messages.js";

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
		characters: new Map(),
		boardStore: createBoardStore({ boardDir: join(tmpdir(), `pi-tavern-commands-board-${randomUUID()}`) }),
	} as unknown as CreatorRuntime;
}

type RegisteredCommands = Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">> & {
	/** pi.sendUserMessage mock（prompt command 注入 LLM 的通道，CE1）。 */
	sendUserMessage: ReturnType<typeof vi.fn>;
};

function register(
	controller: TavernController,
	overrides: Parameters<typeof registerCommands>[2] = {},
): RegisteredCommands {
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const sendUserMessage = vi.fn(() => undefined);
	const pi = {
		registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
			commands.set(name, command);
		},
		sendUserMessage,
	} as unknown as ExtensionAPI;
	registerCommands(pi, controller, {
		agentDir: "/isolated-agent",
		...overrides,
	});
	return Object.assign(commands, { sendUserMessage });
}

function createContext(options: { isIdle?: boolean } = {}): {
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
			isIdle: () => options.isIdle ?? true,
		} as unknown as ExtensionCommandContext,
		notify,
		select,
		confirm,
	};
}

describe("PiTavern commands", () => {
	it("registers the M2 command set", () => {
		// 隔离 PITAVERN_TEST 环境变量泄漏——测试专用命令
		// （tavern-test-*）是条件注册的，不应出现在基础命令集断言中。
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
				"tavern-character-edit",
				"tavern-template-edit",
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
			expect.objectContaining({
				onDisconnected: expect.any(Function),
				// 游标跟随 Session：路径含群聊目录 + sessionId 文件，同群聊多角色不共用
				cursorStorePath: expect.stringContaining(join("group-1", "session-1.json")),
			}),
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
		// 白板模型（#114）：空板不渲染小节（无 Boards 段）
		expect(message).not.toContain("Boards:");
	});

	it("shows the board snapshot in creator status (B5, #114)", async () => {
		const runtime = createRuntime();
		const controller = new TavernController(async () => runtime);
		await controller.startNew({ cwd: "/project", agentDir: "/agent" });
		const commands = register(controller);
		const { context, notify } = createContext();

		// 预置白板内容（store 随 runtime 装配——B5 纯展示）
		const store = (runtime as unknown as { boardStore: ReturnType<typeof createBoardStore> }).boardStore;
		store.write("group-1", "characters/dev.md", "set", { content: "共识一" });

		await commands.get("tavern-status")?.handler("", context);

		const message = notify.mock.calls[0]?.[0] as string;
		expect(message).toContain("Boards:");
		expect(message).toContain("「共识一」");
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

	it("CE1 (#153): /tavern-character-edit 注册为 prompt command，尾随参数展开进 prompt", async () => {
		const controller = new TavernController();
		const commands = register(controller);
		const { context } = createContext();

		// 带自然语言参数：参数展开在访谈 prompt 之后；非 idle 时排队（followUp）。
		await commands.get("tavern-character-edit")?.handler("创建一个叫 QA 的角色卡", context);
		expect(commands.sendUserMessage).toHaveBeenCalledTimes(1);
		const message = commands.sendUserMessage.mock.calls[0]?.[0];
		expect(typeof message).toBe("string");
		expect(message).toContain(CHARACTER_EDIT_PROMPT);
		expect(message).toContain("用户意图：创建一个叫 QA 的角色卡");
		expect(commands.sendUserMessage.mock.calls[0]?.[1]).toEqual({ deliverAs: "followUp" });
		// CE5 评审补强（苍蓝星 PR #158 阻断 1）：配置幂等/安全约束显式存在于 prompt。
		expect(message).toContain("保留全部现有字段");
		expect(message).toContain("幂等");
		expect(message).toContain("配置无变化");

		// 无参数（仅空白）：只注入 prompt 本体，不追加空意图。
		commands.sendUserMessage.mockClear();
		await commands.get("tavern-character-edit")?.handler("   ", context);
		expect(commands.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(commands.sendUserMessage.mock.calls[0]?.[0]).toBe(CHARACTER_EDIT_PROMPT);
	});

	it("CE1 (#153): agent busy 时 followUp 排队并提示，不 throw", async () => {
		const controller = new TavernController();
		const commands = register(controller);
		const { context, notify } = createContext({ isIdle: false });

		await commands.get("tavern-character-edit")?.handler("排队测试", context);
		// busy 分支：排队通知 + sendUserMessage 仍以 followUp 调用（不 throw）。
		expect(notify).toHaveBeenCalledWith(NOTIFY_COMMAND_QUEUED, "info");
		expect(commands.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(commands.sendUserMessage.mock.calls[0]?.[1]).toEqual({ deliverAs: "followUp" });
	});

	it("CE2 (#153): 状态门禁——idle/Character 可用，creator/joining 拒绝", async () => {
		// idle：放行。
		const idleController = new TavernController();
		const idleCommands = register(idleController);
		const { context: idleContext } = createContext();
		await idleCommands.get("tavern-character-edit")?.handler("", idleContext);
		expect(idleCommands.sendUserMessage).toHaveBeenCalledTimes(1);

		// creator：拒绝（明确错误响应，不泄漏内部状态细节）。
		const runtime = createRuntime();
		const creatorController = new TavernController(async () => runtime);
		const creatorCommands = register(creatorController);
		const { context: creatorContext, notify: creatorNotify } = createContext();
		await creatorCommands.get("tavern-new")?.handler("", creatorContext);
		expect(creatorController.getState().type).toBe("creator");
		await creatorCommands.get("tavern-character-edit")?.handler("", creatorContext);
		expect(creatorNotify).toHaveBeenCalledWith(ERROR_CHARACTER_EDIT_STATE, "error");
		expect(creatorCommands.sendUserMessage).not.toHaveBeenCalled();

		// joining：拒绝（select 挂起停在 joining 态）。
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
		const joiningController = new TavernController(undefined, joinStarter);
		const joiningCommands = register(joiningController, {
			discoverGroupChats: vi.fn(async () => [descriptor]),
		});
		const { context: joiningContext, notify: joiningNotify, select } = createContext();
		let resolveSelect: ((value: string) => void) | undefined;
		vi.mocked(select).mockImplementation(
			() =>
				new Promise<string>((resolve) => {
					resolveSelect = resolve;
				}),
		);
		const joinPromise = joiningCommands.get("tavern-join")?.handler("", joiningContext);
		await vi.waitFor(() => expect(joiningController.getState().type).toBe("joining"));
		await joiningCommands.get("tavern-character-edit")?.handler("", joiningContext);
		expect(joiningNotify).toHaveBeenCalledWith(ERROR_CHARACTER_EDIT_STATE, "error");
		expect(joiningCommands.sendUserMessage).not.toHaveBeenCalled();

		// character：放行（join 流程 claim 完成后）。
		resolveSelect?.("Architect — Architecture");
		await joinPromise;
		expect(joiningController.getState().type).toBe("character");
		await joiningCommands.get("tavern-character-edit")?.handler("", joiningContext);
		expect(joiningCommands.sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("T6 (#154): /tavern-template-edit 注册为 prompt command，参数展开 + 门禁 + 排队", async () => {
		// idle：放行 + 参数展开。
		const idleController = new TavernController();
		const idleCommands = register(idleController);
		const { context } = createContext();
		await idleCommands.get("tavern-template-edit")?.handler("把秒前改成 seconds ago", context);
		expect(idleCommands.sendUserMessage).toHaveBeenCalledTimes(1);
		const message = idleCommands.sendUserMessage.mock.calls[0]?.[0];
		expect(typeof message).toBe("string");
		expect(message).toContain(TEMPLATE_EDIT_PROMPT);
		expect(message).toContain("用户意图：把秒前改成 seconds ago");
		expect(idleCommands.sendUserMessage.mock.calls[0]?.[1]).toEqual({ deliverAs: "followUp" });

		// creator：拒绝（同 CE2 门禁语义）。
		const runtime = createRuntime();
		const creatorController = new TavernController(async () => runtime);
		const creatorCommands = register(creatorController);
		const { context: creatorContext, notify: creatorNotify } = createContext();
		await creatorCommands.get("tavern-new")?.handler("", creatorContext);
		await creatorCommands.get("tavern-template-edit")?.handler("", creatorContext);
		expect(creatorNotify).toHaveBeenCalledWith(ERROR_TEMPLATE_EDIT_STATE, "error");
		expect(creatorCommands.sendUserMessage).not.toHaveBeenCalled();

		// busy：排队提示（复用 character-edit 排队文案，不 throw）。
		const busyController = new TavernController();
		const busyCommands = register(busyController);
		const { context: busyContext, notify: busyNotify } = createContext({ isIdle: false });
		await busyCommands.get("tavern-template-edit")?.handler("", busyContext);
		expect(busyNotify).toHaveBeenCalledWith(NOTIFY_COMMAND_QUEUED, "info");
		expect(busyCommands.sendUserMessage).toHaveBeenCalledTimes(1);
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
