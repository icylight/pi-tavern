import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { PiProcess } from "./pi-process.js";
import { BufferedWsClient } from "./ws-helper.js";

/**
 * A1/A2/A4（验收清单 #14-A1/#14-A2/#14-A4）：is_streaming 点亮语义收敛与
 * 多连接一致性——进程级。
 *
 * A1：群聊触发的 turn 点亮 is_streaming（creator widget「正在发言」出现），
 *     agent_settled 后熄灭。
 * A2：用户直聊（非群聊输入）触发的 turn 不点亮——语义收敛核心用例，
 *     旧行为误报（agent_start 全量点亮）在此被钉死。
 * A4：多连接一致性——ws 观察者与 creator widget 在同一轮 turn 中收敛到
 *     同一真值（翻转广播到达 + 终态快照一致）。
 *
 * 观察通道：creator 侧 widget（extension_ui_request setWidget：成员数 +
 * 「正在发言」行），方案 A 保证 streaming 翻转即时广播。
 */

describe("acceptance: A1/A2/A4 is_streaming semantic convergence (#14)", () => {
	let pairIndex = 0;
	const roots: string[] = [];
	const processes: PiProcess[] = [];

	afterAll(async () => {
		for (const process_ of processes) {
			await process_.kill("SIGTERM");
		}
		await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
	});

	async function startPair(): Promise<{
		creator: PiProcess;
		headless: PiProcess;
		port: number;
		groupChatId: string;
		instanceId: string;
	}> {
		// Per-test isolation: each pair gets its own agent dir so descriptor
		// files / group chat state never collide across tests.
		const root = await mkdtemp(join(tmpdir(), `pi-tavern-acc-streaming-${pairIndex}-`));
		pairIndex += 1;
		roots.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await mkdir(projectDir, { recursive: true });
		await writeFile(
			join(agentDir, "characters", "architect.md"),
			"---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt",
		);
		await writeFile(
			join(agentDir, "characters", "developer.md"),
			"---\nname: Developer\ndescription: Writes code\n---\nDeveloper prompt",
		);
		await writeFile(
			join(agentDir, "tavern.json"),
			JSON.stringify({ characters: ["characters/architect.md", "characters/developer.md"] }),
		);

		const creator = PiProcess.spawn({
			label: "creator",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator"),
			cwd: projectDir,
		});
		processes.push(creator);
		const descriptor = await creator.startGroupChat(projectDir, agentDir);

		const headless = PiProcess.spawn({
			label: "hl",
			agentDir,
			sessionDir: join(agentDir, "sessions", "h"),
			cwd: projectDir,
			env: {
				PITAVERN_AUTO_JOIN: "1",
				PITAVERN_CHARACTER: "architect",
				PITAVERN_GROUP_CHAT: descriptor.groupChatId,
			},
		});
		processes.push(headless);
		await headless.waitForStderr("Auto-joined", 60_000);
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[])?.[0]?.startsWith("2 人在线") === true,
		);
		return {
			creator,
			headless,
			port: descriptor.port,
			groupChatId: descriptor.groupChatId,
			instanceId: descriptor.instanceId,
		};
	}

	function widgetHasStreaming(event: Record<string, unknown>): boolean {
		return (
			event.type === "extension_ui_request" &&
			event.method === "setWidget" &&
			((event.widgetLines as string[] | undefined) ?? []).some((line) => line.startsWith("正在发言："))
		);
	}

	it("A1: group-chat-triggered turn lights is_streaming, settled extinguishes it", async () => {
		const { creator } = await startPair();

		// Group-chat input (User Persona message) triggers the character turn.
		await creator.runCommand("/tavern-test-message A1 hello");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);

		// The turn lights up: creator widget shows "正在发言：Architect".
		await creator.waitFor(
			(e) => widgetHasStreaming(e) && (e.widgetLines as string[]).some((line) => line.includes("Architect")),
			60_000,
		);

		// Settled extinguishes: widget back to members-only.
		await creator.waitFor(
			(e) => e.type === "extension_ui_request" && e.method === "setWidget" && !widgetHasStreaming(e),
			60_000,
		);
	});

	it("A2: user-direct turn does NOT light is_streaming (semantic convergence)", async () => {
		const { creator, headless } = await startPair();

		// #52（白名单毫秒级 run 暴露的时序缺陷修复）：先确认 join 完成
		// （2 人在线广播）再取 baseline——原实现依赖窗口内出现 2 人在线事件，
		// 而 join 广播时刻与 baseline 的相对顺序不确定（旧模式被慢 run 掩盖）。
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				(e.widgetLines as string[])?.[0]?.startsWith("2 人在线") === true,
			60_000,
		);
		const baseline = creator.countEvents();

		// Direct RPC prompt = a user-direct turn, NOT group-chat input.
		await headless.runCommand("A2 direct question, not a group chat message");
		await headless.waitFor((e) => e.type === "response" && e.command === "prompt", 60_000);

		// Let the agent run settle; then scan the window: no widget event
		// may ever show "正在发言" (the old behaviour would light it).
		await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
		const windowEvents = creator.dumpEvents().slice(baseline);
		const streamingWidgets = windowEvents.filter(widgetHasStreaming);
		expect(streamingWidgets).toEqual([]);

		// The character stays online with 2 members throughout: no
		// member-count drop (1/0 人在线) event may appear in the window.
		const memberDrop = windowEvents.filter(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "setWidget" &&
				((e.widgetLines as string[])?.[0]?.startsWith("1 人在线") === true ||
					(e.widgetLines as string[])?.[0]?.startsWith("0 人在线") === true),
		);
		expect(memberDrop).toEqual([]);
	});

	it("A4: all observers converge on the same streaming truth (multi-connection consistency)", async () => {
		const { creator, headless, port, groupChatId, instanceId } = await startPair();

		// Second observer: a raw WS client that completes the join flow as
		// the developer Character (only online members may read state).
		const ws = new WebSocket(
			`ws://127.0.0.1:${port}/${encodeURIComponent(groupChatId)}/${encodeURIComponent(instanceId)}`,
		);
		const observer = new BufferedWsClient(ws);
		await new Promise<void>((resolveWait, reject) => {
			ws.once("open", () => resolveWait());
			ws.once("error", reject);
		});
		ws.send(JSON.stringify({ id: "obs0", type: "join_group_chat", session_id: "observer-1" }));
		await observer.waitFor((m) => m.type === "response" && m.id === "obs0", 30_000);
		ws.send(JSON.stringify({ id: "obs1", type: "claim_character", character_id: "characters/developer.md" }));
		await observer.waitFor((m) => m.type === "response" && m.id === "obs1", 30_000);
		ws.send(JSON.stringify({ id: "obs2", type: "character_ready" }));
		await observer.waitFor((m) => m.type === "response" && m.id === "obs2", 30_000);

		ws.send(JSON.stringify({ id: "obs3", type: "get_group_chat_state" }));
		const before = await observer.waitFor(
			(m) => m.type === "response" && m.command === "get_group_chat_state" && m.id === "obs3",
			30_000,
		);
		expect((before.data as { online_characters: unknown[] }).online_characters).toHaveLength(2); // Architect (headless) + Developer (observer)

		// Group-chat turn: streaming flips true (widget).
		await creator.runCommand("/tavern-test-message A4 hello");
		await creator.waitFor(
			(e) => widgetHasStreaming(e) && (e.widgetLines as string[]).some((line) => line.includes("Architect")),
			60_000,
		);

		// The plan-A broadcast reached the observer during the window.
		const updateFrames = observer.allFrames().filter((m) => m.type === "group_chat_update");
		expect(updateFrames.length).toBeGreaterThan(0);

		// Deterministic settle signal: the headless agent run finished.
		await headless.waitFor((e) => e.type === "agent_settled", 90_000);

		// Converge: after settled (+ watchdog margin), the observer snapshot
		// must agree with the creator widget (streaming off).
		await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
		ws.send(JSON.stringify({ id: "final", type: "get_group_chat_state" }));
		const finalSnapshot = await observer.waitFor(
			(m) => m.type === "response" && m.command === "get_group_chat_state" && m.id === "final",
			30_000,
		);
		const streamingMembers = (
			finalSnapshot.data as { online_characters: Array<{ is_streaming: boolean }> }
		).online_characters.filter((c) => c.is_streaming);
		expect(streamingMembers).toEqual([]);
		ws.close();
	});
});
