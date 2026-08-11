import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";
import { readActiveDescriptor } from "../../../src/data/discovery/active-descriptor.js";
import { DEFAULT_WELCOME_MESSAGE } from "../../../src/shared/constants.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-runtime-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CreatorRuntime", () => {
	it("starts a new empty group chat and publishes it only after listening", async () => {
		const root = await createTemporaryDirectory();
		const canonicalCwd = join(root, "project");
		const runtime = await CreatorRuntime.startNew({
			cwd: `${root}/nested/../project`,
			agentDir: join(root, "agent"),
		});

		expect(runtime.activeDescriptor.host).toBe("127.0.0.1");
		expect(runtime.activeDescriptor.port).toBeGreaterThan(0);
		expect(runtime.activeDescriptor.cwd).toBe(canonicalCwd);
		expect(runtime.state.groupChat.groupMaxMessages).toBe(20);
		expect(runtime.state.round).toBeNull();
		expect(await readActiveDescriptor(runtime.activeDescriptorPath)).toEqual(runtime.activeDescriptor);
		expect(runtime.state.groupChat.groupChatId).toBeTruthy();
		expect(await jsonlFilesUnder(join(root, "agent"))).toEqual([]);

		await runtime.close();
	});

	it("updates runtime-only metadata while the group chat is empty", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			configMaxMessages: 12,
		});

		expect(await runtime.setName("  Architecture\nReview  ")).toBe("Architecture Review");
		await runtime.setMaxMessages(18);

		expect(runtime.state.groupChat.name).toBe("Architecture Review");
		expect(runtime.state.groupChat.groupMaxMessages).toBe(18);
		expect((await readActiveDescriptor(runtime.activeDescriptorPath))?.name).toBe("Architecture Review");
		expect(await jsonlFilesUnder(join(root, "agent"))).toEqual([]);

		// 首条消息继承最新的群聊最大消息数（18），而非配置值（12）
		await runtime.submitUserPersonaMessage("Hello");
		expect(runtime.state.round?.roundMaxMessages).toBe(18);

		expect(await jsonlFilesUnder(join(root, "agent"))).toHaveLength(1);

		await runtime.close();
	});

	it("closes idempotently without creating an empty session file", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		await Promise.all([runtime.close(), runtime.close()]);

		expect(await readActiveDescriptor(runtime.activeDescriptorPath)).toBeNull();
		expect(runtime.webSocketServer.address()).toBeNull();
		expect(await jsonlFilesUnder(join(root, "agent"))).toEqual([]);
	});

	it("closes the listening server when descriptor publication fails", async () => {
		const root = await createTemporaryDirectory();
		let allocatedPort: number | undefined;

		await expect(
			CreatorRuntime.startNew(
				{
					cwd: join(root, "project"),
					agentDir: join(root, "agent"),
				},
				{
					publishDescriptor: async (_agentDir, descriptor) => {
						allocatedPort = descriptor.port;
						throw new Error("publication failed");
					},
				},
			),
		).rejects.toThrow("publication failed");

		expect(allocatedPort).toBeDefined();
		await expectConnectionRefused(allocatedPort as number);
		expect(await jsonlFilesUnder(join(root, "agent"))).toEqual([]);
	});

	it("persists a user persona message and creates the first round", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		await runtime.submitUserPersonaMessage("Hello from user persona");

		// 轮次创建，继承群聊最大消息数
		expect(runtime.state.round).toEqual({
			roundMaxMessages: 20,
			usedMessages: 0,
		});

		// 消息已持久化到群聊 JSONL 文件
		const jsonlFiles = await jsonlFilesUnder(join(root, "agent"));
		expect(jsonlFiles).toHaveLength(1);

		const firstFile = jsonlFiles[0];
		expect(firstFile).toBeDefined();
		const sessionPath = join(root, "agent", firstFile as string);
		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(1);

		// 首行为会话头
		const firstLine = lines[0];
		expect(firstLine).toBeDefined();
		const header = JSON.parse(firstLine as string);
		expect(header.type).toBe("session");
		expect(header.id).toBe(runtime.state.groupChat.groupChatId);
		expect(typeof header.timestamp).toBe("string");
		expect(header.timestamp).toBe(runtime.state.groupChat.createdAt);
		expect(header.version).toBe(3);
		expect(header.cwd).toBe(runtime.activeDescriptor.cwd);

		// 解析全部条目以便按索引查找
		const allEntries = lines.map((l) => JSON.parse(l)) as Record<string, unknown>[];

		// 校验 session_info 条目（群聊首次持久化时已有名称才会写入）
		const sessionInfoEntry = allEntries.find((e) => e.type === "session_info");
		expect(sessionInfoEntry).toBeUndefined(); // 未设置名称，故无 session_info

		// 校验 group-settings 条目
		const settingsEntry = allEntries.find((e) => e.type === "custom" && e.customType === "pi-tavern.group-settings");
		expect(settingsEntry).toBeDefined();
		if (!settingsEntry) return;
		expect(settingsEntry.type).toBe("custom");
		expect(settingsEntry.customType).toBe("pi-tavern.group-settings");
		expect(typeof settingsEntry.id).toBe("string");
		expect(typeof settingsEntry.timestamp).toBe("string");
		expect(settingsEntry.data).toEqual({ group_max_messages: 20 });

		// 校验公开消息条目
		const publicEntry = allEntries.find((e) => e.type === "custom_message");
		expect(publicEntry).toBeDefined();
		if (!publicEntry) return;
		expect(publicEntry.customType).toBe("pi-tavern.public-message");
		expect(publicEntry.display).toBe(true);
		expect(typeof publicEntry.id).toBe("string");
		expect(typeof publicEntry.timestamp).toBe("string");
		// parentId 链到 settings 条目
		expect(publicEntry.parentId).toBe(settingsEntry.id);
		// 内容遵循 formatEntryContent 格式
		expect(publicEntry.content).toBe("User Persona:\nHello from user persona\n");
		// 详情
		const details = publicEntry.details as Record<string, unknown>;
		expect(details.sender).toEqual({ type: "user_persona" });
		expect(details.content).toBe("Hello from user persona");
		expect(details.sequence).toBe(1);
		// details 不得再携带时间戳——条目信封是时间的唯一来源（BC-19）
		expect(details.timestamp).toBeUndefined();
		expect(typeof publicEntry.timestamp).toBe("string");
		expect(details.round).toEqual({
			round_max_messages: 20,
			used_messages: 0,
			remaining_messages: 20,
		});

		await runtime.close();
	});

	it("persists session_info entry when group has a name at first persist", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		// 在首条消息前设置群聊名称
		await runtime.setName("My Tavern");

		await runtime.submitUserPersonaMessage("Hello");

		const jsonlFiles = await jsonlFilesUnder(join(root, "agent"));
		expect(jsonlFiles).toHaveLength(1);
		const sessionPath = join(root, "agent", jsonlFiles[0] as string);
		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");
		const allEntries = lines.map((l) => JSON.parse(l)) as Record<string, unknown>[];

		// session_info 条目存在
		const sessionInfoEntry = allEntries.find((e) => e.type === "session_info");
		expect(sessionInfoEntry).toBeDefined();
		if (!sessionInfoEntry) return;
		expect(sessionInfoEntry.type).toBe("session_info");
		expect(sessionInfoEntry.name).toBe("My Tavern");
		expect(typeof sessionInfoEntry.id).toBe("string");
		expect(typeof sessionInfoEntry.timestamp).toBe("string");

		// settings 条目的 parentId 链自 session_info
		const settingsEntry = allEntries.find((e) => e.type === "custom" && e.customType === "pi-tavern.group-settings");
		expect(settingsEntry).toBeDefined();
		if (!settingsEntry) return;
		expect(settingsEntry.parentId).toBe(sessionInfoEntry.id);

		await runtime.close();
	});

	it("appends session_info after setName when group chat is started", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		// 首条消息创建群聊，持久化文件头与条目
		await runtime.submitUserPersonaMessage("First");

		// 首次持久化后改名称 → 经 SessionManager.appendSessionInfo 追加
		await runtime.setName("Renamed Tavern");

		const jsonlFiles = await jsonlFilesUnder(join(root, "agent"));
		expect(jsonlFiles).toHaveLength(1);
		const sessionPath = join(root, "agent", jsonlFiles[0] as string);
		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");
		const allEntries = lines.map((l) => JSON.parse(l)) as Record<string, unknown>[];

		// 最后一条应为新的 session_info
		const lastEntry = allEntries[allEntries.length - 1];
		expect(lastEntry).toBeDefined();
		if (!lastEntry) return;
		expect(lastEntry.type).toBe("session_info");
		expect(lastEntry.name).toBe("Renamed Tavern");
		expect(typeof lastEntry.id).toBe("string");
		expect(typeof lastEntry.parentId).toBe("string");

		await runtime.close();
	});

	it("appends group-settings after setMaxMessages when group chat is started", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		// 首条消息创建群聊，持久化文件头与条目
		await runtime.submitUserPersonaMessage("First");

		// 首次持久化后改最大消息数 → 经 SessionManager.appendCustomEntry 追加
		await runtime.setMaxMessages(5);

		const jsonlFiles = await jsonlFilesUnder(join(root, "agent"));
		expect(jsonlFiles).toHaveLength(1);
		const sessionPath = join(root, "agent", jsonlFiles[0] as string);
		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");
		const allEntries = lines.map((l) => JSON.parse(l)) as Record<string, unknown>[];

		// 最后一条应为新的 group-settings
		const lastEntry = allEntries[allEntries.length - 1];
		expect(lastEntry).toBeDefined();
		if (!lastEntry) return;
		expect(lastEntry.type).toBe("custom");
		expect(lastEntry.customType).toBe("pi-tavern.group-settings");
		expect(lastEntry.data).toEqual({ group_max_messages: 5 });
		expect(typeof lastEntry.id).toBe("string");
		expect(typeof lastEntry.parentId).toBe("string");

		await runtime.close();
	});

	it("second user persona message creates a new round resetting usedMessages and handRaised", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// 首条消息创建初始轮次
		await runtime.submitUserPersonaMessage("First");
		expect(runtime.state.round?.roundMaxMessages).toBe(20);
		expect(runtime.state.round?.usedMessages).toBe(0);

		// 加入角色并设置手举标志
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "join_group_chat", params: { session_id: "s1" } }));
		await waitForMessage(client, "response");
		client.send(
			JSON.stringify({ jsonrpc: "2.0", id: "2", method: "claim_character", params: { character_id: "dev" } }),
		);
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "3", method: "character_ready" }));
		await waitForMessage(client, "response");

		// 模拟上一轮已用消息数与手举标志
		expect(runtime.state.round).toBeDefined();
		if (runtime.state.round) runtime.state.round.usedMessages = 3;
		for (const c of runtime.state.onlineCharacters.values()) {
			c.handRaised = true;
		}

		// 第二条消息开启新轮次，重置 usedMessages 并清除手举标志
		await runtime.submitUserPersonaMessage("Second");
		expect(runtime.state.round?.roundMaxMessages).toBe(20);
		expect(runtime.state.round?.usedMessages).toBe(0);
		for (const c of runtime.state.onlineCharacters.values()) {
			expect(c.handRaised).toBe(false);
		}

		client.close();
		await runtime.close();
	});

	it("new round inherits updated groupMaxMessages after setMaxMessages", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		// 用默认群聊最大消息数 10 创建首个轮次
		await runtime.submitUserPersonaMessage("First");
		expect(runtime.state.round?.roundMaxMessages).toBe(20);

		// 修改上限并创建新轮次
		await runtime.setMaxMessages(5);
		// 当前轮次不受 setMaxMessages 影响
		expect(runtime.state.round?.roundMaxMessages).toBe(20);

		await runtime.submitUserPersonaMessage("Second");
		expect(runtime.state.round?.roundMaxMessages).toBe(5);
		expect(runtime.state.round?.usedMessages).toBe(0);

		await runtime.close();
	});

	it("rejects invalid setMaxMessages before any persistence or state change (BC-18)", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		// 首条消息建立会话文件与轮次
		await runtime.submitUserPersonaMessage("First");
		expect(runtime.state.round?.roundMaxMessages).toBe(20);
		const [sessionFile] = await jsonlFilesUnder(join(root, "agent"));
		expect(sessionFile).toBeDefined();
		if (!sessionFile) return;
		const sessionPath = join(root, "agent", sessionFile);
		const linesBefore = (await readFile(sessionPath, "utf8")).trim().split("\n");
		const persistedCountBefore = (runtime as unknown as { persistedCount: number }).persistedCount;

		// 非法值必须在任何持久化或状态变更之前被拒绝
		for (const invalid of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
			await expect(runtime.setMaxMessages(invalid)).rejects.toThrow("non-negative safe integer");
		}

		// 未追加任何条目，持久化计数与状态均不变
		const linesAfter = (await readFile(sessionPath, "utf8")).trim().split("\n");
		expect(linesAfter).toEqual(linesBefore);
		expect((runtime as unknown as { persistedCount: number }).persistedCount).toBe(persistedCountBefore);
		expect(runtime.state.groupChat.groupMaxMessages).toBe(20);

		// 后续合法操作仍然成功
		await runtime.setMaxMessages(5);
		expect(runtime.state.groupChat.groupMaxMessages).toBe(5);

		await runtime.close();
	});

	it("does not commit round state when first persist fails", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew(
			{
				cwd: join(root, "project"),
				agentDir: join(root, "agent"),
			},
			{
				writeFile: () => Promise.reject(new Error("disk full")),
			},
		);

		await expect(runtime.submitUserPersonaMessage("Hello")).rejects.toThrow("disk full");

		// 持久化失败后不得提交状态
		expect(runtime.state.round).toBeNull();

		await runtime.close();
	});

	it("allows retry after first-persist partial failure is rolled back", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		// 模拟首个 appendCustomMessageEntry 失败
		const sm = (runtime as unknown as { groupSessionManager: { appendCustomMessageEntry: typeof vi.fn } })
			.groupSessionManager;
		const spy = vi.spyOn(sm, "appendCustomMessageEntry");
		spy.mockImplementationOnce(() => {
			throw new Error("disk full during message append");
		});

		// 首次尝试失败
		await expect(runtime.submitUserPersonaMessage("First")).rejects.toThrow("disk full during message append");

		expect(runtime.state.round).toBeNull();
		expect((runtime as unknown as { persistedCount: number }).persistedCount).toBe(0);

		// 校验回滚后不残留 JSONL 文件
		expect(await jsonlFilesUnder(join(root, "agent"))).toEqual([]);

		// 恢复真实追加逻辑并重试
		spy.mockRestore();
		await runtime.submitUserPersonaMessage("First");

		// 第二次尝试成功
		expect(runtime.state.round).toEqual({ roundMaxMessages: 20, usedMessages: 0 });
		expect(await jsonlFilesUnder(join(root, "agent"))).toHaveLength(1);

		await runtime.close();
	});

	it("enters persistence-fatal when rollback rm fails (BC-2)", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew(
			{
				cwd: join(root, "project"),
				agentDir: join(root, "agent"),
			},
			{
				rm: () => Promise.reject(new Error("permission denied")),
			},
		);

		// 模拟首条公开消息追加失败 → 回滚尝试删除半初始化文件
		const sm = (runtime as unknown as { groupSessionManager: { appendCustomMessageEntry: typeof vi.fn } })
			.groupSessionManager;
		vi.spyOn(sm, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("disk full during message append");
		});

		// rm 失败 → 回滚报告删除失败
		await expect(runtime.submitUserPersonaMessage("First")).rejects.toThrow(
			/Failed to delete half-initialized session file/,
		);

		// 运行时进入持久化致命态：后续所有写入都被拒绝
		await expect(runtime.submitUserPersonaMessage("Second")).rejects.toThrow(/persistence is broken/i);

		await runtime.close();
	});

	it("leaves no half-initialized JSONL when first persist fails and runtime closes (BC-2)", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		const sm = (runtime as unknown as { groupSessionManager: { appendCustomMessageEntry: typeof vi.fn } })
			.groupSessionManager;
		vi.spyOn(sm, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("disk full during message append");
		});

		// 首次持久化失败并干净回滚
		await expect(runtime.submitUserPersonaMessage("First")).rejects.toThrow("disk full during message append");
		expect(await jsonlFilesUnder(join(root, "agent"))).toEqual([]);

		// 失败持久化后立即关闭不得复活半成品文件
		await runtime.close();
		expect(await jsonlFilesUnder(join(root, "agent"))).toEqual([]);
	});

	it("broadcasts the public message to online characters", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// 连接 WebSocket 客户端并完成加入流程
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);

		// join_group_chat（加入群聊）
		client.send(
			JSON.stringify({ jsonrpc: "2.0", id: "1", method: "join_group_chat", params: { session_id: "session-1" } }),
		);
		await waitForMessage(client, "response");
		// claim_character（认领角色）
		client.send(
			JSON.stringify({ jsonrpc: "2.0", id: "2", method: "claim_character", params: { character_id: "dev" } }),
		);
		await waitForMessage(client, "response");
		// character_ready（角色就绪）
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "3", method: "character_ready" }));
		const readyResponse = await waitForMessage(client, "response");
		expect(readyResponse.error).toBeUndefined();

		// 提交用户 persona 消息并等待广播事件
		interface PublicMessage {
			jsonrpc: string;
			method: string;
			params: Record<string, unknown>;
		}
		const broadcastPromise = new Promise<PublicMessage>((resolve) => {
			const onMessage = (data: WebSocket.RawData) => {
				const message = JSON.parse(data.toString()) as PublicMessage;
				if (message.method === "group_chat_update") {
					client.off("message", onMessage);
					resolve(message);
				}
			};
			client.on("message", onMessage);
		});

		await runtime.submitUserPersonaMessage("Hello everyone");

		const publicMessage = await broadcastPromise;

		// 广播即 group_chat_update 通知；
		// 预览携带消息内容。
		const publicMessageParams = publicMessage.params as Record<string, unknown>;

		// 广播即 group_chat_update 通知；
		// 预览携带消息内容。
		const preview = publicMessageParams.preview_messages as PublicMessage[];
		expect(preview.at(-1)?.params?.content).toBe("Hello everyone");
		expect(preview.at(-1)?.params.sender).toEqual({ type: "user_persona" });
		expect(preview.at(-1)?.params.round).toEqual({ round_max_messages: 20, used_messages: 0, remaining_messages: 20 });
		expect(typeof preview.at(-1)?.params.event_id).toBe("string");
		expect(typeof preview.at(-1)?.params?.sequence).toBe("number");
		expect(typeof preview.at(-1)?.params.timestamp).toBe("string");
		expect(publicMessageParams.latest_sequence).toBeGreaterThan(0);
		expect(publicMessageParams.total_messages).toBeGreaterThan(0);

		// BC-3：广播时间戳必须与 JSONL 条目信封时间戳完全一致
		const [sessionFile] = await jsonlFilesUnder(join(root, "agent"));
		expect(sessionFile).toBeDefined();
		if (sessionFile) {
			const sessionPath = join(root, "agent", sessionFile);
			const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");
			const publicEntry = lines
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.find((entry) => entry.type === "custom_message");
			expect(publicEntry).toBeDefined();
			if (publicEntry) {
				expect(preview.at(-1)?.params.timestamp).toBe(publicEntry.timestamp);
				expect(preview.at(-1)?.params.event_id).toBe(publicEntry.id);
			}
		}

		client.close();
		await runtime.close();
	});

	it("broadcast still delivers to clients when onPublicMessage throws", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [{ characterId: "dev", name: "Dev", description: "", path: "/x.md", prompt: "" }],
		});

		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "join_group_chat", params: { session_id: "s1" } }));
		await waitForMessage(client, "response");
		client.send(
			JSON.stringify({ jsonrpc: "2.0", id: "2", method: "claim_character", params: { character_id: "dev" } }),
		);
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "3", method: "character_ready" }));
		await waitForMessage(client, "response");

		// 设置一个会抛错的 onPublicMessage 处理器
		runtime.onPublicMessage = () => {
			throw new Error("TUI broken");
		};

		// 等待广播
		const broadcastPromise = new Promise<boolean>((resolve) => {
			const onMsg = (data: WebSocket.RawData) => {
				const msg = JSON.parse(data.toString()) as { method: string };
				if (msg.method === "group_chat_update") {
					client.off("message", onMsg);
					resolve(true);
				}
			};
			client.on("message", onMsg);
		});

		// 不应抛错——onPublicMessage 的错误在内部被捕获
		await runtime.submitUserPersonaMessage("Hello");

		// 尽管 onPublicMessage 抛错，广播仍然送达
		await expect(broadcastPromise).resolves.toBe(true);

		client.close();
		await runtime.close();
	});

	it("onPublicMessage fires when broadcaster has no connected clients", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		let tuiMessage: unknown = null;
		runtime.onPublicMessage = (msg) => {
			tuiMessage = msg;
		};

		// 无连接客户端 → 广播迭代为空操作
		await runtime.submitUserPersonaMessage("Solo message");

		expect(tuiMessage).not.toBeNull();
		expect((tuiMessage as { content: string }).content).toBe("Solo message");

		await runtime.close();
	});

	it("fires onPublicMessageError when onPublicMessage callback throws", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		runtime.onPublicMessage = () => {
			throw new Error("callback crash");
		};
		const errorCalls: Array<{ error: string; sequence: number; timestamp: string }> = [];
		runtime.onPublicMessageError = (error, sequence, timestamp) => {
			errorCalls.push({ error, sequence, timestamp });
		};

		await runtime.submitUserPersonaMessage("Hello");

		expect(errorCalls).toHaveLength(1);
		expect(errorCalls[0]?.error).toContain("TUI projection failed: callback crash");
		expect(errorCalls[0]?.sequence).toBe(1);
		expect(typeof errorCalls[0]?.timestamp).toBe("string");

		await runtime.close();
	});

	it("rejects speak when message exceeds 64 KiB", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// 加入一个角色
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.send(
			JSON.stringify({ jsonrpc: "2.0", id: "1", method: "join_group_chat", params: { session_id: "session-1" } }),
		);
		await waitForMessage(client, "response");
		client.send(
			JSON.stringify({ jsonrpc: "2.0", id: "2", method: "claim_character", params: { character_id: "dev" } }),
		);
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "3", method: "character_ready" }));
		await waitForMessage(client, "response");

		// 先创建一个轮次
		await runtime.submitUserPersonaMessage("Start the round");

		// 发送超过 64 KiB 的消息
		const bigMessage = "x".repeat(64 * 1024 + 1);
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "4", method: "speak", params: { content: bigMessage } }));
		const speakResponse = await waitForMessage(client, "response");

		expect(speakResponse.result).toBeUndefined();
		expect((speakResponse.error as { message: string }).message).toContain("exceeds 64 KiB");

		client.close();
		await runtime.close();
	});

	it("publishes a character speak message and increments round usage", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// 加入一个角色
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.send(
			JSON.stringify({ jsonrpc: "2.0", id: "1", method: "join_group_chat", params: { session_id: "session-1" } }),
		);
		await waitForMessage(client, "response");
		client.send(
			JSON.stringify({ jsonrpc: "2.0", id: "2", method: "claim_character", params: { character_id: "dev" } }),
		);
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "3", method: "character_ready" }));
		await waitForMessage(client, "response");

		// 先创建一个轮次
		await runtime.submitUserPersonaMessage("Start the round");
		expect(runtime.state.round?.usedMessages).toBe(0);

		// 模拟上一轮配额耗尽的发言留下的手举标志
		for (const c of runtime.state.onlineCharacters.values()) {
			c.handRaised = true;
		}

		// 捕获发送者 socket 上的所有入站消息
		const receivedMessages: Record<string, unknown>[] = [];
		client.on("message", (data) => {
			receivedMessages.push(JSON.parse(data.toString()) as Record<string, unknown>);
		});

		// 发送发言消息；同时验证发送者收到自己的广播
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "4", method: "speak", params: { content: "My public reply" } }));

		const speakResponse = await waitForMessage(client, "response");

		// 发送者也收到 group_chat_update 通知（广播
		// 包含所有在线成员；预览携带新消息）。
		const senderEcho = receivedMessages.find(
			(m) =>
				m.method === "group_chat_update" &&
				(
					(m.params as Record<string, unknown>).preview_messages as Array<{
						params?: { content?: unknown; sequence?: unknown; timestamp?: unknown; event_id?: unknown };
					}>
				).some((p) => (p.params as Record<string, unknown>).content === "My public reply"),
		);
		expect(senderEcho).toBeDefined();

		expect(speakResponse.error).toBeUndefined();
		expect(speakResponse.result).toEqual({
			published: true,
			event_id: expect.any(String) as string,
			sequence: expect.any(Number) as number,
			//  B6：成功响应携带 latest_sequence（== 已发布序号
			// 成功时）以便客户端越过自己的消息推进游标。
			latest_sequence: expect.any(Number) as number,
			round: { round_max_messages: 20, used_messages: 1, remaining_messages: 19 },
		});

		// 轮次已用数递增
		expect(runtime.state.round?.usedMessages).toBe(1);
		// 成功发言后自己的手举标志被清除
		for (const c of runtime.state.onlineCharacters.values()) {
			expect(c.handRaised).toBe(false);
		}

		// 消息已持久化到 JSONL
		const jsonlFiles = await jsonlFilesUnder(join(root, "agent"));
		expect(jsonlFiles).toHaveLength(1);

		const firstFile = jsonlFiles[0];
		expect(firstFile).toBeDefined();
		const sessionPath = join(root, "agent", firstFile as string);
		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");

		// 校验角色公开消息条目存在
		const publicEntry = lines
			.map((l) => JSON.parse(l))
			.find(
				(e: Record<string, unknown>) =>
					e.type === "custom_message" &&
					e.customType === "pi-tavern.public-message" &&
					typeof e.content === "string" &&
					(e.content as string).includes("My public reply"),
			);
		expect(publicEntry).toBeDefined();
		expect(publicEntry.type).toBe("custom_message");
		expect(publicEntry.content).toContain("My public reply");
		expect(publicEntry.details.sender).toEqual({
			type: "character",
			character_id: "dev",
			name: "Developer",
		});

		// 广播时间戳与持久化条目时间戳一致（
		// 预览携带持久化后的消息字段）。
		const echoPreview = ((senderEcho as Record<string, unknown>).params as Record<string, unknown>)
			.preview_messages as Array<{
			params?: { content?: unknown; sequence?: unknown; timestamp?: unknown; event_id?: unknown };
		}>;
		expect(echoPreview.at(-1)?.params?.timestamp).toBe(publicEntry.timestamp);
		expect((publicEntry?.details as Record<string, unknown>).round).toEqual({
			round_max_messages: 20,
			used_messages: 1,
			remaining_messages: 19,
		});
		expect(typeof (publicEntry?.details as Record<string, unknown>).sequence).toBe("number");
		// details 不得再携带时间戳（BC-19）
		expect(publicEntry.details.timestamp).toBeUndefined();
		expect(publicEntry.details.content).toBe("My public reply");

		client.close();
		await runtime.close();
	});

	it("returns speak failure when persist throws and does not mutate state", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// 加入一个角色
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.send(
			JSON.stringify({ jsonrpc: "2.0", id: "1", method: "join_group_chat", params: { session_id: "session-1" } }),
		);
		await waitForMessage(client, "response");
		client.send(
			JSON.stringify({ jsonrpc: "2.0", id: "2", method: "claim_character", params: { character_id: "dev" } }),
		);
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "3", method: "character_ready" }));
		await waitForMessage(client, "response");

		// 先创建一个轮次
		await runtime.submitUserPersonaMessage("Start the round");

		const roundBefore = { ...runtime.state.round };
		const handRaisedBefore = (() => {
			for (const c of runtime.state.onlineCharacters.values()) return c.handRaised;
			return undefined;
		})();

		// 监视 SessionManager 以模拟持久化失败
		const sessionManager = (runtime as unknown as { groupSessionManager: { appendCustomMessageEntry: typeof vi.fn } })
			.groupSessionManager;
		vi.spyOn(sessionManager, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("disk full");
		});

		client.send(JSON.stringify({ jsonrpc: "2.0", id: "4", method: "speak", params: { content: "This should fail" } }));
		const speakResponse = await waitForMessage(client, "response");

		// 响应表明失败
		expect(speakResponse.result).toBeUndefined();
		expect((speakResponse.error as { message: string }).message).toContain("disk full");

		// 持久化失败后状态不得变更
		expect(runtime.state.round?.usedMessages).toBe(roundBefore?.usedMessages ?? 0);

		// 手举标志不变
		for (const c of runtime.state.onlineCharacters.values()) {
			expect(c.handRaised).toBe(handRaisedBefore ?? false);
		}

		client.close();
		await runtime.close();
	});

	it("recovers SessionManager leaf after append failure so next entry parentId is correct", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [{ characterId: "dev", name: "Dev", description: "", path: "/x.md", prompt: "" }],
		});

		// 首条消息建立会话文件
		await runtime.submitUserPersonaMessage("First");

		// 加入角色用于发言
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "join_group_chat", params: { session_id: "s1" } }));
		await waitForMessage(client, "response");
		client.send(
			JSON.stringify({ jsonrpc: "2.0", id: "2", method: "claim_character", params: { character_id: "dev" } }),
		);
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "3", method: "character_ready" }));
		await waitForMessage(client, "response");

		// 模拟追加失败。监视器在 SessionManager 的
		// _appendEntry 变更内存状态之前抛错，因此叶子并未真正被污染。
		// 但恢复代码路径（setSessionFile 重载）仍被
		// 等价地执行，且下方 parentId 断言验证其正确性。
		const sm = (runtime as unknown as { groupSessionManager: { appendCustomMessageEntry: typeof vi.fn } })
			.groupSessionManager;
		vi.spyOn(sm, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("disk full");
		});

		client.send(JSON.stringify({ jsonrpc: "2.0", id: "4", method: "speak", params: { content: "Failing speak" } }));
		const failResponse = await waitForMessage(client, "response");
		expect(failResponse.result).toBeUndefined();

		// 恢复：setSessionFile 已被调用，叶子干净。
		// 后续成功的发言应把 parentId 链到磁盘上的真实叶子，
		// 而非失败的（从未持久化的）条目。
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "5", method: "speak", params: { content: "Recovered speak" } }));
		const okResponse = await waitForMessage(client, "response");
		expect(okResponse.error).toBeUndefined();

		// 校验成功的消息以正确的 parentId 链持久化
		const jsonlFiles = await jsonlFilesUnder(join(root, "agent"));
		expect(jsonlFiles).toHaveLength(1);
		const sessionPath = join(root, "agent", jsonlFiles[0] as string);
		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");
		const entries = lines.map((l) => JSON.parse(l)) as Record<string, unknown>[];

		// 最后一条应为恢复后的发言
		const lastEntry = entries[entries.length - 1];
		expect(lastEntry?.type).toBe("custom_message");
		expect((lastEntry as Record<string, unknown>)?.content).toContain("Recovered speak");
		// 其 parentId 必须指向真实的磁盘条目，而非失败的条目
		const parentId = (lastEntry as Record<string, unknown>)?.parentId as string;
		expect(typeof parentId).toBe("string");
		const parentExists = entries.some((e) => e.id === parentId);
		expect(parentExists).toBe(true);

		client.close();
		await runtime.close();
	});

	it("recovers SessionManager leaf after setName append failure", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		await runtime.submitUserPersonaMessage("First");

		// 模拟追加失败（覆盖恢复路径）
		const sm = (runtime as unknown as { groupSessionManager: { appendSessionInfo: typeof vi.fn } }).groupSessionManager;
		vi.spyOn(sm, "appendSessionInfo").mockImplementationOnce(() => {
			throw new Error("disk full");
		});

		await expect(runtime.setName("After Crash")).rejects.toThrow("disk full");

		// 恢复成功——后续 setName 应链到正确的磁盘叶子
		await runtime.setName("Recovered Name");
		expect(runtime.state.groupChat.name).toBe("Recovered Name");

		// 校验成功的 session_info 已持久化
		const jsonlFiles = await jsonlFilesUnder(join(root, "agent"));
		const sessionPath = join(root, "agent", jsonlFiles[0] as string);
		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");
		const entries = lines.map((l) => JSON.parse(l)) as Record<string, unknown>[];
		const lastSessionInfo = entries.reverse().find((e) => e.type === "session_info");
		expect(lastSessionInfo).toBeDefined();
		expect((lastSessionInfo as Record<string, unknown>)?.name).toBe("Recovered Name");
		// parentId 必须指向真实的磁盘条目
		const parentId = (lastSessionInfo as Record<string, unknown>)?.parentId as string;
		expect(typeof parentId).toBe("string");
		expect(entries.some((e) => e.id === parentId)).toBe(true);

		await runtime.close();
	});

	it("recovers SessionManager leaf after setMaxMessages append failure", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		await runtime.submitUserPersonaMessage("First");

		// 模拟追加失败（覆盖恢复路径）
		const sm = (runtime as unknown as { groupSessionManager: { appendCustomEntry: typeof vi.fn } }).groupSessionManager;
		vi.spyOn(sm, "appendCustomEntry").mockImplementationOnce(() => {
			throw new Error("disk full");
		});

		await expect(runtime.setMaxMessages(7)).rejects.toThrow("disk full");

		// 恢复成功——后续 setMaxMessages 应正常工作
		await runtime.setMaxMessages(7);
		expect(runtime.state.groupChat.groupMaxMessages).toBe(7);

		// 校验成功的 group-settings 条目已持久化
		const jsonlFiles = await jsonlFilesUnder(join(root, "agent"));
		const sessionPath = join(root, "agent", jsonlFiles[0] as string);
		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");
		const entries = lines.map((l) => JSON.parse(l)) as Record<string, unknown>[];
		const lastSettings = entries
			.reverse()
			.find((e) => e.type === "custom" && e.customType === "pi-tavern.group-settings");
		expect(lastSettings).toBeDefined();
		expect((lastSettings as Record<string, unknown>)?.data).toEqual({ group_max_messages: 7 });
		const parentId = (lastSettings as Record<string, unknown>)?.parentId as string;
		expect(typeof parentId).toBe("string");
		expect(entries.some((e) => e.id === parentId)).toBe(true);

		await runtime.close();
	});

	it("rejects all writes after persistence recovery fails (fatal)", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [{ characterId: "dev", name: "Dev", description: "", path: "/x.md", prompt: "" }],
		});

		// 首条消息建立会话文件
		await runtime.submitUserPersonaMessage("First");
		const roundBefore = { ...runtime.state.round };

		// 模拟：追加失败且 setSessionFile 也失败 → 持久化致命
		const sm = (
			runtime as unknown as {
				groupSessionManager: { appendCustomMessageEntry: typeof vi.fn; setSessionFile: typeof vi.fn };
			}
		).groupSessionManager;
		vi.spyOn(sm, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		vi.spyOn(sm, "setSessionFile").mockImplementationOnce(() => {
			throw new Error("cannot read file");
		});

		// 首次写入以恢复错误失败
		await expect(runtime.submitUserPersonaMessage("Second")).rejects.toThrow(/ersistence recovery failed/);

		// 写入失败后状态不变
		expect(runtime.state.round?.usedMessages).toBe(roundBefore?.usedMessages);

		// 后续写入被拒绝
		await expect(runtime.submitUserPersonaMessage("Third")).rejects.toThrow(/ersistence is broken/);
		await expect(runtime.setName("New Name")).rejects.toThrow(/ersistence is broken/);
		await expect(runtime.setMaxMessages(5)).rejects.toThrow(/ersistence is broken/);

		// 无新的 JSONL 文件
		expect(await jsonlFilesUnder(join(root, "agent"))).toHaveLength(1);

		await runtime.close();
	});

	it("rejects speak after persistence fatal without mutating state", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [{ characterId: "dev", name: "Dev", description: "", path: "/x.md", prompt: "" }],
		});

		await runtime.submitUserPersonaMessage("First");

		// 加入一个角色
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "join_group_chat", params: { session_id: "s1" } }));
		await waitForMessage(client, "response");
		client.send(
			JSON.stringify({ jsonrpc: "2.0", id: "2", method: "claim_character", params: { character_id: "dev" } }),
		);
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "3", method: "character_ready" }));
		await waitForMessage(client, "response");

		const roundBefore = { ...runtime.state.round };

		// 触发致命：追加失败 + setSessionFile 失败
		const sm = (
			runtime as unknown as {
				groupSessionManager: { appendCustomMessageEntry: typeof vi.fn; setSessionFile: typeof vi.fn };
			}
		).groupSessionManager;
		vi.spyOn(sm, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		vi.spyOn(sm, "setSessionFile").mockImplementationOnce(() => {
			throw new Error("cannot read");
		});

		client.send(JSON.stringify({ jsonrpc: "2.0", id: "4", method: "speak", params: { content: "Triggers fatal" } }));
		const fatalResponse = await waitForMessage(client, "response");
		expect(fatalResponse.result).toBeUndefined();
		expect((fatalResponse.error as { message: string }).message).toContain("ersistence recovery failed");

		// 状态不变
		expect(runtime.state.round?.usedMessages).toBe(roundBefore?.usedMessages);

		// 后续发言同样被拒绝（handleSpeak 中的 assertWritable）
		client.send(
			JSON.stringify({ jsonrpc: "2.0", id: "5", method: "speak", params: { content: "Should be rejected" } }),
		);
		const rejectedResponse = await waitForMessage(client, "response");
		expect(rejectedResponse.result).toBeUndefined();
		expect((rejectedResponse.error as { message: string }).message).toContain("ersistence is broken");

		client.close();
		await runtime.close();
	});

	it("rejects speak when round limit reached and sets hand raised", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			configMaxMessages: 1,
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// 加入角色并创建最多 1 条消息的轮次
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.send(
			JSON.stringify({ jsonrpc: "2.0", id: "1", method: "join_group_chat", params: { session_id: "session-1" } }),
		);
		await waitForMessage(client, "response");
		client.send(
			JSON.stringify({ jsonrpc: "2.0", id: "2", method: "claim_character", params: { character_id: "dev" } }),
		);
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "3", method: "character_ready" }));
		await waitForMessage(client, "response");

		await runtime.submitUserPersonaMessage("Start");

		// 耗尽轮次配额
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "4", method: "speak", params: { content: "First and only" } }));
		const firstResponse = await waitForMessage(client, "response");
		expect((firstResponse as { result: { published: boolean } }).result.published).toBe(true);
		expect(runtime.state.round?.usedMessages).toBe(1);

		// 下一条发言应被拒绝
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "5", method: "speak", params: { content: "Too late" } }));
		const secondResponse = await waitForMessage(client, "response");

		expect(secondResponse.error).toBeUndefined();
		expect(secondResponse.result).toEqual({
			published: false,
			reason: "round_limit_reached",
			hand_raised: true,
			round: { round_max_messages: 1, used_messages: 1, remaining_messages: 0 },
		});

		// 已用消息数不变
		expect(runtime.state.round?.usedMessages).toBe(1);

		client.close();
		await runtime.close();
	});

	it("ready 后收 system_message 欢迎（WL1）；历史经 get_message_history 主动拉取（WL3）", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// 加入前先创建两条公开消息
		await runtime.submitUserPersonaMessage("First");
		await runtime.submitUserPersonaMessage("Second");

		// 加入一个角色
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(client);
		client.send(
			JSON.stringify({ jsonrpc: "2.0", id: "1", method: "join_group_chat", params: { session_id: "session-1" } }),
		);
		await waitForMessage(client, "response");
		client.send(
			JSON.stringify({ jsonrpc: "2.0", id: "2", method: "claim_character", params: { character_id: "dev" } }),
		);
		await waitForMessage(client, "response");
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "3", method: "character_ready" }));

		// ready 后只推 system_message 欢迎（内容 = 默认文案），零 message_history。
		const welcomePromise = new Promise<Record<string, unknown>>((resolve) => {
			const onMessage = (data: WebSocket.RawData) => {
				const msg = JSON.parse(data.toString()) as Record<string, unknown>;
				if (msg.method === "system_message") {
					client.off("message", onMessage);
					resolve(msg);
				}
			};
			client.on("message", onMessage);
		});
		const welcome = await welcomePromise;
		expect(welcome.params).toEqual({
			content: DEFAULT_WELCOME_MESSAGE,
		});

		// WL3：历史仍可主动拉取——get_message_history 无 cursor 返回最近 10 条窗口。
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "4", method: "get_message_history", params: {} }));
		const historyResponse = await waitForMessage(client, "response");
		expect(historyResponse.error).toBeUndefined();
		const historyParams = historyResponse.result as Record<string, unknown>;
		expect((historyParams.messages as Array<{ params?: { content: string } }>).map((m) => m.params?.content)).toEqual([
			"First",
			"Second",
		]);
		expect(historyParams.total_messages).toBe(2);
		expect(historyParams.has_more).toBe(false);
		expect(historyParams.cursor).toBeNull();

		client.close();
		await runtime.close();
	});

	it("get_message_history 主动分页拉全量历史（15 条两页，WL3）", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// 15 条消息（超过每页 10 条窗口）：主动查询分页拉全量。
		for (let i = 1; i <= 15; i++) {
			await runtime.submitUserPersonaMessage(`Message ${i}`);
		}

		const { client } = await joinCharacter(runtime, "session-1", "dev");
		// 首页：最近 10 条（序号 6..15）+ has_more + cursor。
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "4", method: "get_message_history", params: {} }));
		const firstPage = await waitForMessage(client, "response");
		expect(firstPage.error).toBeUndefined();
		const firstData = firstPage.result as Record<string, unknown>;
		const firstMessages = (firstData.messages as Array<{ params: { sequence: number } }>) ?? [];
		expect(firstMessages.map((m) => m.params.sequence)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
		expect(firstData.total_messages).toBe(15);
		expect(firstData.has_more).toBe(true);
		expect(typeof firstData.cursor).toBe("string");

		// 第二页：游标后剩余 5 条（序号 1..5），无更多。
		client.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id: "5",
				method: "get_message_history",
				params: { cursor: firstData.cursor },
			}),
		);
		const secondPage = await waitForMessage(client, "response");
		const secondData = secondPage.result as Record<string, unknown>;
		const secondMessages = (secondData.messages as Array<{ params: { sequence: number } }>) ?? [];
		expect(secondMessages.map((m) => m.params.sequence)).toEqual([1, 2, 3, 4, 5]);
		expect(secondData.total_messages).toBe(15);
		expect(secondData.has_more).toBe(false);
		expect(secondData.cursor).toBeNull();

		client.close();
		await runtime.close();
	});

	it("get_message_history 大历史分页（105 条，首页 10 条 + has_more，WL3）", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// 105 条消息：每页 10 条窗口，分页告知，更早历史经游标获取。
		for (let i = 1; i <= 105; i++) {
			await runtime.submitUserPersonaMessage(`Message ${i}`);
		}

		const { client } = await joinCharacter(runtime, "session-2", "dev");
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "4", method: "get_message_history", params: {} }));
		const firstPage = await waitForMessage(client, "response");
		expect(firstPage.error).toBeUndefined();
		const historyParams = firstPage.result as Record<string, unknown>;
		const messages = (historyParams.messages as Array<{ params: { sequence: number } }>) ?? [];
		expect(messages).toHaveLength(10);
		expect(messages[0]?.params?.sequence).toBe(96);
		expect(messages[9]?.params?.sequence).toBe(105);
		expect(historyParams.total_messages).toBe(105);
		expect(historyParams.has_more).toBe(true);
		expect(typeof historyParams.cursor).toBe("string");

		client.close();
		await runtime.close();
	});

	it("pages older history with an opaque cursor and keeps cursor position stable", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		// 105 条消息：先主动查询首页拿 opaque cursor。
		for (let i = 1; i <= 105; i++) {
			await runtime.submitUserPersonaMessage(`Message ${i}`);
		}

		const { client } = await joinCharacter(runtime, "session-1", "dev");
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "4", method: "get_message_history", params: {} }));
		const firstPage = await waitForMessage(client, "response");
		expect(firstPage.error).toBeUndefined();
		const firstData = firstPage.result as Record<string, unknown>;
		expect(typeof firstData.cursor).toBe("string");

		// 游标翻页：首页之后（seq 86..95）一页 10 条。
		client.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id: "5",
				method: "get_message_history",
				params: { cursor: firstData.cursor },
			}),
		);
		const secondPage = await waitForMessage(client, "response");
		expect(secondPage.error).toBeUndefined();
		const data = secondPage.result as Record<string, unknown>;
		const olderMessages = (data.messages as Array<{ params: { sequence: number } }>) ?? [];
		expect(olderMessages.map((m) => m.params.sequence)).toEqual([86, 87, 88, 89, 90, 91, 92, 93, 94, 95]);
		expect(data.cursor).toBeTruthy();
		expect(data.has_more).toBe(true);
		expect(data.total_messages).toBe(105);

		// 游标之后的新消息不会移动分页边界
		await runtime.submitUserPersonaMessage("Message 106");
		client.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id: "6",
				method: "get_message_history",
				params: { cursor: firstData.cursor },
			}),
		);
		const thirdPage = await waitForMessage(client, "response");
		const thirdData = thirdPage.result as Record<string, unknown>;
		const thirdMessages = (thirdData.messages as Array<{ params: { sequence: number } }>) ?? [];
		expect(thirdMessages.map((m) => m.params.sequence)).toEqual([86, 87, 88, 89, 90, 91, 92, 93, 94, 95]);
		expect(thirdData.total_messages).toBe(106);

		client.close();
		await runtime.close();
	});

	it("returns empty history for an empty group chat", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		const { client } = await joinCharacter(runtime, "session-1", "dev");
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "4", method: "get_message_history", params: {} }));
		const firstResponse = await waitForMessage(client, "response");
		expect(firstResponse.error).toBeUndefined();
		const historyParams = firstResponse.result as Record<string, unknown>;
		expect(historyParams.messages).toEqual([]);
		expect(historyParams.cursor).toBeNull();
		expect(historyParams.has_more).toBe(false);
		expect(historyParams.total_messages).toBe(0);

		// 对空群聊显式请求历史
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "4", method: "get_message_history", params: {} }));
		const response = await waitForMessage(client, "response");
		expect(response.error).toBeUndefined();
		const data = response.result as Record<string, unknown>;
		expect(data.messages).toEqual([]);
		expect(data.cursor).toBeNull();
		expect(data.has_more).toBe(false);
		expect(data.total_messages).toBe(0);

		client.close();
		await runtime.close();
	});

	it("returns only the current group chat file for get_chat_history_file", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		const { client } = await joinCharacter(runtime, "session-1", "dev");

		// 尚未启动：JSONL 文件不存在，请求必须失败
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "4", method: "get_chat_history_file" }));
		const emptyResponse = await waitForMessage(client, "response");
		expect(emptyResponse.result).toBeUndefined();

		// 启动群聊并请求文件路径
		await runtime.submitUserPersonaMessage("First");
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "5", method: "get_chat_history_file" }));
		const response = await waitForMessage(client, "response");
		expect(response.error).toBeUndefined();
		const data = response.result as { path: string };
		expect(data.path).toBeTruthy();
		expect(data.path.endsWith(`${runtime.state.groupChat.groupChatId}.jsonl`)).toBe(true);
		const fileExists = await readFile(data.path, "utf8").then(
			() => true,
			() => false,
		);
		expect(fileExists).toBe(true);

		// 从未完成 character_ready 的连接被拒绝
		const stranger = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(stranger);
		stranger.send(
			JSON.stringify({ jsonrpc: "2.0", id: "1", method: "join_group_chat", params: { session_id: "session-9" } }),
		);
		await waitForMessage(stranger, "response");
		stranger.send(JSON.stringify({ jsonrpc: "2.0", id: "2", method: "get_chat_history_file" }));
		const rejected = await waitForMessage(stranger, "response");
		expect(rejected.result).toBeUndefined();

		stranger.close();
		client.close();
		await runtime.close();
	});

	it("resumes a group chat rebuilding name, settings, round, and sequence", async () => {
		const root = await createTemporaryDirectory();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const characters = [
			{
				characterId: "dev",
				name: "Developer",
				description: "Writes code",
				path: "/chars/dev.md",
				prompt: "You are a developer.",
			},
		];

		const original = await CreatorRuntime.startNew({ cwd, agentDir, characters });
		await original.setName("  Architecture\nReview  ");
		await original.setMaxMessages(5);
		await original.submitUserPersonaMessage("First");
		await original.submitUserPersonaMessage("Second");
		const { client } = await joinCharacter(original, "session-1", "dev");
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "4", method: "speak", params: { content: "My reply" } }));
		await waitForMessage(client, "response");
		client.close();
		await original.close();

		const [sessionFile] = await jsonlFilesUnder(agentDir);
		expect(sessionFile).toBeDefined();
		if (!sessionFile) return;
		const sessionPath = join(agentDir, sessionFile);

		const resumed = await CreatorRuntime.resume({ cwd, agentDir, sessionPath, characters });
		expect(resumed.state.groupChat.groupChatId).toBe(original.state.groupChat.groupChatId);
		expect(resumed.state.groupChat.createdAt).toBe(original.state.groupChat.createdAt);
		expect(resumed.state.groupChat.name).toBe("Architecture Review");
		expect(resumed.state.groupChat.groupMaxMessages).toBe(5);
		expect(resumed.state.round).toEqual({ roundMaxMessages: 5, usedMessages: 1 });
		expect(resumed.state.nextSequence).toBe(3);
		expect(resumed.activeDescriptor.instanceId).not.toBe(original.activeDescriptor.instanceId);
		expect(resumed.activeDescriptor.port).not.toBe(original.activeDescriptor.port);
		expect(resumed.activeDescriptor.name).toBe("Architecture Review");
		// started_at 反映恢复实例的启动时间，而非原始创建时间
		expect(resumed.activeDescriptor.startedAt).not.toBe(original.state.groupChat.createdAt);
		// 成员连接不会被恢复
		expect(resumed.state.onlineCharacters.size).toBe(0);

		// 恢复的运行时以下一个序号继续追加
		await resumed.submitUserPersonaMessage("Third");
		expect(resumed.state.nextSequence).toBe(4);
		expect(resumed.state.round?.roundMaxMessages).toBe(5);
		expect(resumed.state.round?.usedMessages).toBe(0);
		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n");
		const lastEntry = JSON.parse(lines[lines.length - 1] as string) as { details: { sequence: number } };
		expect(lastEntry.details.sequence).toBe(4);

		// 新角色 ready 后不再自动推历史——主动 get_message_history 拉取磁盘重建的历史。
		const joined = await joinCharacter(resumed, "session-2", "dev");
		joined.client.send(JSON.stringify({ jsonrpc: "2.0", id: "6", method: "get_message_history", params: {} }));
		const historyResponse = await waitForMessage(joined.client, "response");
		expect(historyResponse.error).toBeUndefined();
		const historyParams = (historyResponse.result as Record<string, unknown>) ?? {};
		const historyMessages = (historyParams.messages as Array<{ params: { sequence: number } }>) ?? [];
		expect(historyParams.total_messages).toBe(4);
		expect(historyMessages.map((m) => m.params.sequence)).toEqual([1, 2, 3, 4]);
		joined.client.close();

		await resumed.close();
	});

	it("rejects resuming an already active group chat", async () => {
		const root = await createTemporaryDirectory();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const original = await CreatorRuntime.startNew({ cwd, agentDir });
		await original.submitUserPersonaMessage("Hello");

		const [sessionFile] = await jsonlFilesUnder(agentDir);
		expect(sessionFile).toBeDefined();
		if (!sessionFile) return;
		const sessionPath = join(agentDir, sessionFile);

		await expect(CreatorRuntime.resume({ cwd, agentDir, sessionPath })).rejects.toThrow(
			/already active|active group chat/i,
		);

		await original.close();
	});

	it("rejects resuming a session file that does not exist", async () => {
		const root = await createTemporaryDirectory();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");

		await expect(
			CreatorRuntime.resume({ cwd, agentDir, sessionPath: join(agentDir, "chats", "missing.jsonl") }),
		).rejects.toThrow(/does not exist/i);
	});

	it("rejects resuming a zero-byte session file", async () => {
		const root = await createTemporaryDirectory();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const sessionDir = join(agentDir, "tavern", "chats");
		await mkdir(sessionDir, { recursive: true });
		const emptyPath = join(sessionDir, "empty.jsonl");
		await writeFile(emptyPath, "");

		// SessionManager.open() 会为空文件
		// 铸造随机的新会话 id；恢复守卫必须在任何描述符发布前拒绝它。
		await expect(CreatorRuntime.resume({ cwd, agentDir, sessionPath: emptyPath })).rejects.toThrow(/empty/i);
	});
});

