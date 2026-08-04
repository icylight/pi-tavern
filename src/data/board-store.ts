/**
 * 白板模型（#114，ADR-0007）：每角色一块本人白板的存储实现。
 *
 * 内存态 + 文件持久化（boards/<groupId>.json，目录由 boardDir 决定）：
 * - 懒加载恢复：首次 read/write 时读取文件；不存在 = 空板；损坏 = 降级空板 + warn
 * - 原子写：tmp 文件 + rename（cursor-store / active-descriptor 同法）
 * - 单写者：同步 API，串行化由调用方（WS 消息队列）保证
 * - store 分配稳定条 id（randomUUID，跨重启不重复）
 * - actor 隔离：按 sender 分板，跨角色 id 定向 = note_not_found（本人板上即不存在）
 * - 操作返回变更结果（outcome 判别联合，通知组装在 pipeline 层——本模块不依赖协议类型）
 * - deleteBoard：trash CLI 优先、失败回退 unlink、幂等、清内存缓存（删后无复活）
 *
 * 码点计数 = [...content].length（utf8mb4 同款，Array.from 语义）。
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

/** 每角色白板默认条数上限（issue #114：默认 5 条，可配置）。 */
export const DEFAULT_MAX_NOTES_PER_BOARD = 5;
/** 单条默认长度上限（码点，issue #114：默认 140，可配置）。 */
export const DEFAULT_MAX_NOTE_LENGTH = 140;

export interface BoardNote {
	id: string;
	content: string;
}

export type BoardWriteAction = "set" | "remove" | "clear";

/** 白板条 id 定向目标（remove 必带 id；set 带 id = 改条 edit）。 */
export interface BoardNoteRef {
	id?: string;
	content?: string;
}

export type BoardWriteOutcome =
	| { status: "applied"; note?: BoardNote }
	| { status: "noop"; code: "note_not_found" | "board_empty" | "note_unchanged" }
	| { status: "rejected"; code: "max_notes_exceeded" | "note_length_exceeded" };

export interface DeleteBoardResult {
	ok: boolean;
	method: "trash" | "unlink";
	error?: string;
}

export interface TrashResult {
	status: number | null;
	/** Error 或 { message } 平面对象（测试注入形态，spawnSync 形态子集）。 */
	error?: Error | { message?: string };
	stderr?: string;
}

export interface BoardStoreDependencies {
	/** boards 目录（boards/<groupId>.json）。 */
	boardDir: string;
	/** trash CLI 结果面（spawnSync 形态子集，镜像 group-chat-sessions）。缺省 = trash CLI。 */
	trash?: (path: string) => TrashResult;
	exists?: (path: string) => boolean;
	/** 允许同步/异步（测试注入同步实现；默认 fs/promises unlink）。 */
	unlink?: (path: string) => void | Promise<void>;
	warn?: (message: string) => void;
	/** 条数上限（默认 5）。 */
	maxNotesPerBoard?: number;
	/** 单条长度上限（码点，默认 140）。 */
	maxNoteLength?: number;
}

export interface BoardStore {
	/**
	 * 执行一次白板写操作。返回 outcome（applied / noop+告知码 / rejected+拒绝码）；
	 * 仅 applied 落盘（no-op 不落盘、拒绝不改动原条）。
	 */
	write(groupId: string, sender: string, action: BoardWriteAction, note?: BoardNoteRef): BoardWriteOutcome;
	/** 全量读（per-sender 条目，深拷贝返回）。 */
	read(groupId: string): Record<string, BoardNote[]>;
	/** 删除群聊白板文件（trash 优先，失败回退 unlink；幂等；清缓存防复活）。 */
	deleteBoard(groupId: string): Promise<DeleteBoardResult>;
}

/** 每角色板的内容（内部形态：sender → 条列表，插入序 = 贴条序）。 */
type BoardContents = Map<string, BoardNote[]>;

