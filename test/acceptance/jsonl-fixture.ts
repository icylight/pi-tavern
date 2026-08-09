import { randomUUID } from "node:crypto";

/**
 * JSONL fixture 生成器（ADR-0010 剧本驱动 e2e，Arch 优化方案 3）。
 * pi session JSONL 格式（session-manager.js 实证）：
 * - 第 1 行 header = {type:"session", version, id, timestamp, cwd, parentSession}
 * - 后续每行 = {type, id, parentId, timestamp, ...payload}
 * 格式敏感收敛单点：恢复类 fixture 一律经本模块构造。
 */

export interface SessionEntryLike {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	customType?: string;
	content?: string | unknown[];
	display?: boolean;
	details?: unknown;
}

export function sessionHeader(options: { id: string; timestamp: string; cwd: string }): string {
	return JSON.stringify({
		type: "session",
		version: 2,
		id: options.id,
		timestamp: options.timestamp,
		cwd: options.cwd,
		parentSession: null,
	});
}

/** 追加一条 custom_message entry（与 pi appendCustomMessageEntry 产物同构）。 */
export function customMessageEntry(options: {
	customType: string;
	content: string | unknown[];
	display: boolean;
	details?: unknown;
	timestamp: string;
	parentId?: string | null;
}): SessionEntryLike {
	return {
		type: "custom_message",
		customType: options.customType,
		content: options.content,
		display: options.display,
		details: options.details,
		id: randomUUID(),
		parentId: options.parentId ?? null,
		timestamp: options.timestamp,
	};
}

/** #152：whisper-message entry 构造（details 形状与 creator-factory 恢复读取一致）。 */
export function whisperMessageEntry(options: {
	sender: { character_id: string; name: string };
	recipient: { character_id: string; name: string };
	content: string;
	sequence: number;
	round: { round_max_messages: number; used_messages: number; remaining_messages: number };
	timestamp: string;
	parentId?: string | null;
}): SessionEntryLike {
	return customMessageEntry({
		customType: "pi-tavern.whisper-message",
		content: `${options.sender.name}→${options.recipient.name} whisper: ${options.content}`,
		display: true,
		timestamp: options.timestamp,
		...(options.parentId !== undefined ? { parentId: options.parentId } : {}),
		details: {
			sender: { type: "character", character_id: options.sender.character_id, name: options.sender.name },
			recipient: { type: "character", character_id: options.recipient.character_id, name: options.recipient.name },
			content: options.content,
			sequence: options.sequence,
			round: options.round,
		},
	});
}

/** 追加一行 entry 到 JSONL 文件。 */
export function serializeEntry(entry: SessionEntryLike): string {
	return JSON.stringify(entry);
}