describe("CreatorRuntime lifecycle alignment", () => {
	it("keeps a persisted speak even when its response cannot be delivered (BC-10)", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{ characterId: "dev", name: "Dev", description: "", path: "/x.md", prompt: "" },
				{ characterId: "qa", name: "QA", description: "", path: "/y.md", prompt: "" },
			],
		});
		const { client: memberA } = await joinCharacter(runtime, "session-a", "dev");
		const { client: memberB } = await joinCharacter(runtime, "session-b", "qa");

		// 在提交前注册轮次开始监听器，确保帧
		// 即使 ws 晚一个 tick 分发也能被消费。
		const roundStartPromise = waitForMessage(memberB, "group_chat_update");
		await runtime.submitUserPersonaMessage("Round start");
		const roundStartNotification = await roundStartPromise;
		expect(
			(
				(roundStartNotification.params as Record<string, unknown>).preview_messages as Array<{
					params?: { content?: unknown; sequence?: unknown; timestamp?: unknown; event_id?: unknown };
				}>
			).at(-1)?.params?.content,
		).toBe("Round start");

		// 失败成员的 socket 无法再投递任何内容——包括
		// 发言响应（模拟响应发送超时）。
		const failingSocket = runtime.connections.get("session-a");
		expect(failingSocket).toBeDefined();
		if (!failingSocket) return;
		vi.spyOn(failingSocket, "send").mockImplementation(() => {
			throw new Error("socket timeout");
		});

		const broadcastPromise = waitForMessage(memberB, "group_chat_update");
		memberA.send(
			JSON.stringify({ jsonrpc: "2.0", id: "s1", method: "speak", params: { content: "committed anyway" } }),
		);

		// 已提交的消息广播给健康成员……
		const broadcast = await broadcastPromise;
		const preview = (broadcast.params as Record<string, unknown>).preview_messages as Array<{
			params?: { content?: unknown; sequence?: unknown; timestamp?: unknown; event_id?: unknown };
		}>;
		expect(preview.at(-1)?.params?.content).toBe("committed anyway");
		expect(preview.at(-1)?.params?.sequence).toBe(2);
		// ……且会话文件保留已持久化的消息（无回滚）。
		const [sessionFile] = await jsonlFilesUnder(join(root, "agent"));
		expect(sessionFile).toBeDefined();
		if (sessionFile) {
			const contents = await readFile(join(root, "agent", sessionFile), "utf8");
			expect(contents).toContain("committed anyway");
		}

		await runtime.close();
	});

	it("drains in-flight operations before completing close (BC-7)", async () => {
		const root = await createTemporaryDirectory();
		let releaseAppend: () => void = () => undefined;
		let gate = Promise.resolve();
		let gated = false;
		const runtime = await CreatorRuntime.startNew(
			{ cwd: join(root, "project"), agentDir: join(root, "agent") },
			{
				writeFile: async (path, data) => {
					if (!gated) {
						gated = true;
						gate = new Promise<void>((resolve) => {
							releaseAppend = resolve;
						});
						await gate;
					}
					await writeFile(path, data);
				},
				drainTimeoutMs: 500,
			},
		);

		// 首次持久化被运行时队列门控。
		const submitPromise = runtime.submitUserPersonaMessage("Hello");
		await vi.waitFor(() => expect(gated).toBe(true));

		let closeSettled = false;
		const closePromise = runtime.close().then((result) => {
			closeSettled = true;
			return result;
		});

		// close 必须等待进行中的任务，而非与其交错执行。
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(closeSettled).toBe(false);

		releaseAppend();
		const result = await closePromise;
		await submitPromise;
		expect(result.timedOut).toBe(false);

		// 消息已持久化，且 close 仍完成了全部本地清理。
		expect(await jsonlFilesUnder(join(root, "agent"))).toHaveLength(1);
		expect(await readActiveDescriptor(runtime.activeDescriptorPath)).toBeNull();
		expect(runtime.webSocketServer.address()).toBeNull();
	});

	it("force-completes local cleanup when the queue never drains (BC-7)", async () => {
		const root = await createTemporaryDirectory();
		let gated = false;
		const runtime = await CreatorRuntime.startNew(
			{ cwd: join(root, "project"), agentDir: join(root, "agent") },
			{
				writeFile: async (path, data) => {
					if (!gated) {
						gated = true;
						await new Promise(() => undefined); // never resolves
					}
					await writeFile(path, data);
				},
				drainTimeoutMs: 50,
			},
		);

		void runtime.submitUserPersonaMessage("Hello");
		await vi.waitFor(() => expect(gated).toBe(true));

		const result = await runtime.close();
		expect(result.timedOut).toBe(true);

		// 本地清理无论如何都会完成：描述符移除、服务器关闭。
		expect(await readActiveDescriptor(runtime.activeDescriptorPath)).toBeNull();
		expect(runtime.webSocketServer.address()).toBeNull();
	});

	it("returns the same close result for concurrent close calls", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		const [first, second, third] = await Promise.all([runtime.close(), runtime.close(), runtime.close()]);
		expect(first).toBe(second);
		expect(second).toBe(third);
		expect(first.timedOut).toBe(false);
		expect(first.errors).toEqual([]);
	});

	it("keeps a responsive member online across heartbeat cycles", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew(
			{
				cwd: join(root, "project"),
				agentDir: join(root, "agent"),
				characters: [{ characterId: "dev", name: "Dev", description: "", path: "/x.md", prompt: "" }],
			},
			{ heartbeatIntervalMs: 30, heartbeatTimeoutMs: 120 },
		);
		await joinCharacter(runtime, "session-1", "dev");

		// 与自动响应客户端进行若干次 ping/pong 周期。
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(runtime.state.onlineCharacters.has("session-1")).toBe(true);
		expect(runtime.connections.has("session-1")).toBe(true);
		await runtime.close();
	});

	it("cleans up a member that never responds to heartbeat pings", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew(
			{
				cwd: join(root, "project"),
				agentDir: join(root, "agent"),
				characters: [
					{ characterId: "dev", name: "Dev", description: "", path: "/x.md", prompt: "" },
					{ characterId: "qa", name: "QA", description: "", path: "/y.md", prompt: "" },
				],
			},
			{ heartbeatIntervalMs: 30, heartbeatTimeoutMs: 120 },
		);
		const { client: healthy } = await joinCharacter(runtime, "session-healthy", "dev");
		await joinCharacter(runtime, "session-dead", "qa", { autoPong: false });

		// 失效成员经统一的断开路径被清理。
		const left = await waitForMessage(healthy, "character_left");
		expect((left.params as Record<string, unknown>).reason).toBe("disconnected");
		expect(runtime.state.onlineCharacters.has("session-dead")).toBe(false);
		expect(runtime.connections.has("session-dead")).toBe(false);
		expect(runtime.state.onlineCharacters.has("session-healthy")).toBe(true);
		await runtime.close();
	});

	it("cleans up a member whose socket send fails during broadcast (BC-6)", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew(
			{
				cwd: join(root, "project"),
				agentDir: join(root, "agent"),
				characters: [
					{ characterId: "dev", name: "Dev", description: "", path: "/x.md", prompt: "" },
					{ characterId: "qa", name: "QA", description: "", path: "/y.md", prompt: "" },
				],
			},
			{ heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 120_000 },
		);
		await joinCharacter(runtime, "session-a", "dev");
		const { client: memberB } = await joinCharacter(runtime, "session-b", "qa");

		const failingSocket = runtime.connections.get("session-a");
		expect(failingSocket).toBeDefined();
		if (!failingSocket) return;
		vi.spyOn(failingSocket, "send").mockImplementation(() => {
			throw new Error("socket failure");
		});

		const leftPromise = waitForMessage(memberB, "character_left");
		await runtime.submitUserPersonaMessage("Hello");
		// memberB 仍收到广播……
		expect(await waitForMessage(memberB, "group_chat_update")).toBeDefined();
		// ……随后收到失效成员的离开。
		const left = await leftPromise;
		expect((left.params as Record<string, unknown>).reason).toBe("disconnected");
		expect(runtime.connections.has("session-a")).toBe(false);
		expect(runtime.state.onlineCharacters.has("session-a")).toBe(false);
		expect(runtime.state.onlineCharacters.has("session-b")).toBe(true);
		await runtime.close();
	});

	it("detaches for reload, buffers window frames, and takes over cleanly (BC-8)", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{ characterId: "dev", name: "Dev", description: "", path: "/x.md", prompt: "" },
				{ characterId: "qa", name: "QA", description: "", path: "/y.md", prompt: "" },
			],
		});
		const { client: memberA } = await joinCharacter(runtime, "session-a", "dev");
		const { client: memberB } = await joinCharacter(runtime, "session-b", "qa");
		await runtime.submitUserPersonaMessage("Hello"); // starts the round

		// 一个从未完成 character_ready 的连接。
		const pendingClient = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await waitForOpen(pendingClient);
		pendingClient.send(
			JSON.stringify({ jsonrpc: "2.0", id: "1", method: "join_group_chat", params: { session_id: "session-pending" } }),
		);
		await waitForMessage(pendingClient, "response");

		const handoff = await runtime.detachForReload("pi-session-1");
		expect(handoff.connections.size).toBe(2);
		expect(handoff.bufferedFrames.size).toBe(0);

		// 待处理的（未就绪）连接被释放并关闭。
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(pendingClient.readyState).toBe(WebSocket.CLOSED);
		// 稳定成员保持连接。
		expect(memberA.readyState).toBe(WebSocket.OPEN);
		expect(memberB.readyState).toBe(WebSocket.OPEN);
		expect(runtime.state.onlineCharacters.size).toBe(2);

		// 重载窗口内的发言被缓冲，尚未处理。
		memberA.send(JSON.stringify({ jsonrpc: "2.0", id: "r1", method: "speak", params: { content: "During reload" } }));
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(handoff.bufferedFrames.get("session-a")?.length).toBe(1);

		const taken = await CreatorRuntime.takeHandoff(handoff);
		expect(taken.activeDescriptor.port).toBe(runtime.activeDescriptor.port);
		expect(taken.state.groupChat.groupChatId).toBe(runtime.state.groupChat.groupChatId);
		expect(taken.state.onlineCharacters.has("session-a")).toBe(true);
		expect(taken.state.onlineCharacters.has("session-b")).toBe(true);

		// 缓冲的发言被重放：memberB 看到通知且
		// 其预览携带该消息。
		// （用户 persona 消息不消耗轮次配额，因此发言后 usedMessages 为 1。）
		const publicMessage = await waitForMessage(memberB, "group_chat_update");
		expect(
			(
				(publicMessage.params as Record<string, unknown>).preview_messages as Array<{
					params?: { content?: unknown; sequence?: unknown; timestamp?: unknown; event_id?: unknown };
				}>
			).at(-1)?.params?.content,
		).toBe("During reload");
		expect(taken.state.round?.usedMessages).toBe(1);

		// 被接管的运行时服务新帧并拥有描述符。
		memberB.send(JSON.stringify({ jsonrpc: "2.0", id: "r2", method: "speak", params: { content: "After reload" } }));
		const afterReload = await waitForMessage(memberA, "group_chat_update");
		expect(
			(
				(afterReload.params as Record<string, unknown>).preview_messages as Array<{
					params?: { content?: unknown; sequence?: unknown; timestamp?: unknown; event_id?: unknown };
				}>
			).at(-1)?.params?.content,
		).toBe("After reload");

		await taken.close();
		expect(await readActiveDescriptor(taken.activeDescriptorPath)).toBeNull();
	});

	it("close after detach rejects: close and detach are mutually exclusive (A.2 guard)", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});
		const handoff = await runtime.detachForReload("pi-session-a2");

		// A.2（Arch）：close() 与 detachForReload() 是互斥路径——守卫读实时
		// lifecycle（readLifecycle getter），值拷贝会令守卫永不触发。
		await expect(runtime.close()).rejects.toThrow("has been detached for reload");
		// 幂等：再次 close 仍拒绝，不产生半关闭状态。
		await expect(runtime.close()).rejects.toThrow("has been detached for reload");

		// Handoff 不受影响，通过接管实例正常清理。
		const taken = await CreatorRuntime.takeHandoff(handoff);
		await taken.close();
	});
});

