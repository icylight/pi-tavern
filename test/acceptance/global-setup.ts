import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PiProcess } from "./pi-process.js";
import { createTempRoot } from "./temp-root.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * 并发运行锁（#191）：同机同一仓库只允许一次 acceptance 运行。
 *
 * 背景：globalSetup 的孤儿清理 `pkill -f <repo>/references/pi/pi-test.sh` 作用域
 * 是全机器——两次运行并行时，后启动者会把先启动者的在跑子进程一并 SIGTERM
 * （双向互杀，表现为大面积 stdin 不可写 / 等待超时）。
 * 解决：跑前取独占锁；已有活跃运行时 fail-fast 报「错峰」，孤儿 pkill 只在
 * 无活跃 run 时执行 → 不再可能杀到活动进程。锁为写死的 run 崩溃后由
 * 「pid 探活 + 时限」判陈旧并接管（接管路径的 pkill 恰好回收该 run 的孤儿）。
 *
 * 锁文件：<os.tmpdir()>/pi-tavern-acceptance-<repoHash>.lock（按仓库隔离——
 * pkill 模式本就按仓库路径匹配，跨仓库互不影响）。
 */
const LOCK_PATH = join(
	tmpdir(),
	`pi-tavern-acceptance-${createHash("sha1").update(REPO_ROOT).digest("hex").slice(0, 10)}.lock`,
);
/** 运行时效上限：超过视为陈旧（全量常态 1-3 分钟；防 pid 复用误判永久占锁）。 */
const LOCK_MAX_AGE_MS = 30 * 60_000;

interface LockInfo {
	pid: number;
	startedAt: number;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM = 进程存在但无权限（同机跨用户）：按存活处理。
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function acquireRunLock(): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			// wx = 原子独占创建：并发同时取锁只有一个成功。
			await writeFile(LOCK_PATH, JSON.stringify({ pid: process.pid, startedAt: Date.now() } satisfies LockInfo), {
				flag: "wx",
			});
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}
		}
		// 锁已存在：读内容判活跃/陈旧。
		let info: LockInfo | undefined;
		try {
			info = JSON.parse(await readFile(LOCK_PATH, "utf8")) as LockInfo;
		} catch {
			info = undefined;
		}
		const stale =
			info === undefined ||
			!Number.isFinite(info.pid) ||
			!Number.isFinite(info.startedAt) ||
			!isProcessAlive(info.pid) ||
			Date.now() - info.startedAt > LOCK_MAX_AGE_MS;
		if (!stale) {
			const ageSeconds = Math.round((Date.now() - (info as LockInfo).startedAt) / 1000);
			throw new Error(
				`[acceptance-lock] 已有 acceptance 运行在跑（pid=${info?.pid}，已 ${ageSeconds}s）——按错峰约定：等它结束再跑本 run。\n` +
					`锁文件：${LOCK_PATH}（确认该进程已死后可手动删除后重试）。`,
			);
		}
		// 陈旧锁：清掉后重试（并发接管由 wx 原子性兜底，最多 3 轮）。
		await rm(LOCK_PATH, { force: true });
	}
	throw new Error(`[acceptance-lock] 无法取得运行锁（连续 3 轮竞争失败）：${LOCK_PATH}`);
}

async function releaseRunLock(): Promise<void> {
	try {
		const info = JSON.parse(await readFile(LOCK_PATH, "utf8")) as LockInfo;
		// 只删自己的锁（防 teardown 误删接管者的锁）。
		if (info.pid === process.pid) {
			await rm(LOCK_PATH, { force: true });
		}
	} catch {
		// 锁不存在/不可读：无需处理。
	}
}

/**
 * 跑前清理：被中断的 acceptance 运行会残留孤儿 pi 进程
 * （工具超时杀死父进程、pi 子进程存活）——实测 10 个孤儿让后续全量 >600s 未完成
 * （资源抢占 + 等待窗口烧满）。调用点在取得运行锁之后：本机必无其他活跃 run，
 * 此处的全机器 pkill 才安全（#191）。无匹配时 pkill 非零退出属正常。
 */
async function killOrphanedPiProcesses(): Promise<void> {
	const execFileAsync = promisify(execFile);
	// 默认清 references/pi 路径；PI_TEST_SH 覆盖时（0.83.0 补跑）追加匹配。
	const patterns = [resolve(REPO_ROOT, "references", "pi", "pi-test.sh")];
	if (process.env.PI_TEST_SH) {
		patterns.push(resolve(REPO_ROOT, process.env.PI_TEST_SH));
	}
	// pkill -f 按扩展正则匹配：路径含 ()/+/./[] 等元字符时需转义（B 级，
	// CI/共享机路径不可控；当前仓库路径无元字符，转义为前瞻性健壮性）。
	for (const pattern of patterns) {
		const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		try {
			await execFileAsync("pkill", ["-f", escaped]);
		} catch {
			// 无孤儿进程：正常。
		}
	}
	await new Promise((resolveWait) => setTimeout(resolveWait, 500));
}

/**
 *  P1：tsx 预热 globalSetup——每个 vitest 进程一次。
 *
 * 冷启动（tsx 编译 references/pi coding-agent + 扩展加载）~15s（探针
 * 实测），预热后 ~4.6s。一次预热成本换全链每个 spawn 提速 ~10s。
 *
 * 失败策略：预热是优化非依赖——失败仅告警，不阻塞测试运行。
 */
export async function setup(): Promise<void> {
	await acquireRunLock();
	try {
		await killOrphanedPiProcesses();
		const root = await createTempRoot("pi-tavern-warmup-");
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
	} catch (error) {
		// setup 失败（含锁冲突）必须放锁，否则锁悬挂到陈旧判定。
		await releaseRunLock();
		throw error;
	}
}

export async function teardown(): Promise<void> {
	await releaseRunLock();
}
