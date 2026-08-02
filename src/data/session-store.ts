import {
	FIRST_PERSIST_HEADER_WRITTEN,
	FIRST_PERSIST_MESSAGE_APPENDED,
	FIRST_PERSIST_NAME_APPENDED,
	FIRST_PERSIST_SESSION_OPENED,
	FIRST_PERSIST_SETTINGS_APPENDED,
	FirstPersistState,
} from "./first-persist-state.js";

/**
 * 本地结构类型接口：pi 宿主 SessionManager 的方法子集。skills 不 import pi
 * 包（含类型）；宿主对象经 runtime 注入，TS 结构类型让 pi SessionManager
 * 天然满足本接口（单测注入假件即可）。
 */
export interface SessionManagerLike {
	setSessionFile(sessionFile: string): void;
	getCwd(): string;
	getSessionDir(): string;
	getSessionFile(): string | undefined;
	getHeader(): SessionHeaderLike | null;
	getEntries(): SessionEntryLike[];
	getEntry(id: string): SessionEntryLike | undefined;
	appendSessionInfo(name: string): string;
	appendCustomEntry(customType: string, data?: unknown): string;
	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | unknown[],
		display: boolean,
		details?: T,
	): string;
}

/** 工厂：pi SessionManager 的静态 create/open 以本接口形式注入。 */
export interface SessionManagerFactory {
	create(cwd: string, sessionDir: string, options: { id: string }): SessionManagerLike;
	open(path: string, sessionDir: string, cwdOverride: string): SessionManagerLike;
}

/** 会话条目的本地最小形态（读路径所需字段）。 */
export interface SessionEntryLike {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	customType?: string;
	name?: string;
	data?: unknown;
	details?: unknown;
	content?: string | unknown[];
	display?: boolean;
}

/** 会话 header 的本地最小形态。pi 的 SessionHeader 无 parentId，故为可选。 */
export interface SessionHeaderLike {
	id: string;
	parentId?: string | null;
	timestamp: string;
}

export interface SessionStoreDeps {
	writeFile: (path: string, data: string) => Promise<void>;
	rm: (path: string) => Promise<void>;
}

export function formatEntryContent(senderLabel: string, body: string): string {
	const trimmed = body.replace(/\n+$/, "");
	return `${senderLabel}:\n${trimmed}\n`;
}

export interface FirstPersistInput {
	/** 会话文件路径（首次持久化前可能尚无文件；由 getSessionFilePath 供给）。 */
	sessionPath: string;
	/** 规范 header（已用 createdAt 对齐 timestamp）。 */
	header: SessionHeaderLike;
	/** 群聊 id，用于回滚时重建 SessionManager 实例。 */
	groupChatId: string;
	/** 群聊名称；非空时追加 session_info 条目。 */
	name: string | null;
	groupMaxMessages: number;
	/** 首条消息的 sequence。 */
	sequence: number;
	/** 首条消息原文（User Persona）。 */
	content: string;
}

export interface FirstPersistResult {
	entryId: string;
	/** 本次实际持久化的条目数（1-3），供调用方推进 persistedCount。 */
	entriesPersisted: number;
}

/**
 * 会话持久化能力（生命周期 + FIRST_PERSIST 状态机 + 追加失败恢复编排）。
 * 持有注入的 SessionManagerLike 实例；runtime 只持有实例并注入，不直接
 * 编排读写。会话文件 IO 全部经注入接口发生。
 */
export class SessionStore {
	private readonly firstPersist = new FirstPersistState();
	private persistenceFatal = false;

	constructor(
		private sessionManager: SessionManagerLike,
		private readonly factory: SessionManagerFactory,
		private readonly deps: SessionStoreDeps,
	) {}

	static create(
		factory: SessionManagerFactory,
		cwd: string,
		sessionDir: string,
		options: { id: string },
		deps: SessionStoreDeps,
	): SessionStore {
		return new SessionStore(factory.create(cwd, sessionDir, options), factory, deps);
	}

	static open(
		factory: SessionManagerFactory,
		path: string,
		sessionDir: string,
		cwdOverride: string,
		deps: SessionStoreDeps,
	): SessionStore {
		return new SessionStore(factory.open(path, sessionDir, cwdOverride), factory, deps);
	}

	/** 当前持有的 SessionManager 实例（回滚重建后返回新实例）。 */
	getSessionManager(): SessionManagerLike {
		return this.sessionManager;
	}

	getHeader(): SessionHeaderLike | null {
		return this.sessionManager.getHeader();
	}

	getEntries(): SessionEntryLike[] {
		return this.sessionManager.getEntries();
	}

	getEntry(id: string): SessionEntryLike | undefined {
		return this.sessionManager.getEntry(id);
	}

	getSessionFilePath(): string {
		const path = this.sessionManager.getSessionFile();
		if (!path) throw new Error("Session file not set");
		return path;
	}

	assertWritable(): void {
		if (this.persistenceFatal) {
			throw new Error("Group chat persistence is broken — further writes are blocked");
		}
	}

	appendSessionInfo(name: string): void {
		this.sessionManager.appendSessionInfo(name);
	}

