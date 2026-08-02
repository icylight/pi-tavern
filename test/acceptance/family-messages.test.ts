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

	it("B2/B4/B6: stale speaks are refused (no quota, no hand); consecutive speaks pass", async () => {
		const { descriptor, checkpoint } = await startFreshGroup(creator, projectDir, agentDir);
		try {
			// One User Persona message creates the round (seq 1).
			await creator.runCommand("/tavern-test-message one");
			await creator.waitForAfter(
				checkpoint,
				(e) =>
					e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
			);

			const memberA = await joinCharacterWs(descriptor, "ws-sync-a", "characters/architect.md");
			sockets.push(memberA.socket);
			const memberB = await joinCharacterWs(descriptor, "ws-sync-b", "characters/reviewer.md");
			sockets.push(memberB.socket);
			// Both saw their join-time history (seq 1).
			await memberA.waitFor((m) => m.type === "message_history");
			await memberB.waitFor((m) => m.type === "message_history");

			// ── B2: a speak based on an older sequence is refused ──────────────
			const baselineA = memberA.allFrames().length;
			memberA.send({ id: "stale1", type: "speak", content: "stale reply", based_on_sequence: 0 });
			const stale = await memberA.waitFor(
				(m) => m.type === "response" && m.command === "speak" && m.id === "stale1",
				30_000,
				baselineA,
			);
			expect(stale.success).toBe(true);
			expect(stale.data).toMatchObject({
				published: false,
				reason: "stale",
				missing_sequences: { from: 1, to: 1 },
				round: { round_max_messages: 10, used_messages: 0, remaining_messages: 10 },
			});
			expect(stale.data).not.toHaveProperty("hand_raised");
			expect(stale.data).not.toHaveProperty("handRaised");

			await new Promise((resolve) => setTimeout(resolve, 300));
			memberB.send({ id: "p1", type: "fetch_messages_since", since_sequence: 1 });
			const pulled = await memberB.waitFor(
				(m) => m.type === "response" && m.command === "fetch_messages_since" && m.id === "p1",
			);
			expect((pulled.data as Record<string, unknown>).total_messages).toBe(1);
			expect((pulled.data as Record<string, unknown>).latest_sequence).toBe(1);

			// ── B2: a current speak publishes ──────────────────────────────────
			memberA.send({ id: "ok1", type: "speak", content: "current reply", based_on_sequence: 1 });
			const ok1 = await memberA.waitFor(
				(m) => m.type === "response" && m.command === "speak" && m.id === "ok1",
				30_000,
			);
			expect(ok1.data).toMatchObject({ published: true, sequence: 2 });

			// ── B6: the next speak by the same character is NOT self-rejected ──
			memberA.send({ id: "ok2", type: "speak", content: "second by A", based_on_sequence: 2 });
			const ok2 = await memberA.waitFor(
				(m) => m.type === "response" && m.command === "speak" && m.id === "ok2",
				30_000,
			);
			expect(ok2.data).toMatchObject({ published: true, sequence: 3 });
			memberA.send({ id: "ok3", type: "speak", content: "third by A", based_on_sequence: 1 });
			const ok3 = await memberA.waitFor(
				(m) => m.type === "response" && m.command === "speak" && m.id === "ok3",
				30_000,
			);
			expect(ok3.data).toMatchObject({ published: true, sequence: 4 });

			// ── Legacy path: omitting the field skips the check ───────────────
			memberB.send({ id: "leg1", type: "speak", content: "legacy reply" });
			const legacy = await memberB.waitFor(
				(m) => m.type === "response" && m.command === "speak" && m.id === "leg1",
				30_000,
			);
			expect(legacy.data).toMatchObject({ published: true, sequence: 5 });

			// ── B2 again: a stale speak after real traffic is still refused ───
			memberB.send({ id: "stale2", type: "speak", content: "behind again", based_on_sequence: 1 });
			const stale2 = await memberB.waitFor(
				(m) => m.type === "response" && m.command === "speak" && m.id === "stale2",
				30_000,
			);
			expect(stale2.data).toMatchObject({
				published: false,
				reason: "stale",
				missing_sequences: { from: 2, to: 5 },
			});
			expect(stale2.data).toMatchObject({
				round: { round_max_messages: 10, used_messages: 4, remaining_messages: 6 },
			});
		} finally {
			try {
				for (const socket of sockets.splice(0)) {
					socket.terminate();
				}
				await leaveAndReset(creator, checkpoint);
			} catch (error) {
				// 清理失败只告警，不覆盖主断言错误（afterEach 兜底接管）。
				console.error(`[family] cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	});

	it("A1/A3/A4: broadcasts group_chat_update and incremental pull fills the gap without duplicates", async () => {
		const { descriptor, checkpoint } = await startFreshGroup(creator, projectDir, agentDir);
		try {
			// 循环等待：notify published 谓词非互斥（Arch 契约 3）——每轮命令前
			// 新取 checkpoint（契约 1：命令前取，防漏快速到达事件），杜绝重放命中旧事件。
			for (let i = 1; i <= 5; i++) {
				const roundCheckpoint = creator.checkpoint();
				await creator.runCommand(`/tavern-test-message message ${i}`);
				await creator.waitForAfter(
					roundCheckpoint,
					(e) =>
						e.type === "extension_ui_request" &&
						e.method === "notify" &&
						e.message === "User Persona message published",
				);
			}

			const member = await joinCharacterWs(descriptor, "ws-session-fetch", "characters/architect.md");
			await member.waitFor((m) => m.type === "message_history");
			// ISSUE-014/#14 (方案 A): the join itself broadcasts a
			// group_chat_update (latest_sequence 5) — the predicate below skips
			// it by requiring latest_sequence >= 6.

			await creator.runCommand("/tavern-test-message message 6");
			await creator.waitForAfter(
				checkpoint,
				(e) =>
					e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
			);
			const update = await member.waitFor(
				(m) => m.type === "group_chat_update" && (m.latest_sequence as number) >= 6,
				30_000,
			);
			expect(update.latest_sequence).toBe(6);
			expect(Array.isArray(update.preview_messages)).toBe(true);
			expect((update.preview_messages as Record<string, unknown>[]).length).toBeGreaterThan(0);

			member.socket.send(JSON.stringify({ id: "pull-1", type: "fetch_messages_since", since_sequence: 2 }));
			const pull = await member.waitFor(
				(m) => m.type === "response" && m.command === "fetch_messages_since" && m.id === "pull-1",
			);
			const pulled = (pull.data as { messages: Array<{ sequence: number }> }).messages;
			expect(pulled.map((m) => m.sequence)).toEqual([3, 4, 5, 6]);
			expect((pull.data as { latest_sequence: number }).latest_sequence).toBe(6);
			expect((pull.data as { total_messages: number }).total_messages).toBe(6);
		} finally {
			try {
				for (const socket of sockets.splice(0)) {
					socket.terminate();
				}
				await leaveAndReset(creator, checkpoint);
			} catch (error) {
				// 清理失败只告警，不覆盖主断言错误（afterEach 兜底接管）。
				console.error(`[family] cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
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

	it("advertises paging on join when history exceeds the 100-message snapshot window", async () => {
		const { descriptor, checkpoint } = await startFreshGroup(creator, projectDir, agentDir);
		try {
			// 同 A1：每轮命令前新 checkpoint（notify 谓词非互斥，重放会命中旧事件）。
			for (let i = 1; i <= 102; i++) {
				const roundCheckpoint = creator.checkpoint();
				await creator.runCommand(`/tavern-test-message message ${i}`);
				await creator.waitForAfter(
					roundCheckpoint,
					(e) =>
						e.type === "extension_ui_request" &&
						e.method === "notify" &&
						e.message === "User Persona message published",
				);
			}

			const member = await joinCharacterWs(descriptor, "ws-session-history", "characters/architect.md");
			const history = await member.waitFor((m) => m.type === "message_history");
			const messages = history.messages as Record<string, unknown>[];
			expect(messages).toHaveLength(100);
			expect(history.has_more).toBe(true);
			expect(history.cursor).toBeTruthy();
			expect(history.total_messages).toBe(102);
			expect(messages[0]?.sequence).toBe(3);
			expect(messages[99]?.sequence).toBe(102);

			await creator.waitForAfter(
				checkpoint,
				(e) =>
					e.type === "extension_ui_request" &&
					e.method === "setWidget" &&
					(e.widgetLines as string[])?.[0]?.startsWith("2 人在线") === true,
			);
		} finally {
			try {
				for (const socket of sockets.splice(0)) {
					socket.terminate();
				}
				await leaveAndReset(creator, checkpoint);
			} catch (error) {
				// 清理失败只告警，不覆盖主断言错误（afterEach 兜底接管）。
				console.error(`[family] cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	});
	it("broadcasts concurrent speaks in creator order and enforces the round quota", async () => {
		const { descriptor, checkpoint } = await startFreshGroup(creator, projectDir, agentDir);
		try {
			// speak-order 配额断言需 round_max_messages=3（原独立文件用 tavern.json
			// config_max_messages: 3）；family 共享 env 为 10（message-sync 断言）——
			// 场景内运行时改（/tavern-set-max 影响 future rounds；本 it 放 family
			// 最后，改后无场景再依赖 10）。
			await creator.runCommand("/tavern-set-max 3");
			await creator.waitForAfter(
				checkpoint,
				(e) =>
					e.type === "extension_ui_request" &&
					e.method === "notify" &&
					typeof e.message === "string" &&
					e.message.includes("Group max messages set to 3"),
			);

			// A User Persona message creates the round (RPC has no input channel;
			// the test-only command stands in for the creator's text input).
			await creator.runCommand("/tavern-test-message Hello from the creator");
			await creator.waitForAfter(
				checkpoint,
				(e) =>
					e.type === "extension_ui_request" && e.method === "notify" && e.message === "User Persona message published",
			);

			// ── Two raw clients join as characters ─────────────────────────────
			const memberA = await joinCharacterWs(descriptor, "ws-session-a", "characters/architect.md");
			sockets.push(memberA.socket);
			const memberB = await joinCharacterWs(descriptor, "ws-session-b", "characters/reviewer.md");
			sockets.push(memberB.socket);
			await memberA.waitFor((m) => m.type === "message_history");
			await memberB.waitFor((m) => m.type === "message_history");
			expect(
				memberA
					.allFrames()
					.filter((m) => m.type === "message_history")
					.some((m) => (m.messages as unknown[]).length === 1),
			).toBe(true);

			// ── Concurrent speaks (interleaved senders) ────────────────────────
			// M7 (ISSUE-012): speaks are announced via group_chat_update
			// notifications; content/sender is pulled on demand.
			// ISSUE-014/#14 (方案 A): membership changes also broadcast
			// group_chat_update — collect only notifications after this baseline
			// so join-time broadcasts do not pollute the sequence set.
			const speakBaselineA = memberA.allFrames().length;
			const speakBaselineB = memberB.allFrames().length;
			// join-time broadcasts carry latest_sequence 1 (the User Persona
			// message), speak notifications are >= 2.
			const collectA = memberA.collect(
				(m) => m.type === "group_chat_update" && (m.latest_sequence as number) >= 2,
				3,
				30_000,
				speakBaselineA,
			);
			const collectB = memberB.collect(
				(m) => m.type === "group_chat_update" && (m.latest_sequence as number) >= 2,
				3,
				30_000,
				speakBaselineB,
			);
			// Two from A, one from B — sent in a burst so arrival order is not
			// guaranteed by the clients; the creator serializes them.
			memberA.send({ id: "s1", type: "speak", content: "one" });
			memberB.send({ id: "s2", type: "speak", content: "two" });
			memberA.send({ id: "s3", type: "speak", content: "three" });

			const [seenByA, seenByB] = await Promise.all([collectA, collectB]);

			// Every receiver observes the same strictly increasing notification
			// sequence set: creator order is authoritative and identical for all
			// members (the notification carries the latest published sequence).
			const sequencesA = seenByA.map((m) => m.latest_sequence as number);
			const sequencesB = seenByB.map((m) => m.latest_sequence as number);
			expect(sequencesA).toEqual([2, 3, 4]);
			expect(sequencesB).toEqual([2, 3, 4]);

			// The final notification's preview carries the 3 published messages
			// (sequence 2..4, oldest-first); cross identity check: each preview
			// message's sender name must be the persona its connection claimed.
			const lastNotification = seenByA[2];
			expect(lastNotification).toBeDefined();
			if (!lastNotification) {
				throw new Error("expected 3 notifications");
			}
			const preview = lastNotification.preview_messages as Record<string, unknown>[];
			expect(preview.map((m) => m.sequence)).toEqual([2, 3, 4]);
			const senderNames = preview.map((m) => (m.sender as Record<string, unknown>).name).sort();
			expect(senderNames).toEqual(["Architect", "Architect", "Reviewer"]);

			// The pull path returns the same content, same order (same source).
			memberA.send({ id: "f1", type: "fetch_messages_since", since_sequence: 1 });
			const pulled = await memberA.waitFor(
				(m) => m.type === "response" && m.command === "fetch_messages_since" && m.id === "f1",
			);
			const pulledMessages = (pulled.data as Record<string, unknown>).messages as Record<string, unknown>[];
			expect(pulledMessages.map((m) => m.sequence)).toEqual([2, 3, 4]);
			expect((pulled.data as Record<string, unknown>).latest_sequence).toBe(4);
			expect(pulledMessages.map((m) => (m.sender as Record<string, unknown>).name).sort()).toEqual([
				"Architect",
				"Architect",
				"Reviewer",
			]);

			// ── Quota: the round allows 3 speaks; the 4th is not published ─────
			const baseline = memberA.allFrames().length;
			memberA.send({ id: "s4", type: "speak", content: "four" });
			// ISSUE-010: match the response by its request id — the creator replies
			// after broadcasting, so under parallel load earlier speak responses may
			// arrive after `baseline`; matching any speak response could pick s1's
			// (published: true) and flake. The response echoes the request id.
			const fourth = await memberA.waitFor(
				(m) => m.type === "response" && m.command === "speak" && m.id === "s4",
				30_000,
				baseline,
			);
			expect(fourth.success).toBe(true);
			expect((fourth.data as Record<string, unknown>).published).toBe(false);
			expect((fourth.data as Record<string, unknown>).hand_raised).toBe(true);

			// No 4th notification is broadcast (give any wrong broadcast a chance).
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 800));

			// Negative assertions from the receivers' perspective: a buggy
			// implementation that broadcast/persisted the 4th speak would still
			// satisfy toContain('"sequence":4') (the 3rd published speak already
			// holds sequence 4), so the absence must be asserted explicitly.
			const updatesA = memberA
				.allFrames()
				.filter((m) => m.type === "group_chat_update" && (m.latest_sequence as number) >= 2)
				.map((m) => m.latest_sequence as number);
			const updatesB = memberB
				.allFrames()
				.filter((m) => m.type === "group_chat_update" && (m.latest_sequence as number) >= 2)
				.map((m) => m.latest_sequence as number);
			expect(updatesA).toEqual([2, 3, 4]);
			expect(updatesB).toEqual([2, 3, 4]);
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
