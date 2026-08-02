import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PiProcess } from "./pi-process.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * 跑前清理（2026-08-02 QA 教训）：被中断的 acceptance 运行会残留孤儿 pi 进程
 * （工具超时杀死父进程、pi 子进程存活）——实测 10 个孤儿让后续全量 >600s 未完成
 * （资源抢占 + 等待窗口烧满）。pkill 只匹配本仓 references/pi/pi-test.sh 路径，
 * 项目作用域，不误杀用户其他进程；无匹配时 pkill 非零退出属正常。
 */
async function killOrphanedPiProcesses(): Promise<void> {
	const execFileAsync = promisify(execFile);
	const pattern = resolve(REPO_ROOT, "references", "pi", "pi-test.sh");
	// pkill -f 按扩展正则匹配：路径含 ()/+/./[] 等元字符时需转义（Arch B 级，
	// CI/共享机路径不可控；当前仓库路径无元字符，转义为前瞻性健壮性）。
	const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	try {
		await execFileAsync("pkill", ["-f", escaped]);
	} catch {
		// 无孤儿进程：正常。
	}
	await new Promise((resolveWait) => setTimeout(resolveWait, 500));
}

/**
 * #45 P1（QA）：tsx 预热 globalSetup——每个 vitest 进程一次。
 *
 * 冷启动（tsx 编译 references/pi coding-agent + 扩展加载）~15s（Dev 探针
 * 实测），预热后 ~4.6s（QA 实测）。一次预热成本换全链每个 spawn 提速 ~10s。
 *
 * 失败策略：预热是优化非依赖——失败仅告警，不阻塞测试运行。
 */
export default async function setup(): Promise<void> {
	await killOrphanedPiProcesses();
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
