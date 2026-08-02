#!/usr/bin/env node
/**
 * 测试执行门卫（Phase 4 提速机制，User 指示：默认不跑用例，必须显式指定）。
 *
 * 语义（Arch 裁定）：
 *   - 无 pattern 调用 → 拒绝（exit 1，提示语明示「这是拒绝不是失败」）——防假绿
 *   - 带 pattern → 透传 vitest（原生位置参数过滤，只跑改动到的）
 *   - 层内全量 = --all（日常复核）；三层收口全量 = npm run test:full（验收证据）
 *   - CI/门禁永不调用裸 test:unit（CI 只用显式 pattern 或 test:full）
 *
 * 用法：
 *   npm run test:unit -- commands.test.ts
 *   npm run test:unit -- test/unit/creator
 *   npm run test:unit -- --all
 *   npm run test:full
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const LAYERS = {
	unit: { config: undefined, desc: "unit（18 文件，Dev 日常）" },
	integration: { config: "vitest.integration.config.ts", desc: "integration（QA 车道）" },
	acceptance: { config: "vitest.acceptance.config.ts", desc: "acceptance（QA 车道，PITAVERN_TEST=1）" },
};

const layer = process.argv[2];
const spec = LAYERS[layer];
if (!spec) {
	console.error(`[run-tests] unknown layer: ${layer ?? "(none)"}`);
	console.error(`[run-tests] usage: npm run test:<layer> -- <pattern|--all>`);
	process.exit(2);
}

const args = process.argv.slice(3);
if (args.length === 0) {
	// 拒绝而非失败：机制目的 = 强制显式指定（Arch 裁定 exit 1）。
	console.error("");
	console.error(`[run-tests] 拒绝执行：${layer} 层未指定用例（这是拒绝不是失败）。`);
	console.error(`[run-tests] ${spec.desc}；全量 ${layer} = ${args.length} 用例（文件粒度）。`);
	console.error("");
	console.error("  显式指定（只跑改动到的）:");
	console.error(`    npm run test:${layer} -- <文件或目录>      例：npm run test:${layer} -- commands.test.ts`);
	console.error(`    npm run test:${layer} -- <vitest flag>    例：npm run test:${layer} -- --reporter=dot`);
	console.error("  层内全量（日常复核）:");
	console.error(`    npm run test:${layer} -- --all`);
	console.error("  三层收口全量（验收证据）:");
	console.error("    npm run test:full");
	console.error("");
	process.exit(1);
}

const all = args.includes("--all");
const vitestArgs = ["--run"];
if (spec.config) {
	vitestArgs.push("--config", spec.config);
}
if (all) {
	// --all = 层内全量：不传位置参数即全量。
} else {
	vitestArgs.push(...args.filter((a) => a !== "--all"));
}
if (layer === "acceptance") {
	process.env.PITAVERN_TEST = "1";
}

const result = spawnSync("npx", ["vitest", ...vitestArgs], { stdio: "inherit", cwd: resolve(import.meta.dirname, "..") });
process.exit(result.status ?? 1);
