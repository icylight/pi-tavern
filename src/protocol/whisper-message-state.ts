/**
 * ：私信消息状态（creator 内存态；与 PublicMessageState 同构的定向变体）。
 * 与公开消息共用 sequence 递增器（nextSequence 交错分配无空洞）；恢复/查询时
 * 与公开消息按 sequence 合并排序为统一时间序消息流（WH3）。
 */
export interface WhisperMessageState {
	sender: { type: "character"; character_id: string; name: string };
	recipient: { type: "character"; character_id: string; name: string };
	content: string;
	event_id: string;
	sequence: number;
	timestamp: string;
	round: {
		round_max_messages: number;
		used_messages: number;
		remaining_messages: number;
	};
}
