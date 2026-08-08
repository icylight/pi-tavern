/**
 * #145 docs-first 迁移：翻译器单测（客户端交付物，#145 验收项③）。
 *
 * 覆盖：toTypeBox 全部类型构造（object/string/integer(minimum)/number/
 * boolean/null/array/anyOf/enum/const/$ref/patternProperties/description/
 * required-Optional）+ 拓扑排序。等价性（生成产物 vs 现状 messages.ts
 * stringify 逐字段）由 scripts/generate-schema.mjs 产出后验证（迁移验收
 * 时一次性跑，不挂常驻门禁）。
 */
import { describe, expect, it } from "vitest";
// scripts/*.mjs 为生成工具（无 TS 声明文件）；vitest 运行时直接加载 ESM。
// @ts-expect-error — TS7016: 无声明文件的 .mjs 模块
import { collectRefs, topoSort, toTypeBox } from "../../../scripts/generate-schema.mjs";

describe("generate-schema 翻译器：类型构造覆盖", () => {
	it("object + additionalProperties:false + 必填/可选属性", () => {
		const schema = {
			type: "object",
			required: ["id"],
			properties: {
				id: { type: "string" },
				name: { type: "string" },
			},
			additionalProperties: false,
		};
		const code = toTypeBox(schema, {}, 0);
		expect(code).toContain('"id": Type.String()');
		expect(code).toContain('"name": Type.Optional(Type.String())');
		expect(code).toContain("additionalProperties: false");
	});

	it("integer 保真（minimum 约束不丢）", () => {
		expect(toTypeBox({ type: "integer", minimum: 0 }, {}, 0)).toBe("Type.Integer({ minimum: 0 })");
		expect(toTypeBox({ type: "integer" }, {}, 0)).toBe("Type.Integer()");
	});

	it("string/number/boolean/null 基本类型", () => {
		expect(toTypeBox({ type: "string" }, {}, 0)).toBe("Type.String()");
		expect(toTypeBox({ type: "number" }, {}, 0)).toBe("Type.Number()");
		expect(toTypeBox({ type: "boolean" }, {}, 0)).toBe("Type.Boolean()");
		expect(toTypeBox({ type: "null" }, {}, 0)).toBe("Type.Null()");
	});

	it("array + items", () => {
		expect(toTypeBox({ type: "array", items: { type: "string" } }, {}, 0)).toBe("Type.Array(Type.String())");
	});

	it("anyOf → Type.Union", () => {
		const code = toTypeBox({ anyOf: [{ type: "string" }, { type: "integer" }] }, {}, 0);
		expect(code).toBe("Type.Union([Type.String(), Type.Integer()])");
	});

	it("enum → Union of Literal（数字值保真）", () => {
		const code = toTypeBox({ enum: [-32100, -32101, 0] }, {}, 0);
		expect(code).toBe("Type.Union([Type.Literal(-32100), Type.Literal(-32101), Type.Literal(0)])");
	});

	it("const → Type.Literal", () => {
		expect(toTypeBox({ type: "string", const: "2.0" }, {}, 0)).toBe('Type.Literal("2.0")');
	});

	it("$ref → 同名 const 变量引用", () => {
		const code = toTypeBox({ $ref: "#/$defs/RequestId" }, { RequestId: {} }, 0);
		expect(code).toBe("RequestIdSchema");
	});

	it("未解析 $ref 报错", () => {
		expect(() => toTypeBox({ $ref: "#/$defs/Missing" }, {}, 0)).toThrow(/未解析的 \$ref/);
	});

	it("patternProperties → Type.Record（boards 形态）", () => {
		const schema = {
			type: "object",
			patternProperties: { "^.*$": { type: "array", items: { $ref: "#/$defs/BoardNote" } } },
		};
		const code = toTypeBox(schema, { BoardNote: {} }, 0);
		expect(code).toBe("Type.Record(Type.String(), Type.Array(BoardNoteSchema))");
	});

	it("description → 选项参数", () => {
		const code = toTypeBox({ type: "string", description: "会话 id" }, {}, 0);
		expect(code).toBe('Type.String({ description: "会话 id" })');
	});

	it("不支持 type 报错", () => {
		expect(() => toTypeBox({ type: "foo" }, {}, 0)).toThrow(/不支持的 type/);
	});
});

describe("generate-schema 翻译器：拓扑排序", () => {
	it("被引用者先声明（TDZ 防呆）", () => {
		const defs = {
			ClientMessage: { anyOf: [{ $ref: "#/$defs/RequestId" }] },
			RequestId: { anyOf: [{ type: "string" }, { type: "integer" }] },
			ServerMessage: { anyOf: [{ $ref: "#/$defs/ClientMessage" }] },
		};
		const order = topoSort(defs);
		expect(order.indexOf("RequestId")).toBeLessThan(order.indexOf("ClientMessage"));
		expect(order.indexOf("ClientMessage")).toBeLessThan(order.indexOf("ServerMessage"));
	});
});

describe("generate-schema 翻译器：$ref 收集", () => {
	it("收集子树全部 $ref 目标", () => {
		const node = {
			type: "object",
			properties: {
				a: { $ref: "#/$defs/X" },
				b: { type: "array", items: { $ref: "#/$defs/Y" } },
			},
		};
		const refs = collectRefs(node);
		expect(refs.has("X")).toBe(true);
		expect(refs.has("Y")).toBe(true);
	});
});