describe("B2: speak staleness check", () => {
	it("rejects a stale speak with missing_sequences and no quota/hand side effects", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		const { client } = await joinCharacter(runtime, "session-stale", "dev");
		// 两条用户 persona 消息：最新序号为 2。
		await runtime.submitUserPersonaMessage("one");
		await runtime.submitUserPersonaMessage("two");

		// 用过期的 based_on_sequence（0 < 最新 2）发言。
		client.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id: "s1",
				method: "speak",
				params: { content: "Stale reply", based_on_sequence: 0 },
			}),
		);
		const staleResponse = await waitForMessage(client, "response");

		expect(staleResponse.error).toBeUndefined();
		expect(staleResponse.result).toEqual({
			published: false,
			reason: "stale",
			missing_sequences: { from: 1, to: 2 },
			round: { round_max_messages: 20, used_messages: 0, remaining_messages: 20 },
		});
		// B4：过期发言不消耗配额。
		expect(runtime.state.round?.usedMessages).toBe(0);
		// stale 不触发手举（区别于 round_limit_reached）。
		expect(runtime.state.onlineCharacters.get("session-stale")?.handRaised).toBe(false);

		// 过期消息未被发布：下一个序号仍为 3。
		client.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id: "s2",
				method: "speak",
				params: { content: "Fresh reply", based_on_sequence: 2 },
			}),
		);
		const freshResponse = await waitForMessage(client, "response");
		expect(freshResponse.result).toMatchObject({
			published: true,
			sequence: 3,
			// B6：成功响应携带新的最新序号供客户端同步。
			latest_sequence: 3,
		});
		expect(runtime.state.round?.usedMessages).toBe(1);

		client.close();
		await runtime.close();
	});

	it("accepts speaks when based_on_sequence is current or omitted (legacy)", async () => {
		const root = await createTemporaryDirectory();
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [
				{
					characterId: "dev",
					name: "Developer",
					description: "Writes code",
					path: "/chars/dev.md",
					prompt: "You are a developer.",
				},
			],
		});

		const { client } = await joinCharacter(runtime, "session-legacy", "dev");
		await runtime.submitUserPersonaMessage("one"); // 最新 = 1

		// 旧客户端省略该字段：跳过过期检查，发布成功。
		client.send(JSON.stringify({ jsonrpc: "2.0", id: "l1", method: "speak", params: { content: "Legacy reply" } }));
		const legacyResponse = await waitForMessage(client, "response");
		expect(legacyResponse.result).toMatchObject({ published: true, sequence: 2 });

		// 当前客户端发送 based_on_sequence == 最新：发布成功。
		client.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id: "l2",
				method: "speak",
				params: { content: "Current reply", based_on_sequence: 2 },
			}),
		);
		const currentResponse = await waitForMessage(client, "response");
		expect(currentResponse.result).toMatchObject({ published: true, sequence: 3 });

		// 一条新的用户消息到达（序号 4）——现在落后的发言
		// 相对另一发送者即为过期（服务端排除请求者自己的
		// 消息，因此只有其他发送者计入过期判定）。新的
		// 用户消息也会开启全新轮次（used=0）；过期拒绝
		// 不消耗其配额（B4）。
		await runtime.submitUserPersonaMessage("two");

		// 边界：based_on_sequence 落后于另一发送者的最新序号即为过期。
		client.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id: "l3",
				method: "speak",
				params: { content: "Behind reply", based_on_sequence: 2 },
			}),
		);
		const behindResponse = await waitForMessage(client, "response");
		expect(behindResponse.result).toEqual({
			published: false,
			reason: "stale",
			missing_sequences: { from: 3, to: 4 },
			round: { round_max_messages: 20, used_messages: 0, remaining_messages: 20 },
		});

		client.close();
		await runtime.close();
	});
});

