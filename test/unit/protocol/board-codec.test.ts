/**
 * B1 codec 契约测试：白板模型（#114）board_write / board_query / board_update 编解码。
 *
 * 契约来源：issue #114（09:24 版）B1 节 + ADR-0007 §3。
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

describe("board codec（B1，白板模型 #114）", () => {
	describe("客户端消息 board_write", () => {
		it("set 新贴（无 id）往返", () => {
			const wire = encodeMessage({ type: "board_write", action: "set", note: { content: "第一条" } });
			expect(decodeClient(wire)).toEqual({
				type: "board_write",
				action: "set",
				note: { content: "第一条" },
			});
		});

		it("set 改条（带 id）与 remove / clear 往返", () => {
			const edit = decodeClient(
				encodeMessage({ type: "board_write", action: "set", note: { id: "n1", content: "修改后" } }),
			);
			expect(edit).toEqual({ type: "board_write", action: "set", note: { id: "n1", content: "修改后" } });

			const remove = decodeClient(encodeMessage({ type: "board_write", action: "remove", note: { id: "n1" } }));
			expect(remove).toEqual({ type: "board_write", action: "remove", note: { id: "n1" } });

			const clear = decodeClient(encodeMessage({ type: "board_write", action: "clear" }));
			expect(clear).toEqual({ type: "board_write", action: "clear" });
		});

		it("未知 action 值被拒", () => {
			expect(() => decodeClient(encodeMessage({ type: "board_write", action: "frobnicate" }))).toThrow();
		});

		it("额外字段被拒（closed schema）", () => {
			expect(() => decodeClient(encodeMessage({ type: "board_write", action: "clear", actor: "A" }))).toThrow();
		});
	});

	describe("客户端消息 board_query", () => {
		it("无参往返", () => {
			const wire = encodeMessage({ type: "board_query" });
			expect(decodeClient(wire)).toEqual({ type: "board_query" });
		});
	});

	describe("board_write 响应四态", () => {
		it("applied 带 note（set 新贴 id 回带）", () => {
			const wire = encodeMessage({
				id: "r1",
				type: "response",
				command: "board_write",
				success: true,
				data: { changed: true, note: { id: "n1", content: "第一条" } },
			});
			expect(decodeServer(wire)).toEqual({
				id: "r1",
				type: "response",
				command: "board_write",
				success: true,
				data: { changed: true, note: { id: "n1", content: "第一条" } },
			});
		});

		it("applied 不带 note（remove/clear 成功）", () => {
			const wire = encodeMessage({
				id: "r2",
				type: "response",
				command: "board_write",
				success: true,
				data: { changed: true },
			});
			expect(decodeServer(wire).type).toBe("response");
		});

		it("告知码（note_not_found / board_empty / note_unchanged）", () => {
			for (const code of ["note_not_found", "board_empty", "note_unchanged"]) {
				const wire = encodeMessage({
					id: "r3",
					type: "response",
					command: "board_write",
					success: true,
					data: { changed: false, code },
				});
				expect(decodeServer(wire)).toEqual({
					id: "r3",
					type: "response",
					command: "board_write",
					success: true,
					data: { changed: false, code },
				});
			}
		});

		it("拒绝码（max_notes_exceeded / note_length_exceeded）", () => {
			for (const code of ["max_notes_exceeded", "note_length_exceeded"]) {
				const wire = encodeMessage({
					id: "r4",
					type: "response",
					command: "board_write",
					success: true,
					data: { changed: false, code },
				});
				expect(decodeServer(wire)).toEqual({
					id: "r4",
					type: "response",
					command: "board_write",
					success: true,
					data: { changed: false, code },
				});
			}
		});

		it("changed:true 不能携带 code（嵌套 union 排除无意义组合）", () => {
			expect(() =>
				decodeServer(
					encodeMessage({
						id: "r5",
						type: "response",
						command: "board_write",
						success: true,
						data: { changed: true, code: "note_unchanged" },
					}),
				),
			).toThrow();
		});

		it("changed:false 必须携带 code", () => {
			expect(() =>
				decodeServer(
					encodeMessage({
						id: "r6",
						type: "response",
						command: "board_write",
						success: true,
						data: { changed: false },
					}),
				),
			).toThrow();
		});

		it("协议级失败走 sendFailure（success:false + error，union 增量）", () => {
			const wire = encodeMessage({
				id: "r7",
				type: "response",
				command: "board_write",
				success: false,
				error: "Character is not in the group chat",
			});
			expect(decodeServer(wire)).toEqual({
				id: "r7",
				type: "response",
				command: "board_write",
				success: false,
				error: "Character is not in the group chat",
			});
		});
	});

	describe("board_query 响应", () => {
		it("全量 per-character 条目往返", () => {
			const wire = encodeMessage({
				id: "q1",
				type: "response",
				command: "board_query",
				success: true,
				data: { boards: { A: [{ id: "n1", content: "A 的板" }], B: [] } },
			});
			expect(decodeServer(wire)).toEqual({
				id: "q1",
				type: "response",
				command: "board_query",
				success: true,
				data: { boards: { A: [{ id: "n1", content: "A 的板" }], B: [] } },
			});
		});
	});

	describe("服务器通知 board_update", () => {
		it("action 四值 + note 往返（add/update/remove 带条，clear 无 note）", () => {
			for (const action of ["add", "update", "remove"]) {
				const wire = encodeMessage({
					type: "board_update",
					actor: "A",
					action,
					note: { id: "n1", content: "条内容" },
				});
				expect(decodeServer(wire)).toEqual({
					type: "board_update",
					actor: "A",
					action,
					note: { id: "n1", content: "条内容" },
				});
			}
			const clear = decodeServer(encodeMessage({ type: "board_update", actor: "A", action: "clear" }));
			expect(clear).toEqual({ type: "board_update", actor: "A", action: "clear" });
		});

		it("无 sequence 字段：带 sequence 被拒（不在消息流、无水位语义）", () => {
			expect(() =>
				decodeServer(
					encodeMessage({
						type: "board_update",
						actor: "A",
						action: "add",
						note: { id: "n1", content: "x" },
						sequence: 7,
					}),
				),
			).toThrow();
		});
	});
});
