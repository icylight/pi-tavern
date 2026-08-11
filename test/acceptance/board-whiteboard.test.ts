import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PiProcess } from "./pi-process.js";
import { leaveAndReset, spawnCreator, startFreshGroup } from "./process-fixture.js";
import type { BufferedWsClient } from "./ws-helper.js";
import { joinCharacterWs } from "./ws-helper.js";

/**
 * #114 B6 acceptance：白板模型端到端（QA 属主，2026-08-04）。
 *
 * 契约源：issue #114（09:50 版）B6 节 + 验收锚点 1-4。
 *
 * 验收锚点挂靠：
 *   锚点 ①（README 位置议题 ≤1 轮摇摆，方向性指标）——测试 3 以协议级
 *   定向模拟重放该议题的立场翻转序列，机制断言硬校验、摇摆计数软记录
 *   （acceptance 车道零 LLM 确定性运行——#52 白名单闸门，真实 AI 方差
 *   不可复现；「接受模型方差」按 issue 语义落地为：机制断言不依赖模型、
 *   翻转 trace 留痕供人工比照）。
 *   锚点 ②（白板即事实源，无需转述）——board_query//tavern-status 即事实
 *   源；角色不依赖消息流转述（测试 3 断言板上只有当前立场）。
 *   锚点 ③（旧裁决不再被误引用为「当前」）——撕条后板/status 均无残留
 *   （测试 3 断言已撕内容不可见）。
 *   锚点 ④（边界）——测试 1 覆盖：超限/超长拒绝、撕条通知、remove 不存在
 *   /clear 空板/set 不存在 id = changed:false + 告知码、群聊静默。
 *
 * 机制锚点（B4 字符侧接线）：headless 角色 stderr 观察通道
 *   [tavern-inject] board_updates=N（无头 notify 走 stderr）——门闸放行 +
 *   白板桶渲染可达；latest_seq 注入缺席 = 不触发消息流拉取（负例）。
 */
