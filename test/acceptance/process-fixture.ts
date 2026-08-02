import { type EventCheckpoint, PiProcess, type SpawnPiOptions } from "./pi-process.js";

/**
 * 测试架构改造 v2（User 拍板 2026-08-02，Arch 评审）：兼容场景串行共享 creator
 * fixture——同一时刻只服务一个群聊（tavern-controller 单状态机契约），并发隔离
 * 单元 = 进程工作区；场景间隔离经 EventCheckpoint（pi-process.waitForAfter）。
 *
 * 硬约束（Arch 已核源码）：① controller 单状态机（idle|joining|creator|character），
 * 未 leave 再 /tavern-new 必 "already bound"；② 共享后事件必然串扰 → waitForAfter
 * 场景内强制使用；③ 失败传染 → leaveAndReset/resetOrRespawnCreator 双保险。
 */

/** 诊断：累计 spawn 次数与时长（试点通过条件 ⑤ 的中位数/次数对比依据）。 */
export const spawnStats = { count: 0, totalMs: 0, timesMs: [] as number[] };

export interface FixtureProcesses {
	creator: PiProcess;
	agentDir: string;
	projectDir: string;
}

/**
 * 基建①：spawn 一个真实 pi（creator 角色，/tavern-new 用）。统计 spawn 次数与
 * 时长（诊断输出，供试点通过条件 ⑤ 对比）。
 */
export function spawnCreator(options: SpawnPiOptions): PiProcess {
	const t0 = Date.now();
	const process_ = PiProcess.spawn(options);
	spawnStats.count += 1;
	spawnStats.timesMs.push(Date.now() - t0);
	spawnStats.totalMs += Date.now() - t0;
	return process_;
}

/**
 * 基建②：spawn 一个真实 pi（headless 角色，PITAVERN_AUTO_JOIN 用）。
 */
export function spawnHeadless(options: SpawnPiOptions): PiProcess {
	return spawnCreator(options); // 同一统计通道：headless 也是真实 pi 进程
}

/**
 * 基建④：在共享 creator 上开一个新群聊（/tavern-new + descriptor 落盘）。
 * 调用前必须 leaveAndReset（或状态为 idle）——controller "already bound" 契约。
 */
export async function startFreshGroup(
	creator: PiProcess,
	projectDir: string,
	agentDir: string,
): Promise<{ descriptor: Awaited<ReturnType<PiProcess["startGroupChat"]>>; checkpoint: EventCheckpoint }> {
	const checkpoint = creator.checkpoint();
	const descriptor = await creator.startGroupChat(projectDir, agentDir);
	return { descriptor, checkpoint };
}

/**
 * 基建⑤：离开当前群聊并把 controller 归位 idle（/tavern-leave + 等关闭通知）。
 * 幂等：idle 时 notify "No active group chat" 也算成功（checkpoint 后取任一
 * 结束通知即可）。
 */
export async function leaveAndReset(
	creator: PiProcess,
	checkpoint: EventCheckpoint,
	timeoutMs = 30_000,
): Promise<void> {
	await creator.runCommand("/tavern-leave");
	await creator.waitForAfter(
		checkpoint,
		(e) =>
			e.type === "extension_ui_request" &&
			e.method === "notify" &&
			typeof e.message === "string" &&
			(e.message.includes("closed") || e.message.includes("Left") || e.message.includes("No active")),
		timeoutMs,
	);
}

/**
 * 基建⑥：失败/异常恢复——creator 已死或 leave 失联时杀旧重生（重绑组合根）。
 * 健康检查：进程存活 + 状态机可操作（/tavern-leave 幂等后重试 /tavern-new）。
 */
export async function resetOrRespawnCreator(
	options: SpawnPiOptions,
	fixture: { creator: PiProcess },
	projectDir: string,
	agentDir: string,
): Promise<{
	creator: PiProcess;
	descriptor: Awaited<ReturnType<PiProcess["startGroupChat"]>>;
	checkpoint: EventCheckpoint;
}> {
	if (!fixture.creator.exited) {
		// 存活但可能状态脏：尝试 leave 归位（幂等），失败则强杀重生。
		try {
			const checkpoint = fixture.creator.checkpoint();
			await leaveAndReset(fixture.creator, checkpoint, 10_000);
		} catch {
			await fixture.creator.kill("SIGKILL");
		}
	}
	if (!fixture.creator.exited) {
		return {
			creator: fixture.creator,
			...(await startFreshGroup(fixture.creator, projectDir, agentDir)),
		};
	}
	const fresh = spawnCreator(options);
	fixture.creator = fresh;
	const result = await startFreshGroup(fresh, projectDir, agentDir);
	return { creator: fresh, ...result };
}