async function jsonlFilesUnder(root: string): Promise<string[]> {
	try {
		const entries = await readdir(root, { recursive: true });
		return entries.filter((entry) => entry.endsWith(".jsonl"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

async function expectConnectionRefused(port: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const socket = connect({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			reject(new Error(`Unexpectedly connected to closed port ${port}`));
		});
		socket.once("error", () => resolve());
	});
}

function waitForOpen(socket: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.once("open", () => resolve());
		socket.once("error", (error) => reject(error));
	});
}

function waitForMessage(socket: WebSocket, expected: string): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 5000);
		const onMessage = (data: WebSocket.RawData) => {
			const message = JSON.parse(data.toString()) as Record<string, unknown>;
			// 响应帧判别 = result/error 信封；通知按 method 判别。
			const matches = expected === "response" ? "result" in message || "error" in message : message.method === expected;
			if (matches) {
				clearTimeout(timeout);
				socket.off("message", onMessage);
				resolve(message);
			}
		};
		socket.on("message", onMessage);
	});
}

async function joinCharacter(
	runtime: CreatorRuntime,
	sessionId: string,
	characterId: string,
	options: { autoPong?: boolean } = {},
): Promise<{ client: WebSocket; welcomeMessage: Record<string, unknown> }> {
	const client = new WebSocket(
		`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		{ autoPong: options.autoPong ?? true },
	);
	await waitForOpen(client);
	client.send(
		JSON.stringify({ jsonrpc: "2.0", id: "1", method: "join_group_chat", params: { session_id: sessionId } }),
	);
	await waitForMessage(client, "response");
	client.send(
		JSON.stringify({ jsonrpc: "2.0", id: "2", method: "claim_character", params: { character_id: characterId } }),
	);
	await waitForMessage(client, "response");
	client.send(JSON.stringify({ jsonrpc: "2.0", id: "3", method: "character_ready" }));
	// ready 后不再自动推 message_history，改等 system_message 欢迎单播。
	// 响应与 system_message 相继到达，若在响应解析后才添加监听器会错过欢迎帧。
	const welcomePromise = waitForMessage(client, "system_message");
	await waitForMessage(client, "response");
	const welcomeMessage = await welcomePromise;
	return { client, welcomeMessage };
}
