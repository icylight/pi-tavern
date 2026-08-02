/**
 * 不透明历史游标。编码 sequence 边界：携带此游标的请求返回 sequence < seq
 * 的消息。绝对 sequence 保证新消息到达时游标位置稳定。
 */
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
export function countPersistedEntries(entries: readonly { type: string; customType?: string }[]): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.type === "session_info") {
			count++;
		} else if (entry.type === "custom" && entry.customType === "pi-tavern.group-settings") {
			count++;
		} else if (entry.type === "custom_message" && entry.customType === "pi-tavern.public-message") {
			count++;
		}
	}
	return count;
}
