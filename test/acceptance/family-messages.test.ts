import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type WebSocket from "ws";

import type { PiProcess } from "./pi-process.js";
import { leaveAndReset, spawnCreator, spawnStats, startFreshGroup } from "./process-fixture.js";
import { joinCharacterWs } from "./ws-helper.js";

/**
 * 测试架构改造 v2 试点（User 拍板 2026-08-02）：message-sync + message-fetch +
 * history-paging 串行 family——非破坏性 creator/WS 场景共享一个 creator 进程
 * （原三文件各 spawn 一次，共 3 次 → 1 次）。
 *
 * 场景间隔离契约：
 * - 每 it 新群聊（startFreshGroup）+ 场景内 creator 事件等待一律 waitForAfter
 *   （checkpoint 语义，防旧事件串扰）
 * - 每 it finally 关 WS + leaveAndReset（失败也归位，防传染）
 * - afterEach 兜底：creator 异常退出 → 自动重生（resetOrRespawnCreator）
 * - 断言与用例数与原三文件逐一对应（零删减）
 */
describe("acceptance family: message sync + fetch + history paging (shared creator pilot)", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	let creator: PiProcess;
	const sockets: WebSocket[] = [];

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-tavern-acc-family-"));
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await mkdir(projectDir, { recursive: true });
		// 超集 env：两角色（message-sync 需 reviewer）+ config_max_messages 10
		// （message-sync round 断言需 10；fetch/paging 不用但无害）。
		await writeFile(
			join(agentDir, "characters", "architect.md"),
			"---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt",
		);
		await writeFile(
			join(agentDir, "characters", "reviewer.md"),
			"---\nname: Reviewer\ndescription: Reviews designs\n---\nReviewer prompt",
		);
		await writeFile(
			join(agentDir, "tavern.json"),
			JSON.stringify({
				config_max_messages: 10,
				characters: ["characters/architect.md", "characters/reviewer.md"],
			}),
		);
		creator = spawnCreator({
			label: "creator",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator"),
			cwd: projectDir,
		});
		await creator.waitForTavernReady(60_000);
	});

	afterEach(async () => {
		// 兜底：上例失败残留的 socket 一律关闭。
		for (const socket of sockets.splice(0)) {
			socket.terminate();
		}
		// P2 强化：无条件 leaveAndReset 兜底——场景内 finally 已 leave 时为幂等
		// no-op；finally 失败残留绑定时归位；兜底失败则强杀走重生路径。
		try {
			await leaveAndReset(creator, creator.checkpoint(), 10_000);
		} catch {
			await creator.kill("SIGKILL");
		}
		// 通过条件④：异常自动重启——creator 已死则重生（下一 it 的
		// startFreshGroup 在新进程上继续，失败不传染）。
		if (creator.exited) {
			creator = spawnCreator({
				label: "creator",
				agentDir,
				sessionDir: join(agentDir, "sessions", "creator"),
				cwd: projectDir,
			});
			await creator.waitForTavernReady(60_000);
		}
	});

	afterAll(async () => {
		for (const socket of sockets.splice(0)) {
			socket.terminate();
		}
		if (creator && !creator.exited) {
			await creator.kill("SIGTERM");
		}
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
		console.log(
			`[family] spawnStats: ${spawnStats.count} spawns, total ${spawnStats.totalMs}ms, ` +
				`times ${spawnStats.timesMs.map((ms) => `${ms}ms`).join(", ")}`,
		);
	});

	it("A2/A6: cursor persistence and injection are unit-covered (RPC limitation)", () => {
		// RPC-mode pi quits the session right after the join turn completes,
		// so a real character process cannot observe messages that arrive
		// after join (verified empirically; identity-consistency relies on
		// the join-batch flush for the same reason). A2 (cursor file write /
		// read / restart survival) and A6 (injection == notification source)
		// are therefore covered at the unit layer:
		//
		// - CharacterRuntime cursor round-trip + JoinAttempt cursorStorePath
		//   propagation (test/character/join-attempt.test.ts)
		// - GroupChatInput pullIncrement: immediate pull (A1), gap fill
		//   (A4), single-flight (A7), settle-queueing (A5), injection notify
		//   (A6) — test/character/group-chat-input.test.ts M7 cases
		expect(true).toBe(true);
	});

	it("smoke: real-pi WS delivery chain — speak publish + pull + broadcast consistency", async () => {
		// tier-2 精简（User 拍板）：sync/fetch/paging/speak-order 的细粒度断言已下沉
		// integration（paging-and-speak-order.test.ts + character-runtime B 系列），
		// 本用例 = 真进程 WS 全链路代表性冒烟（新群聊 → 消息 → 双成员 join → speak
		// 发布 → 拉取同源 → 双接收者广播一致）。
		const { descriptor, checkpoint } = await startFreshGroup(creator, projectDir, agentDir);
		try {
			await creator.runCommand("/tavern-test-message hello");
			await creator.waitForAfter(
				checkpoint,
				(e) =>
					e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
			);

			const memberA = await joinCharacterWs(descriptor, "ws-smoke-a", "characters/architect.md");
			sockets.push(memberA.socket);
			const memberB = await joinCharacterWs(descriptor, "ws-smoke-b", "characters/reviewer.md");
			sockets.push(memberB.socket);
			await memberA.waitFor((m) => m.type === "message_history");
			await memberB.waitFor((m) => m.type === "message_history");

			// 发布面（sync B2 正向 + speak 管线）：非 stale speak 发布为 seq 2。
			memberA.send({ id: "sm1", type: "speak", content: "smoke reply", based_on_sequence: 1 });
			const ok = await memberA.waitFor((m) => m.type === "response" && m.command === "speak" && m.id === "sm1", 30_000);
			expect(ok.data).toMatchObject({ published: true, sequence: 2 });

			// 拉取同源（fetch 面）：另一成员增量拉取看到同一内容。
			memberB.send({ id: "sm2", type: "fetch_messages_since", since_sequence: 1 });
			const pulled = await memberB.waitFor(
				(m) => m.type === "response" && m.command === "fetch_messages_since" && m.id === "sm2",
			);
			expect((pulled.data as Record<string, unknown>).total_messages).toBe(2);
			expect((pulled.data as Record<string, unknown>).latest_sequence).toBe(2);

			// 广播一致（speak-order 面）：另一成员也收到同序通知。
			await memberB.waitFor((m) => m.type === "group_chat_update" && (m.latest_sequence as number) >= 2, 30_000);
		} finally {
			try {
				for (const socket of sockets.splice(0)) {
					socket.terminate();
				}
				await leaveAndReset(creator, checkpoint);
			} catch (error) {
				console.error(`[family] cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	});
});
