import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { loadTavernConfig } from "../../../src/config/load-config.js";
import type { MessageTemplateKey } from "../../../src/config/message-templates.js";
import { ERROR_UNEXPECTED_SPEAK_RESPONSE } from "../../../src/shared/messages.js";

/**
 *  方案 B 回归钉（Arch 属主，对抗模式⑪实证）：response-gate feed 前拦截
 * 移位到 request() 解析时校验后，**reload 延续连接上 fail-close 仍须生效**——
 * adoptJsonRpc 路径不得绕过形状校验（reload 重放帧 id 已随 detach 显式取消，
 * 重放不命中 pending；本钉锚 = 新 runtime 接管后发出的请求收到错形状响应 →
 * 仍 reject ERROR_UNEXPECTED_* + 断链，与 join 路径同机制）。
 */

interface MockSocket extends EventEmitter {
	readyState: number;
	sent: Array<Record<string, unknown>>;
	send: (data: string) => void;
	terminate: () => void;
	close: () => void;
}

function createMockSocket(): MockSocket {
	const socket = new EventEmitter() as MockSocket;
	socket.readyState = WebSocket.OPEN;
	socket.sent = [];
	socket.send = ((data: string) => {
		socket.sent.push(JSON.parse(data) as Record<string, unknown>);
	}) as unknown as MockSocket["send"];
	socket.terminate = (() => {
		socket.readyState = WebSocket.CLOSED;
	}) as unknown as MockSocket["terminate"];
	socket.close = (() => {
		socket.readyState = WebSocket.CLOSED;
	}) as unknown as MockSocket["close"];
	return socket;
}

function lastRequestId(socket: MockSocket): string | number {
	const sent = socket.sent.at(-1) as Record<string, unknown>;
	if (typeof sent.id !== "string" && typeof sent.id !== "number") {
		throw new Error(`expected a request with string|number id, got ${JSON.stringify(sent)}`);
	}
	return sent.id;
}

function injectResponse(socket: MockSocket, id: string | number, payload: Record<string, unknown>): void {
	socket.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, ...payload })), false);
}

const CHARACTER = {
	characterId: "tester",
	name: "Tester",
	description: "Tests",
	path: "characters/tester.md",
	prompt: "Test prompt",
};

/** speak 请求的合法 result 形状（published/event_id/sequence/latest_sequence/round）。 */
function speakResult(sequence: number): Record<string, unknown> {
	return {
		published: true,
		event_id: `e${sequence}`,
		sequence,
		latest_sequence: sequence,
		round: { round_max_messages: 10, used_messages: sequence, remaining_messages: 10 - sequence },
	};
}

