#!/usr/bin/env node
/**
 * 层间依赖方向 lint（Phase 4：五层依赖矩阵）。
 *
 * 背景：biome noRestrictedImports patterns 无「源文件」维度（实测证伪，
 * refactor-plan 留痕），故用零依赖 node 脚本按「源文件路径前缀 × import
 * specifier」检查。规则矩阵（Arch 2026-08-02 裁决）：
 *   1. adapter（index/commands/headless/extension/ui）不得触 skills 行为面
 *      （data/ 纯函数与类型导入豁免；行为默认实现由组合根 index.ts 装配注入）
 *   2. application（controller/）不得直接碰文件 IO（node:fs）
 *   3. runtime 域（creator-runtime）不得直连 node:fs（经 deps 注入；
 *      creator-factory 默认依赖装配豁免 = 组合根语义）
 *
 * 豁免采用「白名单文件 + 正则」两维：行内豁免（// lint-layers:ignore）或
 * 文件级白名单（见 LAYER_RULES 的 allowFiles）。运行：npm run lint:layers
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

/**
 * 规则表：每条 = { name, sources: [glob 源文件前缀], forbid: [regex 禁 import specifier], allowFiles: [相对 src/ 的豁免文件] }
 * sources 匹配相对 src/ 的文件路径前缀（目录或文件）；forbid 为正则（书写形 specifier）。
 */
const LAYER_RULES = [
	{
		// index.ts = 组合根（装配职责，可消费 skills 行为面——Arch 裁决 ①）
		name: "adapter 不得触 skills 行为面（data/ 除纯函数/类型；组合根豁免）",
		sources: ["commands.ts", "headless.ts", "extension/", "ui/"],
		forbid: [
			/(\.\.\/)*data\/(discovery\/discover-group-chats|cursor-store|group-chat-sessions|session-store|resume-projection)\.js/,
		],
			// 纯路径函数/类型导入豁免：active-descriptor 的 getGroupChatCursorDirectory
		// 等路径原语允许 adapter 消费（Arch 裁决 ①）；行为面默认实现已上移组合根。
		// 行为导出（publish/update/remove/read）禁止（Arch 加固 ③）——见 ACTIVE_DESCRIPTOR_BEHAVIORS。
		allowFiles: [],
	},
	{
		name: "application 不得直接碰文件 IO（node:fs）",
		sources: ["controller/", "creator/creator-pipelines/"],
		forbid: [/node:fs/],
		// dispatch.ts = runtime 域桥接文件（creator-pipelines/ 目录内、runtime 域管辖，
		// Arch 已知项：目录归属与域不一致，现行为无害，迁移挂起——桥接地位声明于此）。
		allowFiles: ["creator/creator-pipelines/dispatch.ts"],
	},
	{
		// Phase 3 拆出的 10 模块全集（文件集已稳定，枚举补全防漂移——Arch 加固 ②）
		name: "runtime 域不得直连 node:fs（经 deps 注入；factory/组合根豁免）",
		sources: [
			"creator/creator-runtime.ts",
			"creator/heartbeat-registry.ts",
			"creator/broadcast-hub.ts",
			"creator/connection-manager.ts",
			"creator/member-bookkeeping.ts",
			"creator/reload-flow.ts",
			"creator/runtime-lifecycle.ts",
			"creator/pipeline-assembly.ts",
			"creator/runtime-facades.ts",
			"creator/ws-utils.ts",
			"creator/creator-pipelines/dispatch.ts",
			"character/character-runtime.ts",
			"character/join-attempt.ts",
			"character/group-chat-input.ts",
		],
		forbid: [/node:fs/],
		allowFiles: ["creator/creator-factory.ts"],
	},
];

function collectTsFiles(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			collectTsFiles(full, out);
		} else if (entry.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

function matchesAny(sourcePath, prefixes) {
	return prefixes.some((prefix) => sourcePath === prefix || sourcePath.startsWith(prefix));
}

// active-descriptor 行为导出（纯路径函数豁免的边界，Arch 加固 ③）。
const ACTIVE_DESCRIPTOR_BEHAVIORS = /(publishActiveDescriptor|updateActiveDescriptorName|removeOwnedActiveDescriptor|readActiveDescriptor)/;

let violations = 0;
const files = collectTsFiles(SRC);

for (const rule of LAYER_RULES) {
	for (const file of files) {
		const rel = relative(SRC, file).replaceAll("\\", "/");
		if (!matchesAny(rel, rule.sources)) {
			continue;
		}
		if (rule.allowFiles.includes(rel)) {
			continue;
		}
		const content = readFileSync(file, "utf8");
		// 按 import 块解析（多行 import 的 from 行不以 import 开头，须整块收集）。
		for (const block of content.matchAll(/import[^;]*;|import\s*\([^)]*\)\s*from\s*"[^"]*";/gs)) {
			const statement = block[0];
			if (statement.includes("lint-layers:ignore")) {
				continue;
			}
			// type-only 导入（类型豁免）不触发行为面规则。
			const typeOnly = /^\s*import\s+type\b/.test(statement);
			if (typeOnly) {
				continue;
			}
			for (const pattern of rule.forbid) {
				if (pattern.test(statement)) {
					violations += 1;
					console.error(`[lint-layers] ${rule.name}\n  ${relative(SRC, file)}: ${statement.replace(/\s+/g, " ").slice(0, 120)}`);
				}
			}
			// 加固 ③：adapter 消费 active-descriptor 时，具名导入不得含行为导出。
			if (
				rule.name.startsWith("adapter") &&
				statement.includes("active-descriptor") &&
				ACTIVE_DESCRIPTOR_BEHAVIORS.test(statement)
			) {
				violations += 1;
				console.error(
					`[lint-layers] adapter 不得触 active-descriptor 行为导出\n  ${relative(SRC, file)}: ${statement.replace(/\s+/g, " ").slice(0, 120)}`,
				);
			}
		}
	}
}

if (violations > 0) {
	console.error(`\n[lint-layers] ${violations} violation(s). Fix by moving behavior defaults to the composition root (index.ts) or add an explicit exemption.`);
	process.exit(1);
}
console.log("[lint-layers] OK — layer direction rules hold.");
