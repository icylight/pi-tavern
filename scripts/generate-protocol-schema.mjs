#!/usr/bin/env node
/**
 * #145 协议 schema 生成脚本（后端属主）：
 * 遍历 src/protocol/messages.ts 导出的 TypeBox Schema（单一事实源）→
 * 输出为独立 JSON Schema 文件到 docs/protocol/schema/（或 --out 指定目录）。
 *
 * 单一事实源：产物 = JSON.stringify(TypeBox 内存对象)，与 codec.ts 的
 * Compile(ClientMessageSchema/ServerMessageSchema) 同源——Type.Object 产物
 * 自带 type/required/additionalProperties，无需额外转换，无漂移通道。
 *
 * 覆盖式生成语义（苍蓝星拍板 #145）：产物 = 代码当前状态的精确投影——
 * 每次运行先清理目标目录中不再由代码导出的陈旧产物，再逐 Schema 覆盖写
 * 入；不做任何比较/判空（docs:check 机制已随拍板取消）。协议代码变更时
 * 运行本命令并同步提交产物。
 *
 * 加载方式：项目使用 NodeNext .js 后缀导入 + Node 原生 TS 无法改写
 * 相对说明符（.js → .ts），故先用 tsc 把 schema 模块图编译到缓存目录，
 * 再以 ESM 导入（零新增依赖，复用既有 TypeScript 工具链）。
 *
 * 用法：
 *   node scripts/generate-protocol-schema.mjs            # → docs/protocol/schema/
 *   node scripts/generate-protocol-schema.mjs --out /tmp/x  # → /tmp/x（docs:check 用）
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");

function parseArgs(argv) {
	const out = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--out") {
			out.push(argv[i + 1]);
			i++;
		} else {
			out.push(argv[i]);
		}
	}
	return out;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const outDir = args.length > 0 ? resolve(args[0]) : join(ROOT, "docs", "protocol", "schema");

	// 1. 用 tsc 编译 schema 模块图到缓存目录（NodeNext 语义与项目一致）。
	// 缓存放 node_modules/.cache 下：node_modules 解析链可达 + git 忽略无噪声。
	mkdirSync(join(ROOT, "node_modules", ".cache"), { recursive: true });
	const cacheDir = mkdtempSync(join(ROOT, "node_modules", ".cache", "schema-gen-"));
	try {
		const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
		execFileSync(
			process.execPath,
			[tsc, "-p", join(SCRIPT_DIR, "tsconfig.schema-gen.json"), "--outDir", cacheDir],
			{ cwd: ROOT, stdio: "inherit" },
		);

		// 2. 导入编译产物，提取全部导出 Schema。
		const entry = join(cacheDir, "protocol", "messages.js");
		const mod = await import(pathToFileURL(entry).href);
		const schemaNames = Object.keys(mod)
			.filter((key) => key.endsWith("Schema"))
			.sort();

		// 3. 逐 Schema 输出 JSON 文件（2 空格缩进 + 尾换行，git diff 友好）。
		mkdirSync(outDir, { recursive: true });
		// 覆盖式生成：先清理目标目录中不再由代码导出的陈旧 JSON（删除/重命名
		// 导出后不留残影——产物集合恒为代码当前导出集的精确投影）。
		const wanted = new Set(schemaNames.map((name) => `${name.replace(/Schema$/, "")}.json`));
		for (const existing of readdirSync(outDir).filter((file) => file.endsWith(".json"))) {
			if (!wanted.has(existing)) {
				rmSync(join(outDir, existing), { force: true });
			}
		}
		const written = [];
		for (const name of schemaNames) {
			const target = join(outDir, `${name.replace(/Schema$/, "")}.json`);
			writeFileSync(target, `${JSON.stringify(mod[name], null, 2)}\n`);
			written.push(relative(ROOT, target));
		}

		console.log(`[generate-protocol-schema] ${written.length} schemas → ${relative(ROOT, outDir)}`);
		for (const file of written) {
			console.log(`  ${file}`);
		}
	} finally {
		rmSync(cacheDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(`[generate-protocol-schema] failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
