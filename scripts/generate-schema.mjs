#!/usr/bin/env node
/**
 * #145 docs-first 迁移：从协议定义文件（src/protocol/schema/*.jsonc，唯一
 * 手写源头）生成程序用的 TypeBox schema 代码（客户端属主）。
 *
 * 流水线：tsc 编译 src/protocol 模块图到临时缓存（NodeNext 语义一致，零新增
 * 依赖，同 generate-protocol-schema 先例）→ import schema-merge 的
 * loadProtocolDefs（后端属主合并加载器，与 codec 运行时同一实现）→ 自写
 * 翻译器：JSON Schema 对象 → TypeBox 表达式文本（拓扑排序保证被引用者先
 * 声明）→ 覆盖写 src/protocol/generated/schema.ts。
 *
 * 产物约定（与后端衔接）：全量 *Schema const（与 jsonc $defs 键名同名同构，
 * 含 ClientMessageSchema/ServerMessageSchema 入口）；messages.ts 改为
 * re-export + 类型保留（Static 零改动）→ codec 零改动。
 *
 * 覆盖类型构造：object / string / integer / number / boolean / null /
 * array / anyOf(union) / enum / const(literal) / $ref 局部引用 /
 * patternProperties(Record) / description / required(Optional)。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");

const OUT_FILE = resolve(ROOT, "src/protocol/generated/schema.ts");
const HEADER = `// 由 scripts/generate-schema.mjs 生成（docs-first：#145）——请勿手改。
// 权威源 = src/protocol/schema/*.jsonc（4 个协议定义文件，唯一手写处）。
import { Type } from "typebox";
`;

/** JSON Schema 约束键 → TypeBox 选项（minimum 等，保真必需）。 */
const CONSTRAINT_KEYS = [
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"pattern",
];

function constraintOptions(schema) {
	const opts = [];
	for (const key of CONSTRAINT_KEYS) {
		if (schema[key] !== undefined) {
			opts.push(`${key}: ${JSON.stringify(schema[key])}`);
		}
	}
	return opts;
}

