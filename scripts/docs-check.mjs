#!/usr/bin/env node
/**
 * 文档漂移门禁（#145 D3/D5，Arch 属主）。
 *
 * 机制：重新生成全部文档产物（schema JSON + API 文档），然后对入库产物区域
 * （docs/protocol/schema）git diff --quiet 判空——
 *   - 无差异（exit 0）= 已提交产物与代码同步，门禁绿；
 *   - 有差异（exit 1）= 漂移（#144 P1-2 同类：手写文档未随 schema 变更），门禁红。
 *
 * 监督范围（PM 归口 2026-08-08）：仅 docs/protocol/schema/*.json 入库并受 diff
 * 判空约束；docs/api/（TypeDoc HTML）入 .gitignore——无 diff 基线，漂移由
 * docs:api 0 errors 约束（D1），docs:check 只验证其生成成功。
 *
 * 幂等前提（生成脚本必须保证）：
 *   - 输出确定性（无时间戳/绝对路径）；
 *   - 生成即当前代码的规范形态（schema 源 = codec 同源单一事实源）。
 *
 * 接线：#145 PM 定案 = 串行尾部纳入 npm run check（biome + tsc + docs:check）。
 *
 * 用法：
 *   npm run docs:check
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** 入库生成物区域（相对 ROOT）——docs:check 只监督这些路径。 */
const GENERATED_PATHS = ["docs/protocol/schema"];

function run(script, args, label) {
	const result = spawnSync("npm", ["run", script, ...args], {
		cwd: ROOT,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (result.status !== 0) {
		console.error(`[docs:check] ${label} 失败（exit ${result.status ?? "signal"}）——生成错误不是漂移，先修生成本身。`);
		process.exit(result.status ?? 1);
	}
}

// ① 重新生成（固定输出路径；生成脚本自身保证幂等确定性）。
run("docs:schema", [], "schema JSON 生成（scripts/generate-protocol-schema.mjs）");
run("docs:api", [], "TypeDoc API 生成（typedoc.json）");

// ② 判空：入库生成物区域与已提交版本 diff。非空 = 漂移。
const diff = spawnSync("git", ["diff", "--quiet", "--", ...GENERATED_PATHS], {
	cwd: ROOT,
	stdio: "pipe",
	encoding: "utf8",
});
if (diff.status === 0) {
	console.log(`[docs:check] 通过：${GENERATED_PATHS.join(" + ")} 与代码同步（无漂移）。`);
	process.exit(0);
}
if (diff.status === 1) {
	console.error(
		`[docs:check] 漂移检测失败：生成产物与已提交版本不一致。\n` +
			`运行 npm run docs:schema && npm run docs:api 后检查 git diff -- docs/protocol/schema docs/api，` +
			`把生成产物随代码同批提交（生成即规范形态，禁止手改产物）。`,
	);
	process.exit(1);
}
console.error(`[docs:check] git diff 执行异常（exit ${diff.status ?? "signal"}）。`);
process.exit(1);
