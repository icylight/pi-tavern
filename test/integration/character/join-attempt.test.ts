import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { JoinAttempt } from "../../../src/character/join-attempt.js";
import { type CharacterCard, loadCharacterCard } from "../../../src/config/character-card.js";
import { getReloadHandoffRegistry } from "../../../src/controller/reload-handoff-registry.js";
import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";
import type { ActiveGroupChatDescriptor } from "../../../src/data/discovery/active-descriptor.js";
import { ERROR_CONNECTION_CLOSED_DURING_RELOAD } from "../../../src/shared/messages.js";

const temporaryDirectories: string[] = [];
const creatorRuntimes: CreatorRuntime[] = [];
const servers: WebSocketServer[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-attempt-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(creatorRuntimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					for (const socket of server.clients) {
						socket.terminate();
					}
					server.close(() => resolve());
				}),
		),
	);
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JoinAttempt and CharacterRuntime", () => {
	it("claims a Character, transfers one connection, and uses online state requests", async () => {
		const { creator, character } = await startCreator();
		const disconnected = vi.fn();
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1", { onDisconnected: disconnected });

		expect(attempt.availableCharacters).toEqual([
			{
				character_id: character.characterId,
				name: character.name,
				description: character.description,
			},
		]);

		const runtime = await attempt.claimCharacter(character.characterId);
		expect(runtime.character).toEqual(character);
		expect(creator.state.onlineCharacters.get("session-1")?.character.name).toBe("Architect");
		expect(() => attempt.takeConnection()).toThrow(/already transferred/i);

		await expect(runtime.getGroupChatState()).resolves.toMatchObject({
			online_characters: [
				{
					character_id: character.characterId,
					is_self: true,
				},
			],
		});
		runtime.updateStreaming(true);
		await vi.waitFor(() => expect(creator.state.onlineCharacters.get("session-1")?.isStreaming).toBe(true));

		await runtime.close();
		await vi.waitFor(() => expect(creator.state.onlineCharacters.has("session-1")).toBe(false));
		expect(disconnected).toHaveBeenCalledTimes(1);
	});

	it("B5 reload handoff：in-flight 请求显式取消 + 新 connection 不被旧 owner dispose（三轮阻断⑨）", async () => {
		const { creator, character } = await startCreator();
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1");
		const runtime = await attempt.claimCharacter(character.characterId);

		// ① in-flight 请求（不 await——detach 必须显式取消它）。
		const inflight = runtime.getGroupChatState();
		const handoff = await runtime.detachForReload("session-1");
		getReloadHandoffRegistry().take("session-1"); // controller clears the slot before takeHandoff

		// ② 旧请求被显式取消：及时 reject（断线原因），不悬挂到 5s 超时。
		await expect(inflight).rejects.toThrow(ERROR_CONNECTION_CLOSED_DURING_RELOAD);

		// ③ 新 runtime 接管同一 connection；旧 owner 的迟到 dispose 不得发生——
		// 等过旧 5s 超时窗口后，连接仍存活且新请求正常往返。
		const taken = await CharacterRuntime.takeHandoff(handoff);
		await new Promise((resolve) => setTimeout(resolve, 5_200));
		await expect(taken.getGroupChatState()).resolves.toMatchObject({
			online_characters: [
				{
					character_id: character.characterId,
					is_self: true,
				},
			],
		});

		await taken.close();
	}, 20_000);

	it("B4 未知 method 帧 → 协议破坏 fail-close（close 1002）；标准错误码接受由 A5 钉住（二轮评审阻断④）", async () => {
		const { creator } = await startCreator();
		const descriptor = creator.activeDescriptor;
		const ws = new WebSocket(
			`ws://${descriptor.host}:${descriptor.port}/` +
				`${encodeURIComponent(descriptor.groupChatId)}/${encodeURIComponent(descriptor.instanceId)}`,
		);
		await new Promise<void>((resolve, reject) => {
			ws.on("open", () => resolve());
			ws.on("error", reject);
		});
		try {
			// 未注册 method 在 codec 层被拒（11 类 union 外）——creator 既定策略 =
			// 协议破坏 fail-close close 1002（防御在岗）。库自产标准错误码
			// （handler 抛错 → -32603）的接受性由 unit A5 钉住（codec schema 纳入
			// 标准错误码，本端合法响应不被误判协议破坏）。
			const closed = new Promise<number | undefined>((resolve) => {
				ws.on("close", (code) => resolve(code));
			});
			ws.send(JSON.stringify({ jsonrpc: "2.0", id: "r-unknown", method: "totally_unknown_method", params: {} }));
			await expect(closed).resolves.toBe(1002);
		} finally {
			ws.close();
		}
	});

	it("closes the pending connection when the claimed file no longer matches", async () => {
		const { creator, character } = await startCreator();
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1");
		await writeFile(character.path, "---\nname: Changed\ndescription: Architecture\n---\nChanged prompt");

		await expect(attempt.claimCharacter(character.characterId)).rejects.toThrow(/no longer matches/i);
		await vi.waitFor(() => expect(creator.state.characterReservations.size).toBe(0));
		expect(creator.state.onlineCharacters.size).toBe(0);
	});

	it("times out a silent join server and closes its socket", async () => {
		const root = await createTemporaryDirectory();
		const server = new WebSocketServer({
			host: "127.0.0.1",
			port: 0,
			path: "/group-1/instance-1",
		});
		servers.push(server);
		await new Promise<void>((resolve, reject) => {
			server.once("listening", resolve);
			server.once("error", reject);
		});
		const descriptor: ActiveGroupChatDescriptor = {
			instanceId: "instance-1",
			groupChatId: "group-1",
			name: null,
			cwd: root,
			pid: process.pid,
			host: "127.0.0.1",
			port: (server.address() as AddressInfo).port,
			startedAt: "2026-07-27T00:00:00.000Z",
		};

		await expect(JoinAttempt.connect(descriptor, "session-1", { requestTimeoutMs: 30 })).rejects.toThrow(/timed out/i);
		await vi.waitFor(() => expect(server.clients.size).toBe(0));
	});

	it("observes group closure once on the transferred Character connection", async () => {
		const { creator, character } = await startCreator();
		const disconnected = vi.fn();
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1", { onDisconnected: disconnected });
		const runtime = await attempt.claimCharacter(character.characterId);

		await creator.close();

		await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1));
		expect(runtime.receivedMessages).toContainEqual({
			jsonrpc: "2.0",
			method: "group_chat_closed",
			params: { group_chat_id: creator.state.groupChat.groupChatId },
		});
	});

	it("does not treat heartbeat frames as environment messages", async () => {
		const { creator, character } = await startCreator({ heartbeatIntervalMs: 30, heartbeatTimeoutMs: 120 });
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1");
		const runtime = await attempt.claimCharacter(character.characterId);
		// 基线取点前先等 claim 链路的 system_message 欢迎单播到达（#123 替代 message_history）：
		// connection 重构后 reply 异步化（ready result → welcome → cj 宏任务投递），
		// 取点早于通知会误判。
		await vi.waitFor(() => {
			expect(runtime.receivedMessages.some((m) => "method" in m && m.method === "system_message")).toBe(true);
		});
		const messageCountAfterJoin = runtime.receivedMessages.length;

		// 若干次 ping/pong 周期内无任何新的环境消息。
		await new Promise((resolve) => setTimeout(resolve, 250));

		expect(runtime.receivedMessages.length).toBe(messageCountAfterJoin);
	});

	it("terminates the connection when the creator stops sending heartbeats", async () => {
		const { creator, character } = await startCreator({
			// creator 在测试窗口内从不 ping。
			heartbeatIntervalMs: 60_000,
			heartbeatTimeoutMs: 60_000,
		});
		const disconnected = vi.fn();
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1", {
			onDisconnected: disconnected,
			heartbeatIntervalMs: 30,
			heartbeatTimeoutMs: 120,
		});
		await attempt.claimCharacter(character.characterId);

		// 角色主动终止半开连接。
		await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1), { timeout: 2000 });
		expect(creator.state.onlineCharacters.has("session-1")).toBe(false);
	});

	it("detaches for reload and takes over with the same live connection (BC-8)", async () => {
		const { creator, character } = await startCreator({ heartbeatIntervalMs: 30, heartbeatTimeoutMs: 120 });
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1");
		const runtime = await attempt.claimCharacter(character.characterId);

		const handoff = await runtime.detachForReload("session-1");
		expect(handoff.kind).toBe("character");
		expect(handoff.groupChatId).toBe(creator.state.groupChat.groupChatId);

		// 同一连接在 reload 窗口内保持存活。
		expect(handoff.socket.readyState).toBe(WebSocket.OPEN);

		// creator 仍认为该成员在线。
		expect(creator.state.onlineCharacters.has("session-1")).toBe(true);

		// reload 窗口内的帧（creator 广播）被缓冲。
		await creator.submitUserPersonaMessage("Hello during reload");
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(handoff.bufferedFrames.length).toBeGreaterThan(0);

		const taken = await CharacterRuntime.takeHandoff(handoff);
		expect(taken.groupChatId).toBe(runtime.groupChatId);
		expect(taken.character.characterId).toBe(character.characterId);

		// 缓冲的广播被重放到新运行时。
		expect(
			taken.receivedMessages.some(
				(m) =>
					"method" in m &&
					m.method === "group_chat_update" &&
					((m.params as Record<string, unknown>).preview_messages as Record<string, unknown>[]).some(
						(p) => (p.params as Record<string, unknown>).content === "Hello during reload",
					),
			),
		).toBe(true);

		// 新运行时服务同一活动连接：后续广播继续到达。
		await creator.submitUserPersonaMessage("Hello after reload");
		await vi.waitFor(() =>
			expect(
				taken.receivedMessages.some(
					(m) =>
						"method" in m &&
						m.method === "group_chat_update" &&
						((m.params as Record<string, unknown>).preview_messages as Record<string, unknown>[]).some(
							(p) => (p.params as Record<string, unknown>).content === "Hello after reload",
						),
				),
			).toBe(true),
		);

		await taken.close();
	});

	it("reload reloads the character card from disk and falls back on failure (ISSUE-005)", async () => {
		const { creator, character } = await startCreator({});
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1");
		const runtime = await attempt.claimCharacter(character.characterId);

		// 已加入时编辑角色卡文件：persona 必须在 reload 时刷新。
		await writeFile(character.path, "---\nname: Architect\ndescription: Architecture v2\n---\nArchitect prompt v2");

		const handoff = await runtime.detachForReload("session-1");
		getReloadHandoffRegistry().take("session-1"); // controller clears the slot before takeHandoff
		const taken = await CharacterRuntime.takeHandoff(handoff);
		expect(taken.character.description).toBe("Architecture v2");
		expect(taken.character.prompt).toBe("Architect prompt v2");

		// 回退：损坏角色卡使 reload 失败——旧卡必须保留
		// 并报告警告，且不崩溃。
		await writeFile(character.path, "not: valid frontmatter?");
		const notify = vi.fn();
		const handoff2 = await taken.detachForReload("session-1");
		getReloadHandoffRegistry().take("session-1");
		const taken2 = await CharacterRuntime.takeHandoff(handoff2, undefined, notify);
		expect(taken2.character.prompt).toBe("Architect prompt v2");
		expect(taken2.character.description).toBe("Architecture v2");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("reload"));

		await taken2.close();
	});
});

async function startCreator(
	creatorOverrides: Partial<import("../../../src/creator/creator-runtime.js").CreatorRuntimeDependencies> = {},
): Promise<{
	creator: CreatorRuntime;
	character: CharacterCard;
}> {
	const root = await createTemporaryDirectory();
	const characterPath = join(root, "characters", "architect.md");
	const configPath = join(root, "tavern.json");
	await mkdir(join(root, "characters"), { recursive: true });
	await writeFile(characterPath, "---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt");
	const character = await loadCharacterCard(characterPath, configPath);
	const creator = await CreatorRuntime.startNew(
		{
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [character],
		},
		creatorOverrides,
	);
	creatorRuntimes.push(creator);
	return { creator, character };
}