describe("CharacterRuntime reload 延续后 fail-close（方案 B 回归）", () => {
	const sockets: MockSocket[] = [];
	const runtimes: CharacterRuntime[] = [];

	afterEach(() => {
		for (const runtime of runtimes) {
			(runtime as unknown as { stopHeartbeat(): void }).stopHeartbeat();
		}
		runtimes.length = 0;
		sockets.length = 0;
	});

	function createRuntime(messageTemplates?: Record<MessageTemplateKey, string>): {
		runtime: CharacterRuntime;
		socket: MockSocket;
	} {
		const socket = createMockSocket();
		sockets.push(socket);
		const runtime = CharacterRuntime.prepare({
			groupChatId: "group-1",
			sessionId: "session-1",
			character: CHARACTER,
			heartbeatIntervalMs: 60_000,
			heartbeatTimeoutMs: 60_000,
			requestTimeoutMs: 5_000,
			...(messageTemplates !== undefined ? { messageTemplates } : {}),
		});
		runtime.activate({ socket: socket as unknown as WebSocket, bufferedMessages: [] });
		runtimes.push(runtime);
		return { runtime, socket };
	}

	/** 跨 reload 构造新 runtime（detach → takeHandoff，连接延续）。 */
	async function reloadRuntime(runtime: CharacterRuntime, _socket: MockSocket): Promise<CharacterRuntime> {
		const handoff = await runtime.detachForReload("session-2");
		const taken = await CharacterRuntime.takeHandoff(handoff);
		runtimes.push(taken);
		return taken;
	}

	it("R1 reload 延续连接上错形状响应 → 仍 fail-close（reject ERROR_UNEXPECTED_SPEAK_RESPONSE + 断链）", async () => {
		const { runtime, socket } = createRuntime();
		const taken = await reloadRuntime(runtime, socket);

		const request = (taken as unknown as { request(m: { method: string; params: unknown }): Promise<unknown> }).request;
		const promise = request.call(taken, { method: "speak", params: { content: "hello" } });
		const id = lastRequestId(socket);

		// 同 id 错 result 形状（speak 请求注入 board_query 合法形状冒充——过 codec
		// schema，在 request() 解析时校验层 fail-close，B1 同款注入）。
		injectResponse(socket, id, {
			result: { boards: {} },
		});

		await expect(promise).rejects.toThrow(ERROR_UNEXPECTED_SPEAK_RESPONSE);
	});

	it("R3 ( 阻断 2): reload 后 messageTemplates 快照保持（不回落默认）", async () => {
		const customTemplates = {
			public_message: "[{sender}]→{content}",
			whisper_full: "{sender}→{receiver}: {content}",
			whisper_placeholder: "{sender}→{receiver}: [whisper]",
			seconds_ago: "{count} sec ago",
			minutes_ago: "{count} min ago",
		};
		const { runtime } = createRuntime(customTemplates);
		expect(runtime.messageTemplates).toEqual(customTemplates);

		const taken = await reloadRuntime(runtime, undefined as never);
		expect(taken.messageTemplates).toEqual(customTemplates);

		// 未配置路径：undefined 保持（消费面回落 DEFAULT_TEMPLATES）。
		const { runtime: plain } = createRuntime();
		const plainTaken = await reloadRuntime(plain, undefined as never);
		expect(plainTaken.messageTemplates).toBeUndefined();
	});

	it("R4 ( 复评): reload 重新加载磁盘配置——A→磁盘 B→reload 后 B 生效", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tavern-reload-"));
		const agentDir = join(dir, "agent");
		const cwd = join(dir, "project");
		mkdirSync(join(agentDir), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });

		// 磁盘 = A（全局 tavern.json 以相对路径声明模板 A）。
		writeFileSync(join(agentDir, "tavern.json"), JSON.stringify({ message_templates: "./templates.json" }));
		writeFileSync(
			join(agentDir, "templates.json"),
			JSON.stringify({
				public_message: "A: {sender}: {content}",
				seconds_ago: "{count} sec ago",
				minutes_ago: "{count} min ago",
			}),
		);
		// 项目层未声明 → 合并仍为 A。
		writeFileSync(join(cwd, ".pi", "tavern.json"), JSON.stringify({}));

		const socket = createMockSocket();
		sockets.push(socket);
		const runtime = CharacterRuntime.prepare({
			groupChatId: "group-1",
			sessionId: "session-1",
			character: CHARACTER,
			heartbeatIntervalMs: 60_000,
			heartbeatTimeoutMs: 60_000,
			requestTimeoutMs: 5_000,
			agentDir,
			cwd,
		});
		runtime.activate({ socket: socket as unknown as WebSocket, bufferedMessages: [] });
		runtimes.push(runtime);
		// join 时本地加载 = A。
		const joinedA = await loadTavernConfig({ agentDir, cwd });
		expect(joinedA.messageTemplates?.public_message).toBe("A: {sender}: {content}");

		// 磁盘改为 B（/tavern-template-edit 落盘后）。
		writeFileSync(
			join(agentDir, "templates.json"),
			JSON.stringify({
				public_message: "B: {sender}: {content}",
				seconds_ago: "{count} sec ago",
				minutes_ago: "{count} min ago",
			}),
		);

		// reload：detach → takeHandoff，重载磁盘配置 → B 生效。
		const handoff = await runtime.detachForReload("session-2");
		expect(handoff.agentDir).toBe(agentDir);
		expect(handoff.cwd).toBe(cwd);
		const taken = await CharacterRuntime.takeHandoff(handoff);
		runtimes.push(taken);
		expect(taken.messageTemplates?.public_message).toBe("B: {sender}: {content}");

		rmSync(dir, { recursive: true, force: true });
	});

	it("R5 ( 复评): 磁盘重载失败 → warning + 保留旧快照，reload 继续", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tavern-reload-fail-"));
		const agentDir = join(dir, "agent");
		const cwd = join(dir, "project");
		mkdirSync(join(agentDir), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "tavern.json"), JSON.stringify({ message_templates: "./templates.json" }));
		writeFileSync(
			join(agentDir, "templates.json"),
			JSON.stringify({
				public_message: "A: {sender}: {content}",
				seconds_ago: "{count} sec ago",
				minutes_ago: "{count} min ago",
			}),
		);
		writeFileSync(join(cwd, ".pi", "tavern.json"), JSON.stringify({}));

		const socket = createMockSocket();
		sockets.push(socket);
		const runtime = CharacterRuntime.prepare({
			groupChatId: "group-1",
			sessionId: "session-1",
			character: CHARACTER,
			heartbeatIntervalMs: 60_000,
			heartbeatTimeoutMs: 60_000,
			requestTimeoutMs: 5_000,
			agentDir,
			cwd,
			messageTemplates: {
				public_message: "A: {sender}: {content}",
				whisper_full: "{sender}→{receiver}: {content}",
				whisper_placeholder: "{sender}→{receiver}: [whisper]",
				seconds_ago: "{count} sec ago",
				minutes_ago: "{count} min ago",
			},
		});
		runtime.activate({ socket: socket as unknown as WebSocket, bufferedMessages: [] });
		runtimes.push(runtime);

		// ② tavern.json 本身坏 JSON → loadTavernConfig 抛错 → notify warning +
		// 保留旧快照 A，reload 继续（R5b：仅加载失败保留）。
		writeFileSync(join(agentDir, "tavern.json"), "{broken tavern json");
		const warnings: string[] = [];
		const handoff2 = await runtime.detachForReload("session-2");
		const taken2 = await CharacterRuntime.takeHandoff(handoff2, undefined, (message) => {
			warnings.push(message);
		});
		runtimes.push(taken2);
		expect(warnings.some((w) => w.includes("failed to reload tavern.json"))).toBe(true);
		expect(taken2.messageTemplates?.public_message).toBe("A: {sender}: {content}");

		// ① 模板文件坏 JSON → 后端 warning 回退（loadTavernConfig 不抛）→
		// 重载成功但缺省 → 清除旧快照（消费面回落内置默认；R5a 第三轮复评）。
		// 先恢复 tavern.json 合法（② 已写坏），只保留 templates.json 坏。
		writeFileSync(join(agentDir, "tavern.json"), JSON.stringify({ message_templates: "./templates.json" }));
		writeFileSync(join(agentDir, "templates.json"), "{broken json");
		const handoff1 = await taken2.detachForReload("session-2");
		const taken1 = await CharacterRuntime.takeHandoff(handoff1);
		runtimes.push(taken1);
		expect(taken1.messageTemplates).toBeUndefined();

		rmSync(dir, { recursive: true, force: true });
	});

	it("R2 reload 延续连接上正确响应 → 正常 resolve（正向对照，校验不移位不误伤）", async () => {
		const { runtime, socket } = createRuntime();
		const taken = await reloadRuntime(runtime, socket);

		const request = (taken as unknown as { request(m: { method: string; params: unknown }): Promise<unknown> }).request;
		const promise = request.call(taken, { method: "speak", params: { content: "hello" } });
		const id = lastRequestId(socket);

		injectResponse(socket, id, { result: speakResult(1) });

		await expect(promise).resolves.toMatchObject({
			result: { published: true, event_id: "e1" },
		});
	});
});