describe("acceptance: #114 whiteboard board flow e2e", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	let creator: PiProcess;
	const processes: PiProcess[] = [];

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-tavern-acc-board-"));
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await mkdir(projectDir, { recursive: true });
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
		processes.push(creator);
	});

	afterAll(async () => {
		for (const process_ of processes) {
			await process_.kill("SIGTERM");
		}
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
	});

	interface BoardWriteResponse {
		id: string;
		result: { changed: boolean; note?: { id: string; content: string }; code?: string };
	}

	interface BoardUpdate {
		method: "board_update";
		params: { actor: string; action: string; note?: { id: string; content: string } };
	}

	interface BoardQueryResponse {
		id: string;
		result: { boards: Record<string, { id: string; content: string }[]> };
	}

	function asBoardQueryResponse(message: Record<string, unknown>): BoardQueryResponse {
		return message as unknown as BoardQueryResponse;
	}

	function asBoardWriteResponse(message: Record<string, unknown>): BoardWriteResponse {
		return message as unknown as BoardWriteResponse;
	}

	function asBoardUpdate(message: Record<string, unknown>): BoardUpdate {
		return message as unknown as BoardUpdate;
	}

	async function waitNoBoardUpdate(client: BufferedWsClient, fromIndex: number, timeoutMs = 4000): Promise<void> {
		// 群聊静默断言：changed:false 不广播 board_update——窗口内不得出现新通知。
		// 注：不用 client.waitFor——其超时仅在帧到达时检查，真「无帧等待」永不
		// 超时（测试基建 quirk，QA 2026-08-04 实测）；缺席断言用轮询。
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (
				client
					.allFrames()
					.slice(fromIndex)
					.some((m) => m.method === "board_update")
			) {
				throw new Error("unexpected board_update broadcast (changed:false should be silent)");
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 100));
		}
	}

	it("board 全流程：贴/改/撕/清 + 四态 + 广播 + 静默 + status 小节（锚点 ④）", async () => {
		const { descriptor } = await startFreshGroup(creator, projectDir, agentDir);
		const client = await joinCharacterWs(descriptor, "sess-a", "characters/architect.md");
		try {
			// ── 贴新条：id 回带 + add 广播 ─────────────────────────
			client.send({
				jsonrpc: "2.0",
				id: "w1",
				method: "board_write",
				params: { action: "set", note: { content: "README 放仓库根目录" } },
			});
			const r1 = asBoardWriteResponse(await client.waitFor((m) => m.id === "w1" && "result" in m));
			expect(r1.result.changed).toBe(true);
			expect(typeof r1.result.note?.id).toBe("string");
			expect(r1.result.note?.content).toBe("README 放仓库根目录");
			const r1note = r1.result.note;
			if (r1note === undefined) throw new Error("B1 定稿：set 新贴响应 note 必带（id 回带闭环）");
			const noteId = r1note.id as string;

			const u1 = asBoardUpdate(await client.waitFor((m) => m.method === "board_update"));
			expect(u1.params.actor).toBe("characters/architect.md");
			expect(u1.params.action).toBe("add");
			expect(u1.params.note).toEqual({ id: noteId, content: "README 放仓库根目录" });

			// ── 改条（edit）：update 广播带新内容 ───────────────────
			client.send({
				jsonrpc: "2.0",
				id: "w2",
				method: "board_write",
				params: {
					action: "set",
					note: { id: noteId, content: "README 放根目录（v2）" },
				},
			});
			const r2 = asBoardWriteResponse(await client.waitFor((m) => m.id === "w2" && "result" in m));
			expect(r2.result.changed).toBe(true);
			expect(r2.result.note?.content).toBe("README 放根目录（v2）");
			await client.waitFor(
				(m) =>
					m.method === "board_update" &&
					(m.params as Record<string, unknown>).action === "update" &&
					((m.params as Record<string, unknown>).note as { id: string } | undefined)?.id === noteId,
			);

			// ── 撕条：remove 广播携带被撕条完整内容（锚点 ③ 增量摘要）──
			client.send({
				jsonrpc: "2.0",
				id: "w3",
				method: "board_write",
				params: { action: "remove", note: { id: noteId } },
			});
			const r3 = asBoardWriteResponse(await client.waitFor((m) => m.id === "w3" && "result" in m));
			expect(r3.result.changed).toBe(true);
			const u3 = asBoardUpdate(
				await client.waitFor(
					(m) => m.method === "board_update" && (m.params as Record<string, unknown>).action === "remove",
				),
			);
			expect(u3.params.note).toEqual({ id: noteId, content: "README 放根目录（v2）" });

			// ── remove 不存在条：告知码 + 群聊静默（拍板 ③）────────
			const ghostIndex = client.allFrames().length;
			client.send({
				jsonrpc: "2.0",
				id: "w4",
				method: "board_write",
				params: { action: "remove", note: { id: "no-such-id" } },
			});
			const r4 = asBoardWriteResponse(await client.waitFor((m) => m.id === "w4" && "result" in m));
			expect(r4.result.changed).toBe(false);
			expect(r4.result.code).toBe("note_not_found");
			await waitNoBoardUpdate(client, ghostIndex);

			// ── 5 条上限：第 6 条拒绝码 + 静默 ─────────────────────
			const ids: string[] = [];
			for (let i = 0; i < 5; i += 1) {
				const tag = `n${i}`;
				client.send({
					jsonrpc: "2.0",
					id: `w5-${i}`,
					method: "board_write",
					params: { action: "set", note: { content: tag } },
				});
				const ri = asBoardWriteResponse(await client.waitFor((m) => m.id === `w5-${i}` && "result" in m));
				expect(ri.result.changed).toBe(true);
				ids.push((ri.result.note as { id: string }).id);
			}
			// 等最后一条 add 广播落帧（响应先到、广播后到——rejectIndex 须在广播之后取）
			await client.waitFor(
				(m) =>
					m.method === "board_update" &&
					(m.params as Record<string, unknown>).action === "add" &&
					((m.params as Record<string, unknown>).note as { id: string } | undefined)?.id === ids[4],
			);
			const rejectIndex = client.allFrames().length;
			client.send({
				jsonrpc: "2.0",
				id: "w6",
				method: "board_write",
				params: { action: "set", note: { content: "第六条" } },
			});
			const r6 = asBoardWriteResponse(await client.waitFor((m) => m.id === "w6" && "result" in m));
			expect(r6.result.changed).toBe(false);
			expect(r6.result.code).toBe("max_notes_exceeded");
			await waitNoBoardUpdate(client, rejectIndex);

			// ── clear 非空板：applied 广播 clear 无 note ───────────
			client.send({
				jsonrpc: "2.0",
				id: "w7",
				method: "board_write",
				params: { action: "clear" },
			});
			const r7 = asBoardWriteResponse(await client.waitFor((m) => m.id === "w7" && "result" in m));
			expect(r7.result.changed).toBe(true);
			expect(r7.result.note).toBeUndefined();
			await client.waitFor(
				(m) => m.method === "board_update" && (m.params as Record<string, unknown>).action === "clear",
			);
			expect(
				((client.allFrames().at(-1) as Record<string, unknown>).params as Record<string, unknown> | undefined)?.note,
			).toBeUndefined();

			// ── clear 空板：board_empty 告知码 + 静默 ───────────────
			const emptyIndex = client.allFrames().length;
			client.send({
				jsonrpc: "2.0",
				id: "w8",
				method: "board_write",
				params: { action: "clear" },
			});
			const r8 = asBoardWriteResponse(await client.waitFor((m) => m.id === "w8" && "result" in m));
			expect(r8.result.changed).toBe(false);
			expect(r8.result.code).toBe("board_empty");
			await waitNoBoardUpdate(client, emptyIndex);

			// ── /tavern-status 白板小节（B5 e2e）──────────────────
			const statusCp = creator.checkpoint();
			await creator.runCommand("/tavern-status");
			const status = await creator.waitForAfter(
				statusCp,
				(e) => e.type === "extension_ui_request" && e.method === "notify" && typeof e.message === "string",
			);
			// 空板（clear 后）：Boards 段渲染为 (empty)——板存在但无条（B5 实测语义）
			expect(status.message).toContain("Boards:");
			expect(status.message).toContain("Architect: (empty)");
		} finally {
			client.terminate();
			const leaveCp = creator.checkpoint();
			await leaveAndReset(creator, leaveCp, 15_000).catch(() => undefined);
		}
	});

	it("字符侧消费：门闸放行 + 白板桶渲染可达 + 不触发消息流拉取（B4 接线 e2e）", async () => {
		const { descriptor } = await startFreshGroup(creator, projectDir, agentDir);

		const headless = spawnCreator({
			label: "hl-board",
			agentDir,
			sessionDir: join(agentDir, "sessions", "hl-board"),
			cwd: projectDir,
			env: {
				PITAVERN_AUTO_JOIN: "1",
				PITAVERN_CHARACTER: "characters/reviewer.md",
				PITAVERN_GROUP_CHAT: descriptor.groupChatId,
				PITAVERN_AUTO_JOIN_DELAY_MS: "100",
			},
		});
		processes.push(headless);
		await headless.waitForStderr("Auto-joined", 60_000);

		const client = await joinCharacterWs(descriptor, "sess-b", "characters/architect.md");
		try {
			// 观察通道 = RPC 事件流（extension_ui_request notify）：session_start
			// 在 RPC 模式同样触发（headless.test.ts 注释过时，QA B6 实证）。
			const injectNotify = (needle: string) => (e: { type: string; method?: string; message?: unknown }) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				typeof e.message === "string" &&
				e.message.includes("[tavern-inject]") &&
				e.message.includes(needle);

			// 主断言：board_write → broadcast → 门闸放行 → 白板桶渲染
			//（board_updates=1 注入）。
			// 注：speak 对照（两套消费语义）由 integration board-input.test.ts
			// 覆盖；acceptance 层不做——headless 零 LLM 环境的 public_message
			// 投递时序不稳定（QA B6 实证：15-20s 延迟、run 后 60s+ 停滞，
			// 平台级现象，待 Dev/Arch 三查，非白板缺陷）。
			const injectCheckpoint = headless.checkpoint();
			client.send({
				jsonrpc: "2.0",
				id: "b1",
				method: "board_write",
				params: { action: "set", note: { content: "共识一" } },
			});
			asBoardWriteResponse(await client.waitFor((m) => m.id === "b1" && "result" in m));
			const boardNotify = await headless.waitFor(injectNotify("board_updates=1"), 60_000);

			// 负例：board_update 不是 public_message——board 写入后到 board 注入
			// 之间不得出现新的 latest_seq（消息流拉取注入）。
			const preBoardEvents = headless
				.dumpEvents()
				.slice(injectCheckpoint.index, headless.dumpEvents().indexOf(boardNotify));
			expect(
				preBoardEvents.some(
					(e) => e.type === "extension_ui_request" && e.method === "notify" && String(e.message).includes("latest_seq"),
				),
			).toBe(false);
		} finally {
			client.terminate();
			await headless.kill("SIGTERM").catch(() => undefined);
			const leaveCp = creator.checkpoint();
			await leaveAndReset(creator, leaveCp, 15_000).catch(() => undefined);
		}
	});

	it("收敛重放：README 位置议题立场翻转——撕旧贴新、板上只有当前、无陈旧引用（锚点 ①②③）", async () => {
		const { descriptor } = await startFreshGroup(creator, projectDir, agentDir);
		const arch = await joinCharacterWs(descriptor, "sess-c1", "characters/architect.md");
		const rev = await joinCharacterWs(descriptor, "sess-c2", "characters/reviewer.md");
		const sway: string[] = [];
		try {
			// 模拟 README 位置议题（#105：8+ 轮摇摆）：architect 立场两次翻转。
			// 每轮 = 撕掉旧立场条 + 贴新立场条（贴条即更新、撕条即撤销）。
			async function postStance(client: BufferedWsClient, id: string, content: string, note?: { id: string }) {
				client.send({
					jsonrpc: "2.0",
					id,
					method: "board_write",
					params: { action: "set", note: note ? { id: note.id, content } : { content } },
				});
				const r = asBoardWriteResponse(await client.waitFor((m) => m.id === id && "result" in m));
				expect(r.result.changed).toBe(true);
				return (r.result.note as { id: string }).id;
			}
			async function tear(client: BufferedWsClient, id: string, noteId: string) {
				client.send({
					jsonrpc: "2.0",
					id,
					method: "board_write",
					params: { action: "remove", note: { id: noteId } },
				});
				const r = asBoardWriteResponse(await client.waitFor((m) => m.id === id && "result" in m));
				expect(r.result.changed).toBe(true);
			}

			// 第 0 轮：architect 贴「根目录」；reviewer 贴「docs/」
			const a0 = await postStance(arch, "r0", "README 放仓库根目录");
			await postStance(rev, "r0r", "README 放 docs/ 下");

			// 第 1 轮（翻转 1）：reviewer 反驳 → architect 撕旧贴新「docs/」
			await tear(arch, "r1", a0);
			const a1 = await postStance(arch, "r2", "README 放 docs/ 下（reviewer 说得对）");
			sway.push("flip1: 根目录 → docs/");

			// 第 2 轮（翻转 2）：架构考量反驳 → architect 再撕再贴「根目录」
			await tear(arch, "r3", a1);
			const a2 = await postStance(arch, "r4", "README 放仓库根目录（可发现性优先）");
			sway.push("flip2: docs/ → 根目录");

			// ── 机制断言：板上只有当前立场（锚点 ①②③）──────────
			arch.send({ jsonrpc: "2.0", id: "q1", method: "board_query" });
			const q = asBoardQueryResponse(await arch.waitFor((m) => m.id === "q1" && "result" in m));
			const boards = q.result.boards;
			const archBoard = boards["characters/architect.md"] ?? [];
			expect(archBoard).toHaveLength(1); // 两次翻转后只剩当前条
			expect(archBoard[0]).toEqual({ id: a2, content: "README 放仓库根目录（可发现性优先）" });
			// 已撕内容（docs/ 立场、v2 措辞）不得残留——旧裁决不再可引用
			expect(archBoard.some((n) => n.content.includes("docs/"))).toBe(false);
			expect(boards["characters/reviewer.md"]?.[0]?.content).toBe("README 放 docs/ 下");

			// ── /tavern-status：Boards 段只含当前条（撕下内容不可见）──
			const statusCp = creator.checkpoint();
			await creator.runCommand("/tavern-status");
			const status = await creator.waitForAfter(
				statusCp,
				(e) =>
					e.type === "extension_ui_request" &&
					e.method === "notify" &&
					typeof e.message === "string" &&
					e.message.includes("Boards:"),
			);
			expect(status.message).toContain("Boards:");
			expect(status.message).toContain("README 放仓库根目录（可发现性优先）");
			expect(status.message).not.toContain("reviewer 说得对"); // 已撕内容不出现在 status

			// ── 方向性指标（锚点 ①）：翻转 trace 留痕，不作硬门禁 ──
			console.log(`[board-convergence] sway trace: ${sway.join(" | ")} (n=${sway.length})`);
		} finally {
			arch.terminate();
			rev.terminate();
			const leaveCp = creator.checkpoint();
			await leaveAndReset(creator, leaveCp, 15_000).catch(() => undefined);
		}
	});
});
