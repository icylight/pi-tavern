/**
 * 不透明历史游标。编码 sequence 边界：携带此游标的请求返回 sequence < seq
 * 的消息。绝对 sequence 保证新消息到达时游标位置稳定。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function encodeCursor(sequence: number): string {
	return Buffer.from(JSON.stringify({ v: 1, seq: sequence })).toString("base64url");
}

export function decodeCursor(cursor: string): number | null {
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: number; seq?: number };
		if (parsed.v !== 1 || typeof parsed.seq !== "number" || !Number.isSafeInteger(parsed.seq)) {
			return null;
		}
		return parsed.seq;
	} catch {
		return null;
	}
}

/**
 * 统计会话条目中 PiTavern 自有的已持久化条目数（session_info /
 * pi-tavern.group-settings / pi-tavern.public-message）。resume 时据此恢复
 * persistedCount：计数只取决于条目类型，与其余状态重建逻辑无关。
 */
/**
 * PiTavern 自有、写入群聊 session JSONL 的条目类型集合（单一事实源）：
 * 新增 JSONL 持久化类型必须同步此处（#152 评审 B4 教训——whisper 曾漏计）。
 * 注：board 为独立 JSON 文件（不写 session JSONL）；creator-display 为创建者
 * TUI 投影条目（与 public/whisper 一一对应，计入会双倍重复）——均不属计数对象。
 */
const PERSISTED_ENTRY_TYPES: ReadonlyArray<{ type: string; customType?: string }> = [
	{ type: "session_info" },
	{ type: "custom", customType: "pi-tavern.group-settings" },
	{ type: "custom_message", customType: "pi-tavern.public-message" },
	{ type: "custom_message", customType: "pi-tavern.whisper-message" },
];

export function countPersistedEntries(entries: readonly { type: string; customType?: string }[]): number {
	let count = 0;
	for (const entry of entries) {
		if (
			PERSISTED_ENTRY_TYPES.some(
				(owned) =>
					entry.type === owned.type && (owned.customType === undefined || entry.customType === owned.customType),
			)
		) {
			count++;
		}
	}
	return count;
}

/**
 * 游标文件读取原语（无状态同步）：readFileSync 失败（ENOENT/EISDIR 等）如实
 * 抛错；内容非法 JSON 或形状不符返回 null（损坏属数据问题，非 IO 问题）。
 * 内存缓存与 best-effort 吞错是编排语义，归调用方（character-runtime，
 * 决策 7：跨消息状态唯一居所 = runtime）。
 */
export function readCursorFile(path: string): number | null {
	const raw = readFileSync(path, "utf8");
	let data: { last_sequence?: unknown };
	try {
		data = JSON.parse(raw) as { last_sequence?: unknown };
	} catch {
		return null;
	}
	if (typeof data.last_sequence === "number" && Number.isSafeInteger(data.last_sequence) && data.last_sequence >= 0) {
		return data.last_sequence;
	}
	return null;
}

/**
 * 游标文件原子写原语（无状态同步）：mkdir 递归建目录 + tmp 写入 + rename
 * 替换，任何失败如实抛错。固定 tmp 名在同步原语下无竞态（事件循环内天然
 * 串行）——保持同步是行为零变化铁律（Arch 评审阻断项：async 化 = 阻断）。
 */
export function writeCursorFile(path: string, sequence: number): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmpPath = `${path}.tmp`;
	writeFileSync(tmpPath, JSON.stringify({ last_sequence: sequence, updated_at: new Date().toISOString() }), "utf8");
	renameSync(tmpPath, path);
}
