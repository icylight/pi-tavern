/**
 * 公开消息的会话态类型（跨进程契约，shared 层）。
 *
 * 自 creator-runtime 迁出（#58 Phase 1 PR-1）：reload-handoff（跨进程交接）
 * 与 resume 投影均消费此类型，属共享契约，不归任一运行时私有。
 * 纯类型迁位，形状零变——不构成 wire schema 变更。
 */
export interface PublicMessageState {
	sender: { type: "user_persona" } | { type: "character"; character_id: string; name: string };
	content: string;
	event_id: string;
	sequence: number;
	timestamp: string;
	round: { round_max_messages: number; used_messages: number; remaining_messages: number };
}