/** JSON Schema 值 → TypeBox 表达式文本。schema = jsonc $defs 内定义（或子树）。 */
function toTypeBox(schema, defs, indent) {
	const pad = "\t".repeat(indent);
	if (schema === null || typeof schema !== "object") {
		throw new Error(`[generate-schema] 非法 schema 节点: ${JSON.stringify(schema)}`);
	}
	// $ref 局部引用 → 同名 const 变量引用（拓扑排序保证先声明）。
	if (typeof schema.$ref === "string") {
		const name = schema.$ref.replace(/^#\/\$defs\//, "");
		if (!(name in defs)) {
			throw new Error(`[generate-schema] 未解析的 $ref: ${schema.$ref}`);
		}
		return `${name}Schema`;
	}
	// patternProperties 且无 properties → Type.Record（boards 等 map 形态）。
	if (!schema.properties && schema.patternProperties) {
		const keys = Object.keys(schema.patternProperties);
		if (keys.length !== 1) {
			throw new Error(`[generate-schema] 仅支持单键 patternProperties: ${keys.join(",")}`);
		}
		return `Type.Record(Type.String(), ${toTypeBox(schema.patternProperties[keys[0]], defs, indent)})`;
	}
/** 收集 TypeBox 选项：约束键 + description。 */
function collectOptions(schema) {
	const opts = [...constraintOptions(schema)];
	if (schema.description !== undefined) {
		opts.push(`description: ${JSON.stringify(schema.description)}`);
	}
	return opts;
}

function withOptions(expr, opts) {
	return opts.length > 0 ? `${expr}({ ${opts.join(", ")} })` : `${expr}()`;
}
	// 无 type 的联合/枚举/常量（anyOf/enum/const 形态）。
	if (schema.anyOf !== undefined) {
		return `Type.Union([${schema.anyOf.map((s) => toTypeBox(s, defs, indent + 1)).join(", ")}])`;
	}
	if (schema.enum !== undefined) {
		return `Type.Union([${schema.enum.map((v) => `Type.Literal(${JSON.stringify(v)})`).join(", ")}])`;
	}
	if (schema.const !== undefined) {
		return `Type.Literal(${JSON.stringify(schema.const)})`;
	}
	switch (schema.type) {
		case "object": {
			const props = Object.entries(schema.properties ?? {}).map(([key, value]) => {
				const required = Array.isArray(schema.required) && schema.required.includes(key);
				const expr = toTypeBox(value, defs, indent + 1);
				return `${JSON.stringify(key)}: ${required ? expr : `Type.Optional(${expr})`}`;
			});
			const opts = [];
			if (schema.additionalProperties === false) {
				opts.push("additionalProperties: false");
			}
			if (schema.description !== undefined) {
				opts.push(`description: ${JSON.stringify(schema.description)}`);
			}
			const body = props.length > 0 ? `{\n${pad}\t\t${props.join(`,\n${pad}\t\t`)},\n${pad}\t}` : "{}";
			return `Type.Object(${body}${opts.length > 0 ? `, { ${opts.join(", ")} }` : ""})`;
		}
		case "string":
			return withOptions("Type.String", collectOptions(schema));
		case "integer":
			return withOptions("Type.Integer", collectOptions(schema));
		case "number":
			return withOptions("Type.Number", collectOptions(schema));
		case "boolean":
			return withOptions("Type.Boolean", collectOptions(schema));
		case "null":
			return withOptions("Type.Null", collectOptions(schema));
		case "array": {
			const items = schema.items ?? { anyOf: [] };
			return `Type.Array(${toTypeBox(items, defs, indent + 1)})`;
		}
		default:
			throw new Error(`[generate-schema] 不支持的 type: ${JSON.stringify(schema.type)}`);
	}
}

/** $defs 依赖拓扑排序（被引用者先声明，避免 const TDZ）。 */
function topoSort(defs) {
	const order = [];
	const visited = new Set();
	const visit = (name) => {
		if (visited.has(name)) {
			return;
		}
		visited.add(name);
		for (const ref of collectRefs(defs[name])) {
			if (ref in defs) {
				visit(ref);
			}
		}
		order.push(name);
	};
	for (const name of Object.keys(defs)) {
		visit(name);
	}
	return order;
}

/** 收集一个 schema 子树内全部 $ref 目标名。 */
function collectRefs(node, out = new Set()) {
	if (node === null || typeof node !== "object") {
		return out;
	}
	if (typeof node.$ref === "string") {
		const name = node.$ref.replace(/^#\/\$defs\//, "");
		if (name) {
			out.add(name);
		}
	}
	for (const value of Object.values(node)) {
		if (value !== null && typeof value === "object") {
			collectRefs(value, out);
		}
	}
	return out;
}

async function main() {
	// 1. tsc 编译 src/protocol 模块图到临时缓存（NodeNext 语义与项目一致）。
	mkdirSync(join(ROOT, "node_modules", ".cache"), { recursive: true });
	const cacheDir = mkdtempSync(join(ROOT, "node_modules", ".cache", "schema-gen-"));
	try {
		const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
		execFileSync(
			process.execPath,
			[tsc, "-p", join(SCRIPT_DIR, "tsconfig.schema-gen.json"), "--outDir", cacheDir],
			{ cwd: ROOT, stdio: "inherit" },
		);

		// 2. import 后端合并加载器（同一实现：jsonc-parser 解析 + $defs 合并）。
		const mergeModule = await import(pathToFileURL(join(cacheDir, "protocol", "schema-merge.js")).href);
		const defs = mergeModule.loadProtocolDefs();

		// 3. 拓扑排序 + 翻译。
		const order = topoSort(defs);
		const blocks = order.map((name) => {
			const expr = toTypeBox(defs[name], defs, 0);
			return `export const ${name}Schema = ${expr};\n`;
		});

		// 4. 覆盖写产物 + biome 格式化（产物须过 check 门禁）。
		mkdirSync(dirname(OUT_FILE), { recursive: true });
		writeFileSync(OUT_FILE, `${HEADER}${blocks.join("\n")}`);
		execFileSync(process.execPath, [join(ROOT, "node_modules", "@biomejs", "biome", "bin", "biome"), "check", "--write", OUT_FILE], {
			cwd: ROOT,
			stdio: "inherit",
		});
		process.stderr.write(`[generate-schema] wrote ${OUT_FILE} (${order.length} defs)\n`);
	} finally {
		rmSync(cacheDir, { recursive: true, force: true });
	}
}

// 条件执行：作为脚本直接运行时生成产物；被测试 import 时仅导出纯函数。
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	main().catch((error) => {
		process.stderr.write(`[generate-schema] failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}

export { toTypeBox, topoSort, collectRefs, constraintOptions };
