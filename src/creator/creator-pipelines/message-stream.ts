import type { PublicMessageState } from "../../protocol/public-message-state.js";
import type { WhisperMessageState } from "../../protocol/whisper-message-state.js";

/**
 * ：统一时间序消息流（WH3）——公开消息与私信共用 sequence 递增器
 * （无空洞保证，submit-message-pipeline/whisper-message-pipeline 同源），
 * 读取时按 sequence 归并排序。stale 检查（B2/B6）与历史查询/增量拉取
 * 投影共用本函数，保证序列语义单一来源。
 */
export function mergeMessageStreams(
	publicMessages: PublicMessageState[],
	whisperMessages: WhisperMessageState[],
): Array<PublicMessageState | WhisperMessageState> {
	if (publicMessages.length === 0) {
		return [...whisperMessages];
	}
	if (whisperMessages.length === 0) {
		return [...publicMessages];
	}
	const merged: Array<PublicMessageState | WhisperMessageState> = [];
	let publicIndex = 0;
	let whisperIndex = 0;
	while (publicIndex < publicMessages.length || whisperIndex < whisperMessages.length) {
		const publicCandidate = publicMessages[publicIndex] ?? null;
		const whisperCandidate = whisperMessages[whisperIndex] ?? null;
		if (publicCandidate === null) {
			whisperIndex++;
			if (whisperCandidate !== null) {
				merged.push(whisperCandidate);
			}
			continue;
		}
		if (whisperCandidate === null) {
			publicIndex++;
			merged.push(publicCandidate);
			continue;
		}
		if (publicCandidate.sequence <= whisperCandidate.sequence) {
			merged.push(publicCandidate);
			publicIndex++;
		} else {
			merged.push(whisperCandidate);
			whisperIndex++;
		}
	}
	return merged;
}

/**
 *  服务端投影半场：按请求者投影视角计算 stale 判定的 latestOtherSequence。
 * 旁观者视角的 whisper（sender≠请求者 且 recipient≠请求者，只可见占位、零信息
 * 增量）不计入——与客户端 unread_first 占位豁免（本地半场）同源语义；
 * 接收者全文（recipient=请求者）恒计入（全文已实时投递，旧游标发言确应 stale）；
 * 请求者自己发送的消息排除（发送者零事件，游标不越自己的私信）；公开消息恒计入
 * （防内容风暴防线不破）。
 *
 * 供 submit-message-pipeline 与 whisper-message-pipeline 两处 stale 扫描同源使用
 * （消除复制面）。
 */
export function computeLatestOtherSequence(
	merged: Array<PublicMessageState | WhisperMessageState>,
	requesterCharacterId: string,
): number {
	for (let i = merged.length - 1; i >= 0; i--) {
		const candidate = merged[i];
		if (candidate === undefined) {
			continue;
		}
		if (candidate.sender.type === "character" && candidate.sender.character_id === requesterCharacterId) {
			continue;
		}
		//  服务端投影半场：旁观者视角的 whisper（只见占位）不计入。
		// 判别：whisper 恒含 recipient（public 无此字段）。
		if ("recipient" in candidate && candidate.recipient.character_id !== requesterCharacterId) {
			continue;
		}
		return candidate.sequence;
	}
	return 0;
}
