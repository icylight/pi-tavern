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
 * #77：任何 run（群聊触发/私有直聊）点亮 is_streaming（creator widget「正在工作」出现），
 *     agent_settled 后熄灭。
 * A2：用户直聊（非群聊输入）触发的 turn 不点亮——语义收敛核心用例，
 *     旧行为误报（agent_start 全量点亮）在此被钉死。
 * A4：多连接一致性——ws 观察者与 creator widget 在同一轮 turn 中收敛到
 *     同一真值（翻转广播到达 + 终态快照一致）。
 *
 * 观察通道：creator 侧 widget（extension_ui_request setWidget：成员数 +
 * 「正在工作」行），#77 保证 streaming 翻转即时广播。
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
		// 逐测试隔离：每组使用独立 agent 目录，使描述符
		// 文件与群聊状态在测试间互不冲突。
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
			((event.widgetLines as string[] | undefined) ?? []).some((line) => line.startsWith("正在工作："))
		);
	}

	it.concurrent("A1: group-chat-triggered turn lights is_streaming, settled extinguishes it", async () => {
		const { creator } = await startPair();

		// 群聊输入（用户 Persona 消息）触发角色回合。
		await creator.runCommand("/tavern-test-message A1 hello");
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
		);

		// 回合点亮：creator widget 显示「正在工作：Architect」。
		await creator.waitFor(
			(e) => widgetHasStreaming(e) && (e.widgetLines as string[]).some((line) => line.includes("Architect")),
			60_000,
		);

		// 收敛后熄灭：widget 回到仅成员状态。
		await creator.waitFor(
			(e) => e.type === "extension_ui_request" && e.method === "setWidget" && !widgetHasStreaming(e),
			60_000,
		);
	});

	it.concurrent(
		"A2 (#77): user-direct RPC turn has no agent_start — no lighting trigger (mechanism, not semantic)",
		async () => {
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

			// 直接 RPC 提示 = 用户直聊回合，而非群聊输入。
			// #77：点亮由 agent_start 驱动（run 活跃即亮）——但 headless RPC 模式
			// 不触发 agent_start 生命周期事件（index.ts：RPC 不触发
			// session_start/resources_discover；agent_start 同理），扩展无点亮时机，
			// 故窗口内不应出现「正在工作」widget——这是机制结果，非语义拒绝。
			await headless.runCommand("A2 direct question, not a group chat message");
			await headless.waitFor((e) => e.type === "response" && e.command === "prompt", 60_000);

			// 让 agent 运行至收敛；然后扫描窗口：无 widget 事件
			// may ever show "正在工作" (RPC turn has no agent_start).
			await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
			const windowEvents = creator.dumpEvents().slice(baseline);
			const streamingWidgets = windowEvents.filter(widgetHasStreaming);
			expect(streamingWidgets).toEqual([]);

			// 角色全程保持 2 名成员在线：无
			// member-count drop (1/0 人在线) event may appear in the window.
			const memberDrop = windowEvents.filter(
				(e) =>
					e.type === "extension_ui_request" &&
					e.method === "setWidget" &&
					((e.widgetLines as string[])?.[0]?.startsWith("1 人在线") === true ||
						(e.widgetLines as string[])?.[0]?.startsWith("0 人在线") === true),
			);
			expect(memberDrop).toEqual([]);
		},
	);

	it.concurrent("A4: all observers converge on the same streaming truth (multi-connection consistency)", async () => {
		const { creator, headless, port, groupChatId, instanceId } = await startPair();

		// 第二观察者：以 Developer 角色完成加入流程的裸 WS 客户端
		//（仅在线成员可读取状态）。
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

		// 群聊回合：streaming 翻转为 true（widget）。
		await creator.runCommand("/tavern-test-message A4 hello");
		await creator.waitFor(
			(e) => widgetHasStreaming(e) && (e.widgetLines as string[]).some((line) => line.includes("Architect")),
			60_000,
		);

		// 方案 A 广播在窗口期内到达观察者。
		const updateFrames = observer.allFrames().filter((m) => m.type === "group_chat_update");
		expect(updateFrames.length).toBeGreaterThan(0);

		// 确定性收敛信号：无头 agent 运行完成。
		await headless.waitFor((e) => e.type === "agent_settled", 90_000);

		// 收敛：收敛后（+ 看门狗余量），观察者快照
		// 必须与 creator widget 一致（streaming 关闭）。
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
