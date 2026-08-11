import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { PiProcess, waitForDescriptor } from "./pi-process.js";

/**
 *  J2 降级钉测：RPC abort 不清空已入队 steer。
 *
 * 背景：J2 双版本对比（0.82.1 vs 0.83.0）三路实证——① RPC 实测 abort 后
 * pendingMessageCount 保留；② clearQueue 清空仅存在于 interactive 模式
 * （用户 Esc/abort 恢复编辑器路径），两版本同构；③ 0.82.1→0.83.0 共 176
 * commits 无 abort/queue/steer 相关变更。结论：版本差异实锤不成立（双绿），
 * 升级 pi 上游 issue 路径关闭。
 *
 * 本钉 = 把实证①固化为回归钉：真实 pi（默认锚定 references/pi 0.82.1）RPC
 * 模式下 steer 入队 → abort → 队列保留（消息不丢）。防未来 pi 升级引入
 * 「abort 清队列」行为回归（届时本钉即红，触发重新评估）。
 *
 * 实现注记：
 * - /tavern-new 群聊创建流程与 abort 的 waitForIdle 有时序耦合（创建未完成
 *   时 abort 可挂起）——本钉先等 descriptor 落盘再执行命令序列。
 * - abort 后偶发第二个连续 RPC 命令无响应（pi 0.82.1 RPC 侧疑点，非本钉
 *   语义面）——abort 后的状态验证改用事件扫描式（send + 轮询 events），
 *   不依赖响应 id 匹配，钉测聚焦「队列保留」语义。
 *
 * 绿 = 现有行为；红基线 = abort 后 pending 归零（消息被清）。
 */
describe("acceptance: J2 降级——RPC abort 不清已入队 steer", () => {
	let index = 0;
	const roots: string[] = [];
	const processes: PiProcess[] = [];

	afterAll(async () => {
		for (const process_ of processes) {
			await process_.kill("SIGTERM");
		}
		await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
	});

	async function startCreator(): Promise<{ creator: PiProcess; root: string }> {
		const root = await mkdtemp(join(tmpdir(), `pi-tavern-acc-j2-${index}-`));
		index += 1;
		roots.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await mkdir(projectDir, { recursive: true });
		await writeFile(join(agentDir, "characters", "dev.md"), "---\nname: Dev\ndescription: Developer\n---\nDev prompt");
		await writeFile(join(agentDir, "tavern.json"), JSON.stringify({ characters: ["characters/dev.md"] }));

		const creator = PiProcess.spawn({
			label: "creator",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator"),
			cwd: projectDir,
		});
		processes.push(creator);
		await creator.waitForTavernReady();
		await creator.runCommand("/tavern-new");
		// 等群聊创建完成（descriptor 落盘）——消除与 abort waitForIdle 的时序耦合。
		await waitForDescriptor(agentDir, projectDir);
		return { creator, root };
	}

	async function rpc(creator: PiProcess, message: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = await creator.send(message);
		return creator.waitFor((e) => e.id === id && e.type === "response");
	}

	/** 事件扫描式取最近一次 get_state 的 data（不依赖响应 id 匹配，见文件头注记）。 */
	async function scanLatestState(creator: PiProcess, timeoutMs = 15_000): Promise<{ pendingMessageCount?: number }> {
		const id = await creator.send({ type: "get_state" });
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const hit = (creator as unknown as { events: Array<Record<string, unknown>> }).events.find(
				(e) => e.id === id && e.type === "response" && e.command === "get_state",
			);
			if (hit) {
				return (hit.data as { pendingMessageCount?: number }) ?? {};
			}
			if (Date.now() > deadline) {
				throw new Error("timeout scanning get_state response");
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 100));
		}
	}

	it("J2: steer 入队后 abort——pendingMessageCount 保留（消息不丢）", async () => {
		const { creator } = await startCreator();

		// ① steer 入队（pi 原生 steer 通道与 extension sendMessage 同队列）。
		await rpc(creator, { type: "steer", message: "J2-abort-no-loss" });
		const before = await scanLatestState(creator);
		expect(before.pendingMessageCount).toBe(1);

		// ② abort（RPC abort = session.abort：abortRetry + agent.abort + waitForIdle）。
		await rpc(creator, { type: "abort" });

		// ③ 不丢：abort 后队列保留（若 pi 升级引入 abort 清队列，此处归零 = 本钉红）。
		const after = await scanLatestState(creator);
		expect(after.pendingMessageCount).toBe(1);

		// ④ 不阻塞：abort 后队列仍可继续入队（第二条 steer → 2，若 pi 升级引入
		// abort 后队列锁死，此处不达 2 = 本钉红）。
		await rpc(creator, { type: "steer", message: "J2-abort-no-loss-2" });
		const afterSecond = await scanLatestState(creator);
		expect(afterSecond.pendingMessageCount).toBe(2);
	});
});
