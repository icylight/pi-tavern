/**
 * B1 codec 契约测试：白板模型（#114）board_write / board_query / board_update 编解码。
 *
 * 契约来源：issue #114（09:24 版）B1 节 + ADR-0007 §3；#119 M1 信封迁移
 * （type → method + jsonrpc"2.0" + params 嵌套 + result/error 响应）。
 * 覆盖：客户端消息往返（三 action / query）；board_write 响应四态
 * （applied 带/不带 note、告知码、拒绝码）；board_query 响应；board_update 通知
 * （action 四值、无 sequence）；严格校验（额外字段/未知类型拒绝）。
 * 码点计数校验在 pipeline/store 层（B2/B3），本文件不覆盖。
 */
import { describe, expect, it } from "vitest";

import { decodeClientMessage, decodeServerMessage, encodeMessage } from "../../../src/protocol/codec.js";

/** encodeMessage 返回字符串；decode 侧 RawData 需 Buffer（与 codec.test.ts 同法）。 */
const decodeClient = (wire: string) => decodeClientMessage(Buffer.from(wire));
const decodeServer = (wire: string) => decodeServerMessage(Buffer.from(wire));

describe("board codec（B1，白板模型 #114，新信封 #119 M1）", () => {
	describe("客户端消息 board_write", () => {
		it("set 新贴（无 id）往返", () => {
			const wire = encodeMessage({
				jsonrpc: "2.0",
				id: "w1",
				method: "board_write",
				params: { action: "set", note: { content: "第一条" } },
			});
			expect(decodeClient(wire)).toEqual({
				jsonrpc: "2.0",
				id: "w1",
				method: "board_write",
				params: { action: "set", note: { content: "第一条" } },
			});
		});

		it("set 改条（带 id）与 remove / clear 往返", () => {
			const edit = decodeClient(
				encodeMessage({
					jsonrpc: "2.0",
					id: "w2",
					method: "board_write",
					params: { action: "set", note: { id: "n1", content: "修改后" } },
				}),
			);
			expect(edit).toEqual({
				jsonrpc: "2.0",
				id: "w2",
				method: "board_write",
				params: { action: "set", note: { id: "n1", content: "修改后" } },
			});

			const remove = decodeClient(
				encodeMessage({
					jsonrpc: "2.0",
					id: "w3",
					method: "board_write",
					params: { action: "remove", note: { id: "n1" } },
				}),
			);
			expect(remove).toEqual({
				jsonrpc: "2.0",
				id: "w3",
				method: "board_write",
				params: { action: "remove", note: { id: "n1" } },
			});

			const clear = decodeClient(
				encodeMessage({ jsonrpc: "2.0", id: "w4", method: "board_write", params: { action: "clear" } }),
			);
			expect(clear).toEqual({ jsonrpc: "2.0", id: "w4", method: "board_write", params: { action: "clear" } });
		});

		it("未知 action 值被拒", () => {
			expect(() =>
				decodeClient(
					encodeMessage({
						jsonrpc: "2.0",
						id: "w5",
						method: "board_write",
						params: { action: "frobnicate" },
					}),
				),
			).toThrow();
		});

		// PR #116 review（F1，2026-08-04）：跨字段契约 fail-close——按 action 判别
		// 的非法组合在 codec 层即拒（不再落业务 no-op）。
		describe("按 action 判别的不变量（PR #116 F1）", () => {
			it("remove 必须带 id：无 id 的 remove 被拒", () => {
				expect(() =>
					decodeClient(
						encodeMessage({ jsonrpc: "2.0", id: "w6", method: "board_write", params: { action: "remove" } }),
					),
				).toThrow();
			});

			it("remove 禁止携带 content（定向撕条只按 id）", () => {
				expect(() =>
					decodeClient(
						encodeMessage({
							jsonrpc: "2.0",
							id: "w7",
							method: "board_write",
							params: { action: "remove", note: { id: "n1", content: "内容" } },
						}),
					),
				).toThrow();
			});

			it("clear 禁止携带 note", () => {
				expect(() =>
					decodeClient(
						encodeMessage({
							jsonrpc: "2.0",
							id: "w8",
							method: "board_write",
							params: { action: "clear", note: { id: "n1" } },
						}),
					),
				).toThrow();
			});
		});

		it("额外字段被拒（closed schema）", () => {
			expect(() =>
				decodeClient(
					encodeMessage({
						jsonrpc: "2.0",
						id: "w9",
						method: "board_write",
						params: { action: "clear", actor: "A" },
					}),
				),
			).toThrow();
		});
	});

	describe("客户端消息 board_query", () => {
		it("无参往返", () => {
			const wire = encodeMessage({ jsonrpc: "2.0", id: "q1", method: "board_query" });
			expect(decodeClient(wire)).toEqual({ jsonrpc: "2.0", id: "q1", method: "board_query" });
		});
	});

	describe("board_write 响应四态", () => {
		it("applied 带 note（set 新贴 id 回带）", () => {
			const wire = encodeMessage({
				jsonrpc: "2.0",
				id: "r1",
				result: { changed: true, note: { id: "n1", content: "第一条" } },
			});
			expect(decodeServer(wire)).toEqual({
				jsonrpc: "2.0",
				id: "r1",
				result: { changed: true, note: { id: "n1", content: "第一条" } },
			});
		});

		it("applied 不带 note（remove/clear 成功）", () => {
			const wire = encodeMessage({ jsonrpc: "2.0", id: "r2", result: { changed: true } });
			expect((decodeServer(wire) as { result: Record<string, unknown> }).result).toEqual({ changed: true });
		});

		it("告知码（note_not_found / board_empty / note_unchanged）", () => {
			for (const code of ["note_not_found", "board_empty", "note_unchanged"]) {
				const wire = encodeMessage({
					jsonrpc: "2.0",
					id: "r3",
					result: { changed: false, code },
				});
				expect(decodeServer(wire)).toEqual({
					jsonrpc: "2.0",
					id: "r3",
					result: { changed: false, code },
				});
			}
		});

		it("拒绝码（max_notes_exceeded / note_length_exceeded）", () => {
			for (const code of ["max_notes_exceeded", "note_length_exceeded"]) {
				const wire = encodeMessage({
					jsonrpc: "2.0",
					id: "r4",
					result: { changed: false, code },
				});
				expect(decodeServer(wire)).toEqual({
					jsonrpc: "2.0",
					id: "r4",
					result: { changed: false, code },
				});
			}
		});

		it("changed:true 不能携带 code（嵌套 union 排除无意义组合）", () => {
			expect(() =>
				decodeServer(
					encodeMessage({
						jsonrpc: "2.0",
						id: "r5",
						result: { changed: true, code: "note_unchanged" },
					}),
				),
			).toThrow();
		});

		it("changed:false 必须携带 code", () => {
			expect(() =>
				decodeServer(encodeMessage({ jsonrpc: "2.0", id: "r6", result: { changed: false } })),
			).toThrow();
		});

		it("协议级失败走 error（NOT_IN_GROUP 码，message 原样保留）", () => {
			const wire = encodeMessage({
				jsonrpc: "2.0",
				id: "r7",
				error: { code: -32100, message: "Character is not in the group chat" },
			});
			expect(decodeServer(wire)).toEqual({
				jsonrpc: "2.0",
				id: "r7",
				error: { code: -32100, message: "Character is not in the group chat" },
			});
		});
	});

	describe("board_query 响应", () => {
		it("全量 per-character 条目往返", () => {
			const wire = encodeMessage({
				jsonrpc: "2.0",
				id: "q1",
				result: { boards: { A: [{ id: "n1", content: "A 的板" }], B: [] } },
			});
			expect(decodeServer(wire)).toEqual({
				jsonrpc: "2.0",
				id: "q1",
				result: { boards: { A: [{ id: "n1", content: "A 的板" }], B: [] } },
			});
		});
	});

	describe("服务器通知 board_update", () => {
		it("action 四值 + note 往返（add/update/remove 带条，clear 无 note）", () => {
			for (const action of ["add", "update", "remove"]) {
				const wire = encodeMessage({
					jsonrpc: "2.0",
					method: "board_update",
					params: { actor: "A", action, note: { id: "n1", content: "条内容" } },
				});
				expect(decodeServer(wire)).toEqual({
					jsonrpc: "2.0",
					method: "board_update",
					params: { actor: "A", action, note: { id: "n1", content: "条内容" } },
				});
			}
			const clear = decodeServer(
				encodeMessage({
					jsonrpc: "2.0",
					method: "board_update",
					params: { actor: "A", action: "clear" },
				}),
			);
			expect(clear).toEqual({
				jsonrpc: "2.0",
				method: "board_update",
				params: { actor: "A", action: "clear" },
			});
		});

		it("无 sequence 字段：带 sequence 被拒（不在消息流、无水位语义）", () => {
			expect(() =>
				decodeServer(
					encodeMessage({
						jsonrpc: "2.0",
						method: "board_update",
						params: { actor: "A", action: "add", note: { id: "n1", content: "x" }, sequence: 7 },
					}),
				),
			).toThrow();
		});

		// PR #116 review（F3，2026-08-04）：board_update 判别 union——
		// add/update/remove 必带 note、clear 禁 note。
		describe("按 action 判别的不变量（PR #116 F3）", () => {
			it("add/update/remove 必须携带 note：缺 note 被拒", () => {
				for (const action of ["add", "update", "remove"]) {
					expect(() =>
						decodeServer(
							encodeMessage({ jsonrpc: "2.0", method: "board_update", params: { actor: "A", action } }),
						),
					).toThrow();
				}
			});

			it("clear 禁止携带 note", () => {
				expect(() =>
					decodeServer(
						encodeMessage({
							jsonrpc: "2.0",
							method: "board_update",
							params: { actor: "A", action: "clear", note: { id: "n1", content: "x" } },
						}),
					),
				).toThrow();
			});
		});
	});
});
