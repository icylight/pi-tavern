/**
 * B0 先行契约测试：board-store（B2 交付物）纯函数行为契约。
 *
 * 本文件在 B0 落盘时 board-store.ts 尚未实现——属预期「红」：
 * 运行报模块不存在即契约先行留痕；B2 实现后按此契约转绿。
 *
 * 契约来源：issue #114（09:24 版）B2 约束①-⑧ + ADR-0007 §4。
 * 关键语义（data 层不依赖协议类型，B2 约束⑤）：
 * - write() 返回 outcome（applied / noop+告知码 / rejected+拒绝码），
 *   响应组装在 pipeline 层，由 outcome 映射为协议 reason_code（五码）
 * - 单写者串行化由调用方（WS 消息队列）保证，store 为同步 API
 * - 码点计数 = [...content].length（utf8mb4 同款，Array.from 语义）
 *
 * 期望 API（Dev 按此实现，允许内部重构但公开面须满足本契约）：
 *   createBoardStore(deps: BoardStoreDependencies): BoardStore
 *   BoardStore.write(groupId, sender, action, note?): BoardWriteOutcome
 *   BoardStore.read(groupId): Record<sender, BoardNote[]>
 *   BoardStore.deleteBoard(groupId): Promise<DeleteBoardResult>
 *   BoardWriteOutcome =
 *     { status:"applied", note?: {id,content} }                     // remove/clear 无 note
 *   | { status:"noop", code:"note_not_found"|"board_empty"|"note_unchanged" }
 *   | { status:"rejected", code:"max_notes_exceeded"|"note_length_exceeded" }
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBoardStore } from "../../../src/data/board-store.js";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-tavern-board-"));
	temporaryDirectories.push(directory);
	return directory;
}

function createStore(boardDir: string, overrides: Partial<Parameters<typeof createBoardStore>[0]> = {}) {
	return createBoardStore({ boardDir, ...overrides });
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("board-store（B0 契约先行）", () => {
	describe("读写往返与持久化", () => {
		it("set 新贴后 read 可见，且带 store 分配的稳定条 id", () => {
			const store = createStore(createTemporaryDirectory());
			const outcome = store.write("g1", "A", "set", { content: "第一条" });

			expect(outcome).toEqual({ status: "applied", note: { id: expect.any(String), content: "第一条" } });
			if (outcome.status !== "applied") throw new Error("unreachable");
			expect(store.read("g1")).toEqual({ A: [{ id: outcome.note?.id, content: "第一条" }] });
		});

		it("重启（同 boardDir 重建实例）后内容读回（关闭保留、供恢复）", () => {
			const dir = createTemporaryDirectory();
			const store1 = createStore(dir);
			store1.write("g1", "A", "set", { content: "持久化条目" });

			const store2 = createStore(dir);
			expect(store2.read("g1")).toEqual({ A: [{ id: expect.any(String), content: "持久化条目" }] });
		});

		it("多次 set 的条 id 不重复，且重启后新 id 不与旧 id 重复", () => {
			const dir = createTemporaryDirectory();
			const store1 = createStore(dir);
			const a = store1.write("g1", "A", "set", { content: "x" });
			const b = store1.write("g1", "A", "set", { content: "y" });
			if (a.status !== "applied" || b.status !== "applied") throw new Error("unreachable");

			const store2 = createStore(dir);
			const c = store2.write("g1", "A", "set", { content: "z" });
			if (c.status !== "applied") throw new Error("unreachable");

			const ids = [a.note?.id, b.note?.id, c.note?.id];
			expect(new Set(ids).size).toBe(3);
		});

		it("每次写后无 .tmp 残留、文件为合法 JSON（原子写 tmp+rename）", () => {
			const dir = createTemporaryDirectory();
			const store = createStore(dir);
			store.write("g1", "A", "set", { content: "原子写" });
			store.write("g1", "A", "remove", { id: "nonexistent" }); // no-op 不落盘

			const file = join(dir, "g1.json");
			expect(JSON.parse(readFileSync(file, "utf8"))).toBeTruthy();
			expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
		});
	});

	describe("5 条上限（码点）", () => {
		it("第 6 条被拒：rejected max_notes_exceeded", () => {
			const store = createStore(createTemporaryDirectory());
			for (let i = 0; i < 5; i++) {
				expect(store.write("g1", "A", "set", { content: `条${i}` }).status).toBe("applied");
			}
			expect(store.write("g1", "A", "set", { content: "第六条" })).toEqual({
				status: "rejected",
				code: "max_notes_exceeded",
			});
		});

		it("edit 不新增条数：满 5 条后 edit 成功", () => {
			const store = createStore(createTemporaryDirectory());
			let id = "";
			for (let i = 0; i < 5; i++) {
				const o = store.write("g1", "A", "set", { content: `条${i}` });
				if (o.status === "applied" && o.note) id = o.note.id;
			}
			expect(store.write("g1", "A", "set", { id, content: "修改后" })).toEqual({
				status: "applied",
				note: { id, content: "修改后" },
			});
		});
	});

	describe("单条长度上限（140 码点，utf8mb4 同款）", () => {
		it("140 码点通过、141 码点被拒（note_length_exceeded）", () => {
			const store = createStore(createTemporaryDirectory());
			expect(store.write("g1", "A", "set", { content: "汉".repeat(140) }).status).toBe("applied");
			expect(store.write("g1", "A", "set", { content: "汉".repeat(141) })).toEqual({
				status: "rejected",
				code: "note_length_exceeded",
			});
		});

		it("emoji 按码点计：140 emoji（280 UTF-16 units）通过、141 被拒", () => {
			const store = createStore(createTemporaryDirectory());
			expect(store.write("g1", "A", "set", { content: "👍".repeat(140) }).status).toBe("applied");
			expect(store.write("g1", "A", "set", { content: "👍".repeat(141) })).toEqual({
				status: "rejected",
				code: "note_length_exceeded",
			});
		});

		it("ZWJ 序列按码点计：👨👩👧 = 7 码点（20 组 = 140 通过、21 组被拒）", () => {
			const store = createStore(createTemporaryDirectory());
			const family = "👨\u200d👩\u200d👧";
			expect([...family].length).toBe(7);
			expect(store.write("g1", "A", "set", { content: family.repeat(20) }).status).toBe("applied");
			expect(store.write("g1", "A", "set", { content: family.repeat(21) })).toEqual({
				status: "rejected",
				code: "note_length_exceeded",
			});
		});

		it("组合字符按码点计：é（e + U+0301）= 2 码点", () => {
			const store = createStore(createTemporaryDirectory());
			const composed = "e\u0301";
			expect([...composed].length).toBe(2);
			expect(store.write("g1", "A", "set", { content: composed.repeat(70) }).status).toBe("applied");
			expect(store.write("g1", "A", "set", { content: composed.repeat(71) })).toEqual({
				status: "rejected",
				code: "note_length_exceeded",
			});
		});

		it("edit 超长被拒且原条内容不变", () => {
			const store = createStore(createTemporaryDirectory());
			const o = store.write("g1", "A", "set", { content: "原内容" });
			if (o.status !== "applied" || !o.note) throw new Error("unreachable");

			expect(store.write("g1", "A", "set", { id: o.note.id, content: "汉".repeat(141) })).toEqual({
				status: "rejected",
				code: "note_length_exceeded",
			});
			expect(store.read("g1")).toEqual({ A: [{ id: o.note.id, content: "原内容" }] });
		});
	});

	describe("edit 与变化定义", () => {
		it("update 同内容 = noop note_unchanged", () => {
			const store = createStore(createTemporaryDirectory());
			const o = store.write("g1", "A", "set", { content: "一样" });
			if (o.status !== "applied" || !o.note) throw new Error("unreachable");

			expect(store.write("g1", "A", "set", { id: o.note.id, content: "一样" })).toEqual({
				status: "noop",
				code: "note_unchanged",
			});
		});

		it("update 不带 content = noop note_unchanged（无变化）", () => {
			const store = createStore(createTemporaryDirectory());
			const o = store.write("g1", "A", "set", { content: "内容" });
			if (o.status !== "applied" || !o.note) throw new Error("unreachable");

			expect(store.write("g1", "A", "set", { id: o.note.id })).toEqual({
				status: "noop",
				code: "note_unchanged",
			});
		});

		it("edit 不存在 id = noop note_not_found", () => {
			const store = createStore(createTemporaryDirectory());
			expect(store.write("g1", "A", "set", { id: "ghost", content: "幽灵" })).toEqual({
				status: "noop",
				code: "note_not_found",
			});
		});
	});

	describe("remove / clear", () => {
		it("remove 存在条 = applied，条消失", () => {
			const store = createStore(createTemporaryDirectory());
			const o = store.write("g1", "A", "set", { content: "要撕的" });
			if (o.status !== "applied" || !o.note) throw new Error("unreachable");

			expect(store.write("g1", "A", "remove", { id: o.note.id })).toEqual({ status: "applied" });
			expect(store.read("g1")).toEqual({ A: [] });
		});

		it("remove 不存在 id = noop note_not_found", () => {
			const store = createStore(createTemporaryDirectory());
			store.write("g1", "A", "set", { content: "在的" });
			expect(store.write("g1", "A", "remove", { id: "ghost" })).toEqual({
				status: "noop",
				code: "note_not_found",
			});
			expect(store.read("g1")).toEqual({ A: [{ id: expect.any(String), content: "在的" }] });
		});

		it("clear 非空板 = applied；clear 空板 = noop board_empty", () => {
			const store = createStore(createTemporaryDirectory());
			expect(store.write("g1", "A", "clear")).toEqual({ status: "noop", code: "board_empty" });

			store.write("g1", "A", "set", { content: "清掉" });
			expect(store.write("g1", "A", "clear")).toEqual({ status: "applied" });
			expect(store.read("g1")).toEqual({ A: [] });
		});
	});

	describe("actor 隔离（按 sender）", () => {
		it("A 用 B 的条 id = noop note_not_found，A/B 板均不变", () => {
			const store = createStore(createTemporaryDirectory());
			const a = store.write("g1", "A", "set", { content: "A 的" });
			const b = store.write("g1", "B", "set", { content: "B 的" });
			if (a.status !== "applied" || !a.note || b.status !== "applied" || !b.note) throw new Error("unreachable");

			expect(store.write("g1", "A", "remove", { id: b.note.id })).toEqual({
				status: "noop",
				code: "note_not_found",
			});
			expect(store.read("g1")).toEqual({
				A: [{ id: a.note.id, content: "A 的" }],
				B: [{ id: b.note.id, content: "B 的" }],
			});
		});
	});

	describe("跨群聊隔离", () => {
		it("不同 groupId 的板互不干扰、文件分离", () => {
			const dir = createTemporaryDirectory();
			const store = createStore(dir);
			store.write("g1", "A", "set", { content: "群 1" });
			store.write("g2", "B", "set", { content: "群 2" });

			expect(store.read("g1")).toEqual({ A: [{ id: expect.any(String), content: "群 1" }] });
			expect(store.read("g2")).toEqual({ B: [{ id: expect.any(String), content: "群 2" }] });

			const store2 = createStore(dir);
			expect(store2.read("g1")).toEqual({ A: [{ id: expect.any(String), content: "群 1" }] });
			expect(store2.read("g2")).toEqual({ B: [{ id: expect.any(String), content: "群 2" }] });
		});
	});

	describe("生命周期：deleteBoard", () => {
		it("trash 优先：trash 成功则文件入 trash；失败回退 unlink", async () => {
			const dir = createTemporaryDirectory();
			const trashed: string[] = [];
			const unlinked: string[] = [];
			const store = createStore(dir, {
				trash: (path) => {
					trashed.push(path);
					return { status: 0 };
				},
				unlink: (path) => {
					unlinked.push(path);
				},
			});
			store.write("g1", "A", "set", { content: "要删的" });

			const result = await store.deleteBoard("g1");
			expect(result).toEqual({ ok: true, method: "trash" });
			expect(trashed).toHaveLength(1);
			expect(unlinked).toHaveLength(0);
		});

		it("trash 失败回退 unlink", async () => {
			const dir = createTemporaryDirectory();
			const store = createStore(dir, {
				trash: () => ({ status: 1, error: { message: "trash not found" } }),
				unlink: () => {},
			});
			store.write("g1", "A", "set", { content: "要删的" });

			const result = await store.deleteBoard("g1");
			expect(result).toEqual({ ok: true, method: "unlink" });
		});

		it("幂等：删两次 / 删不存在的板均 ok", async () => {
			const store = createStore(createTemporaryDirectory());
			store.write("g1", "A", "set", { content: "x" });

			expect(await store.deleteBoard("g1")).toEqual({ ok: true, method: expect.any(String) });
			expect(await store.deleteBoard("g1")).toEqual({ ok: true, method: expect.any(String) });
			expect(await store.deleteBoard("g-ghost")).toEqual({ ok: true, method: expect.any(String) });
		});

		it("删除后 read = 空；再写 = 新板（旧内容无复活路径）", async () => {
			const dir = createTemporaryDirectory();
			const store = createStore(dir, {
				trash: () => ({ status: 1, error: { message: "no trash" } }),
				unlink: () => {},
			});
			store.write("g1", "A", "set", { content: "旧内容" });

			await store.deleteBoard("g1");
			expect(store.read("g1")).toEqual({});

			store.write("g1", "A", "set", { content: "新内容" });
			expect(store.read("g1")).toEqual({ A: [{ id: expect.any(String), content: "新内容" }] });

			// 重建实例（模拟重启）：不得复活旧内容
			const store2 = createStore(dir, {
				trash: () => ({ status: 1, error: { message: "no trash" } }),
				unlink: () => {},
			});
			expect(store2.read("g1")).toEqual({ A: [{ id: expect.any(String), content: "新内容" }] });
		});
	});

	describe("坏文件降级", () => {
		it("boards 文件损坏 = 降级空板 + 警告，不抛错", () => {
			const dir = createTemporaryDirectory();
			const warnings: string[] = [];
			const store = createStore(dir, { warn: (message) => warnings.push(message) });

			writeFileSync(join(dir, "g1.json"), "{ 不是合法 JSON", "utf8");
			expect(store.read("g1")).toEqual({});
			expect(warnings).toHaveLength(1);

			// 写路径仍可用：降级后重写覆盖坏文件
			expect(store.write("g1", "A", "set", { content: "恢复" }).status).toBe("applied");
			expect(store.read("g1")).toEqual({ A: [{ id: expect.any(String), content: "恢复" }] });
		});
	});
});
