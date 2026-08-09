import type { PublicMessageState } from "../../protocol/public-message-state.js";
import type { WhisperMessageState } from "../../protocol/whisper-message-state.js";

/**
 * #152：统一时间序消息流（WH3）——公开消息与私信共用 sequence 递增器
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