export function createBoardStore(deps: BoardStoreDependencies): BoardStore {
	const { boardDir } = deps;
	// 缺省依赖（测试注入覆盖；默认镜像 group-chat-sessions 的删除语义）。
	const trash: (path: string) => TrashResult =
		deps.trash ?? ((path) => spawnSync("trash", [path], { encoding: "utf-8" }));
	const exists: (path: string) => boolean = deps.exists ?? ((path) => existsSync(path));
	const unlinkFile: (path: string) => void | Promise<void> = deps.unlink ?? ((path) => unlink(path));
	const warn: (message: string) => void = deps.warn ?? ((message) => console.warn(message));
	const maxNotesPerBoard = deps.maxNotesPerBoard ?? DEFAULT_MAX_NOTES_PER_BOARD;
	const maxNoteLength = deps.maxNoteLength ?? DEFAULT_MAX_NOTE_LENGTH;
	mkdirSync(boardDir, { recursive: true });

	/** 内存缓存：groupId → 板内容（懒加载）。 */
	const cache = new Map<string, BoardContents>();

	function boardFile(groupId: string): string {
		return join(boardDir, `${groupId}.json`);
	}

	/** 懒加载：不存在 = 空板；损坏（非法 JSON / 形状不符）= 降级空板 + warn，不抛错。 */
	function loadBoard(groupId: string): BoardContents {
		const cached = cache.get(groupId);
		if (cached) {
			return cached;
		}
		const board: BoardContents = new Map();
		const path = boardFile(groupId);
		try {
			const raw = readFileSync(path, "utf8");
			const parsed: unknown = JSON.parse(raw);
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				for (const [sender, notes] of Object.entries(parsed as Record<string, unknown>)) {
					if (!Array.isArray(notes)) {
						continue;
					}
					const valid: BoardNote[] = [];
					for (const note of notes) {
						if (
							note !== null &&
							typeof note === "object" &&
							typeof (note as BoardNote).id === "string" &&
							typeof (note as BoardNote).content === "string"
						) {
							valid.push({ id: (note as BoardNote).id, content: (note as BoardNote).content });
						}
					}
					board.set(sender, valid);
				}
			} else {
				warn(`[board-store] 白板文件形状不符，降级空板: ${path}`);
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				warn(
					`[board-store] 白板文件损坏，降级空板: ${path} (${error instanceof Error ? error.message : String(error)})`,
				);
			}
		}
		cache.set(groupId, board);
		return board;
	}

	/** 原子写：tmp + rename；仅 applied 路径调用。 */
	function persist(groupId: string): void {
		const path = boardFile(groupId);
		const board = loadBoard(groupId);
		const payload: Record<string, BoardNote[]> = {};
		for (const [sender, notes] of board) {
			payload[sender] = notes.map((note) => ({ id: note.id, content: note.content }));
		}
		const tmp = join(boardDir, `.${randomUUID()}.tmp`);
		writeFileSync(tmp, JSON.stringify(payload), "utf8");
		renameSync(tmp, path);
	}

	function boardOf(groupId: string, sender: string): BoardNote[] {
		const board = loadBoard(groupId);
		let notes = board.get(sender);
		if (!notes) {
			notes = [];
			board.set(sender, notes);
		}
		return notes;
	}

	function write(groupId: string, sender: string, action: BoardWriteAction, note?: BoardNoteRef): BoardWriteOutcome {
		const notes = boardOf(groupId, sender);
		if (action === "set") {
			if (note?.id) {
				// 改条（edit）：不占条数上限，仍受单条长度上限；原条不变语义。
				const existing = notes.find((n) => n.id === note.id);
				if (!existing) {
					return { status: "noop", code: "note_not_found" };
				}
				if (note.content === undefined || note.content === existing.content) {
					return { status: "noop", code: "note_unchanged" };
				}
				if ([...(note.content as string)].length > maxNoteLength) {
					return { status: "rejected", code: "note_length_exceeded" };
				}
				existing.content = note.content as string;
				persist(groupId);
				return { status: "applied", note: { id: existing.id, content: existing.content } };
			}
			// 新贴：无内容可贴 = 无变化（schema 允许缺省，业务语义幂等）。
			if (note?.content === undefined) {
				return { status: "noop", code: "note_unchanged" };
			}
			if ([...note.content].length > maxNoteLength) {
				return { status: "rejected", code: "note_length_exceeded" };
			}
			if (notes.length >= maxNotesPerBoard) {
				return { status: "rejected", code: "max_notes_exceeded" };
			}
			const id = randomUUID();
			notes.push({ id, content: note.content });
			persist(groupId);
			return { status: "applied", note: { id, content: note.content } };
		}
		if (action === "remove") {
			const index = notes.findIndex((n) => n.id === note?.id);
			if (index === -1) {
				return { status: "noop", code: "note_not_found" };
			}
			notes.splice(index, 1);
			persist(groupId);
			return { status: "applied" };
		}
		// clear
		if (notes.length === 0) {
			return { status: "noop", code: "board_empty" };
		}
		notes.length = 0;
		persist(groupId);
		return { status: "applied" };
	}

	function read(groupId: string): Record<string, BoardNote[]> {
		const board = loadBoard(groupId);
		const result: Record<string, BoardNote[]> = {};
		for (const [sender, notes] of board) {
			result[sender] = notes.map((note) => ({ id: note.id, content: note.content }));
		}
		return result;
	}

	async function deleteBoard(groupId: string): Promise<DeleteBoardResult> {
		const path = boardFile(groupId);
		// 删后摘除缓存并落空板墓碑：后续 read = 空、再写 = 新板（旧内容无复活路径）。
		// 文件删除走 trash/unlink（真实路径）；空板墓碑保证注入 unlink 失败等场景下
		// 进程内读不到已被逻辑删除的板。
		cache.set(groupId, new Map());
		const trashResult = trash(path);
		if (trashResult.status === 0 || !exists(path)) {
			return { ok: true, method: "trash" };
		}
		try {
			await unlinkFile(path);
			return { ok: true, method: "unlink" };
		} catch (error) {
			const unlinkError = error instanceof Error ? error.message : String(error);
			const trashErrorHint = trashResult.error?.message ?? trashResult.stderr?.trim();
			return {
				ok: false,
				method: "unlink",
				error: trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError,
			};
		}
	}

	return { write, read, deleteBoard };
}
