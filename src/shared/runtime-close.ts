/**
 * Unified termination interface for CreatorRuntime and CharacterRuntime.
 * See docs/extension-architecture.md → Runtime 统一清理接口.
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
	/** True when the runtime queue did not drain within the coordination timeout. */
	timedOut: boolean;
	/** Non-fatal errors collected while cleaning up; cleanup still completed. */
	errors: Error[];
}
