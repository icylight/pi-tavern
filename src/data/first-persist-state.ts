/** 首次持久化里程碑位标记，用于失败时的精细回滚。 */
export const FIRST_PERSIST_HEADER_WRITTEN = 1 << 0;
export const FIRST_PERSIST_SESSION_OPENED = 1 << 1;
export const FIRST_PERSIST_NAME_APPENDED = 1 << 2;
export const FIRST_PERSIST_SETTINGS_APPENDED = 1 << 3;
export const FIRST_PERSIST_MESSAGE_APPENDED = 1 << 4;

export type FirstPersistStep =
	| typeof FIRST_PERSIST_HEADER_WRITTEN
	| typeof FIRST_PERSIST_SESSION_OPENED
	| typeof FIRST_PERSIST_NAME_APPENDED
	| typeof FIRST_PERSIST_SETTINGS_APPENDED
	| typeof FIRST_PERSIST_MESSAGE_APPENDED;

/**
 * 首次持久化五比特状态机（纯逻辑，可独立单测）。每一位代表一个已完成步骤；
 * 操作前先置位，回滚才能知道该步已尝试（writeFile 可能先建/部分写入文件再抛错）。
 */
export class FirstPersistState {
	private flags = 0;

	mark(step: FirstPersistStep): void {
		this.flags |= step;
	}

	has(step: FirstPersistStep): boolean {
		return (this.flags & step) !== 0;
	}

	reset(): void {
		this.flags = 0;
	}
}