	appendCustomEntry(customType: string, data?: unknown): void {
		this.sessionManager.appendCustomEntry(customType, data);
	}

	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | unknown[],
		display: boolean,
		details?: T,
	): string {
		return this.sessionManager.appendCustomMessageEntry(customType, content, display, details);
	}

	/**
	 * 追加失败后恢复 SessionManager 内存态。SessionManager._appendEntry 在
	 * 磁盘写入前先改 byId/leafId；失败时磁盘文件仍有效（写入从未发生），
	 * 因此 setSessionFile 可重载干净状态。若连这也失败，持久化被标记为致命
	 * ——此后所有变更操作一律拒绝，而不是带着损坏/空内存态继续。
	 */
	recoverFromFailedAppend(originalError: unknown): never {
		try {
			this.sessionManager.setSessionFile(this.getSessionFilePath());
			// 恢复成功——重抛原始错误供调用方上报；SessionManager 已为下一次
			// 操作保持干净。
			throw originalError;
		} catch (recoveryError) {
			if (recoveryError === originalError) throw originalError;
			// setSessionFile 自身失败——不可恢复。
			this.persistenceFatal = true;
			throw new Error(
				`Persistence recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}. ` +
					`Original error: ${originalError instanceof Error ? originalError.message : String(originalError)}`,
				{ cause: originalError },
			);
		}
	}

	/**
	 * 恢复并返回要上报的错误。供恢复后仍需继续的调用方使用（如 handleSpeak
	 * 需要发送响应）。
	 */
	recoverFromFailedAppendAndCatch(originalError: unknown): Error {
		try {
			this.sessionManager.setSessionFile(this.getSessionFilePath());
		} catch (recoveryError) {
			this.persistenceFatal = true;
			return new Error(
				`Persistence recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}. ` +
					`Original error: ${originalError instanceof Error ? originalError.message : String(originalError)}`,
				{ cause: originalError },
			);
		}
		return originalError instanceof Error ? originalError : new Error(String(originalError));
	}

	/**
	 * 首次持久化：先用 header 种子文件，之后全部走 append API，使 ID、
	 * parentId 链与信封都由 SessionManager 管理。位标记跟踪每步，便于部分
	 * 失败时精细回滚。失败时回滚并重抛原始错误；persistedCount 推进由
	 * 调用方按 entriesPersisted 完成（调用方仅在成功后推进）。
	 */
	async persistFirstMessage(input: FirstPersistInput): Promise<FirstPersistResult> {
		const { sessionPath, header, groupChatId, name, groupMaxMessages, sequence, content } = input;
		const roundMaxMessages = groupMaxMessages;
		let entriesPersisted = 0;
		this.firstPersist.reset();
		try {
			// 操作前先置位，回滚才能知道该步已尝试
			// （writeFile 可能先建/部分写入文件再抛错）。
			this.firstPersist.mark(FIRST_PERSIST_HEADER_WRITTEN);
			await this.deps.writeFile(sessionPath, `${JSON.stringify(header)}\n`);

			this.firstPersist.mark(FIRST_PERSIST_SESSION_OPENED);
			this.sessionManager.setSessionFile(sessionPath);

			if (name) {
				this.sessionManager.appendSessionInfo(name);
				this.firstPersist.mark(FIRST_PERSIST_NAME_APPENDED);
				entriesPersisted++;
			}

			this.sessionManager.appendCustomEntry("pi-tavern.group-settings", {
				group_max_messages: roundMaxMessages,
			});
			this.firstPersist.mark(FIRST_PERSIST_SETTINGS_APPENDED);
			entriesPersisted++;

			const entryId = this.sessionManager.appendCustomMessageEntry(
				"pi-tavern.public-message",
				formatEntryContent("User Persona", content),
				true,
				{
					sender: { type: "user_persona" as const },
					content,
					sequence,
					round: {
						round_max_messages: roundMaxMessages,
						used_messages: 0,
						remaining_messages: roundMaxMessages,
					},
				},
			);
			this.firstPersist.mark(FIRST_PERSIST_MESSAGE_APPENDED);
			entriesPersisted++;
			return { entryId, entriesPersisted };
		} catch (error) {
			try {
				await this.rollbackFirstPersist(sessionPath, groupChatId);
			} catch (rollbackError) {
				throw new Error(
					`Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
					{ cause: error },
				);
			}
			throw error;
		}
	}

	/**
	 * 用位标记决定首次持久化部分完成时的回滚清理。每一位代表一个已完成步骤。
	 */
	private async rollbackFirstPersist(sessionPath: string, groupChatId: string): Promise<void> {
		// 先快照位值再 reset：状态对象 reset 会清掉同一引用上的位。
		const headerWritten = this.firstPersist.has(FIRST_PERSIST_HEADER_WRITTEN);
		const sessionOpened = this.firstPersist.has(FIRST_PERSIST_SESSION_OPENED);
		this.firstPersist.reset();

		if (headerWritten) {
			// 删除半初始化的文件。若删除失败，Runtime 无法安全继续——会在磁盘
			// 残留损坏文件的同时启动新会话。
			try {
				await this.deps.rm(sessionPath);
			} catch {
				this.persistenceFatal = true;
				throw new Error(
					"Failed to delete half-initialized session file during rollback. " +
						"Persistence is now blocked to prevent duplicate sessions.",
				);
			}
		}

		if (sessionOpened) {
			// SessionManager 内存态已被失败的追加改动。重建全新实例——文件
			// 已在上方删除。下一次首次持久化将以规范 createdAt 写 header。
			this.sessionManager = this.factory.create(
				this.sessionManager.getCwd(),
				this.sessionManager.getSessionDir(),
				{ id: groupChatId },
			);
		}
	}
}
