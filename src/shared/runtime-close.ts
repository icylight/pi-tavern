/**
 * CreatorRuntime 与 CharacterRuntime 的统一终止接口。
 * 见 docs/extension-architecture.md → Runtime 统一清理接口。
 */

export type RuntimeCloseReason =
	| "user_leave"
	| "session_change"
	| "quit"
	| "socket_closed"
	| "heartbeat_timeout"
	| "group_chat_closed"
	| "reload_timeout"
	| "initialization_failed";

export interface RuntimeCloseResult {
	/** 协调超时内 runtime 队列未排空时为 true。 */
	timedOut: boolean;
	/** 清理过程中收集的非致命错误；清理仍然完成。 */
	errors: Error[];
}
