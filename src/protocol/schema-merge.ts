/**
 * 协议 schema 合并加载器（后端属主，docs-first 迁移 #145）：
 * 读 src/protocol/schema/*.jsonc（唯一手写源头）→ 解析（jsonc-parser）→
 * 合并单一 $defs 树 → 返回 client/server 两个入口 schema 对象。
 *
 * 消费方：
 * - 生成流水线（scripts/ 下）：从合并结果生成程序用的 schema 代码/类型；
 * - 运行时 codec（经生成产物）：Compile({ $ref, $defs }) 编译期解析 $ref。
 *
 * 权威文件内仅使用 "#/$defs/X" 局部引用（无跨文件 URI ref）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ParseError, parse } from "jsonc-parser";

/**
 * 定位 src/protocol/schema/ 目录：从当前模块位置向上查找（兼容源码执行与
 * tsc 编译到 node_modules/.cache 的流水线执行两种形态）。
 */
function resolveSchemaDir(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let hop = 0; hop < 10; hop++) {
		const candidate = join(dir, "src", "protocol", "schema");
		if (existsSync(join(candidate, "common.jsonc"))) {
			return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	throw new Error(`[schema-merge] 找不到 src/protocol/schema/（自 ${fileURLToPath(import.meta.url)} 向上查找失败）`);
}

const SCHEMA_DIR = resolveSchemaDir();
const SCHEMA_FILES = ["common", "client", "server", "board"];

export interface ProtocolEntrySchema {
	$ref: string;
	$defs: Record<string, unknown>;
}

/** 解析全部 jsonc 文件并合并为单一 $defs 树（跨文件引用经合并后全部可解析）。 */
export function loadProtocolDefs(): Record<string, unknown> {
	const defs: Record<string, unknown> = {};
	for (const file of SCHEMA_FILES) {
		const text = readFileSync(join(SCHEMA_DIR, `${file}.jsonc`), "utf8");
		const errors: ParseError[] = [];
		const parsed = parse(text, errors, { allowTrailingComma: true });
		if (errors.length > 0 || parsed === undefined) {
			throw new Error(`[schema-merge] ${file}.jsonc 解析失败：${errors.map(String).join("; ")}`);
		}
		Object.assign(defs, parsed.$defs);
	}
	return defs;
}

/** client/server 两个入口 schema（各含完整 $defs，供 Compile / 生成器消费）。 */
export function mergeProtocolSchemas(): { client: ProtocolEntrySchema; server: ProtocolEntrySchema } {
	const defs = loadProtocolDefs();
	return {
		client: { $ref: "#/$defs/ClientMessage", $defs: defs },
		server: { $ref: "#/$defs/ServerMessage", $defs: defs },
	};
}
