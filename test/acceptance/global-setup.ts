import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiProcess } from "./pi-process.js";

/**
 * #45 P1（QA）：tsx 预热 globalSetup——每个 vitest 进程一次。
 *
 * 冷启动（tsx 编译 references/pi coding-agent + 扩展加载）~15s（Dev 探针
 * 实测），预热后 ~4.6s（QA 实测）。一次预热成本换全链每个 spawn 提速 ~10s。
 *
 * 失败策略：预热是优化非依赖——失败仅告警，不阻塞测试运行。
 */
export default async function setup(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-tavern-warmup-"));
	try {
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await mkdir(projectDir, { recursive: true });
		await writeFile(
			join(agentDir, "characters", "architect.md"),
			"---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt",
		);
		await writeFile(join(agentDir, "tavern.json"), JSON.stringify({ characters: ["characters/architect.md"] }));

		const process_ = PiProcess.spawn({
			label: "warmup",
			agentDir,
			sessionDir: join(agentDir, "sessions", "warmup"),
			cwd: projectDir,
		});
		const t0 = Date.now();
		await process_.waitForTavernReady(90_000);
		await process_.kill("SIGTERM");
		console.log(`[warmup] tsx 预热完成: ${Date.now() - t0}ms`);
	} catch (error) {
		console.warn(`[warmup] 预热失败（不阻塞测试）: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
	}
}
