#!/usr/bin/env node
/**
 * 仓库健康度检查（含凭据扫描诉求）。
 *
 * 聚合三项子检查，本地手动运行：npm run health
 *   1. audit   —— 依赖漏洞（npm audit --omit=dev，生产依赖面；需联网）
 *   2. gitleaks—— 凭据泄露扫描（外部二进制，未安装时明确标注失败不吞错）
 *   3. hygiene —— 仓库卫生（未提交改动 / 已合入残留分支 / 超大文件，零依赖内置）
 *
 * 输出与退出码语义（验收 H1/H2）：
 *   - 每行固定前缀 [health][<check>]，check ∈ audit/gitleaks/hygiene
 *   - 汇总行 [health][summary] n/3 通过
 *   - 退出码：0 = 全绿；1 = 任一子检查有发现或失败（输出明确标注失败项，不吞错）
 *
 * 明确不做（User 拍板口径）：CI 集成、pre-commit 拦截、整体评分。
 * 环境变量：HEALTH_MAX_FILE_BYTES 可调超大文件阈值（默认 1MB，QA 钉测可用小值自测）。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const MAX_FILE_BYTES = Number(process.env.HEALTH_MAX_FILE_BYTES ?? 1024 * 1024);
const TIMEOUT_MS = 120_000;

/** 收集子检查结果：{ check, ok, lines[] } */
const results = [];

function report(check, ok, ...lines) {
	results.push({ check, ok, lines });
}

function run(cmd, args, opts = {}) {
	return spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout: TIMEOUT_MS, ...opts });
}

/** 1. 依赖漏洞（生产依赖面，需联网；网络不可达/执行异常明确标注，不吞错） */
function checkAudit() {
	const r = run("npm", ["audit", "--omit=dev", "--audit-level=low"]);
	if (r.error) {
		report("audit", false, `无法执行：${r.error.message}`);
		return;
	}
	const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
	const m = out.match(/found (\d+) vulnerabilities?/);
	if (m) {
		report("audit", m[1] === "0", `依赖漏洞：${m[1]} 个（npm audit --omit=dev）`);
		return;
	}
	if (/ENOAUDIT|ECONN|ETIMEDOUT|SOCKET|ENETUNREACH/.test(out)) {
		report("audit", false, "无法执行：npm registry 不可达（audit 需联网，可稍后重跑）");
		return;
	}
	report("audit", false, `执行异常（exit ${r.status}）：${out.trim().slice(0, 200) || "无输出"}`);
}

/** 2. 凭据泄露扫描（gitleaks 外部二进制；缺失时明确标注失败） */
function checkGitleaks() {
	const which = run("which", ["gitleaks"]);
	if (which.status !== 0) {
		report("gitleaks", false, "未安装 gitleaks（凭据扫描依赖 gitleaks；安装后重跑，如 brew install gitleaks）");
		return;
	}
	const reportPath = join(tmpdir(), `health-gitleaks-${process.pid}.json`);
	const r = run("gitleaks", [
		"detect", "--source", ROOT, "--no-banner", "--redact",
		"--report-format", "json", "--report-path", reportPath,
	]);
	let leaked = 0;
	if (r.status === 0) {
		report("gitleaks", true, "凭据：未检出");
	} else if (r.status === 1 && existsSync(reportPath)) {
		try {
			leaked = JSON.parse(readFileSync(reportPath, "utf8")).length;
		} catch {
			// 报告文件异常时按 0 处理，输出仍标注失败
		}
		report("gitleaks", false, `凭据检出 ${leaked} 条（gitleaks 明细见其输出）`);
	} else {
		const out = `${r.stderr ?? ""}\n${r.stdout ?? ""}`.trim().slice(0, 200);
		report("gitleaks", false, `执行异常（exit ${r.status}）：${out || "无输出"}`);
	}
	rmSync(reportPath, { force: true });
}

/** 3. 仓库卫生（零依赖内置：git 只读命令 + 文件大小统计） */
function checkHygiene() {
	const lines = [];

	const status = run("git", ["status", "--porcelain"]);
	const uncommitted = (status.stdout ?? "").split("\n").filter(Boolean);
	if (uncommitted.length > 0) {
		const shown = uncommitted.slice(0, 5).join("; ");
		lines.push(`未提交改动 ${uncommitted.length} 项：${shown}${uncommitted.length > 5 ? " …" : ""}`);
	}

	const merged = run("git", ["branch", "--merged", "main"]);
	const stale = (merged.stdout ?? "")
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s && s !== "main" && !s.startsWith("*") && !s.startsWith("remotes/"));
	if (stale.length > 0) {
		lines.push(`已合入 main 的残留分支：${stale.join(", ")}`);
	}

	const ls = run("git", ["ls-files"]);
	const big = (ls.stdout ?? "")
		.split("\n")
		.filter(Boolean)
		.map((f) => {
			try {
				return { f, size: statSync(join(ROOT, f)).size };
			} catch {
				return null;
			}
		})
		.filter((x) => x && x.size > MAX_FILE_BYTES)
		.map((x) => `${x.f} (${(x.size / 1024 / 1024).toFixed(1)}MB)`);
	if (big.length > 0) {
		const shown = big.slice(0, 5).join(", ");
		lines.push(`超大文件（>${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)}MB，可 HEALTH_MAX_FILE_BYTES 调）：${shown}${big.length > 5 ? " …" : ""}`);
	}

	if (lines.length === 0) {
		report("hygiene", true, "卫生：未提交改动 0 / 残留分支 0 / 超大文件 0");
	} else {
		report("hygiene", false, ...lines);
	}
}

checkAudit();
checkGitleaks();
checkHygiene();

for (const r of results) {
	for (const line of r.lines) {
		console.log(`[health][${r.check}] ${line}`);
	}
}

const failed = results.filter((r) => !r.ok);
if (failed.length === 0) {
	console.log(`[health][summary] ${results.length}/${results.length} 通过`);
	process.exit(0);
} else {
	console.log(`[health][summary] ${results.length - failed.length}/${results.length} 通过；失败项：${failed.map((r) => r.check).join(", ")}`);
	process.exit(1);
}
