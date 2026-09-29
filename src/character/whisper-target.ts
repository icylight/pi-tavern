import type { OnlineCharacterWire } from "../protocol/messages.js";

/** 在线成员名册（`get_group_chat_state` 的 `online_characters`；恰为可私信集合）。 */
export type WhisperRoster = readonly OnlineCharacterWire[];

/** 解析结果判别式（工具面文案由调用方渲染；本模块只做判定与格式化）。 */
export type WhisperTargetOutcome =
	| { kind: "resolved"; character_id: string; name: string }
	| { kind: "self"; character_id: string; name: string }
	| { kind: "ambiguous"; candidates: Array<{ name: string; character_id: string }> }
	| { kind: "not-found"; roster: WhisperRoster }
	| { kind: "roster-unavailable" };

/** 私信目标解析（#183）：精确 `character_id` 优先 → 注册名唯一命中。
 *
 * 规范化口径 = 两段零猜测：先以**输入原样**匹配，再以 `trim()` 后匹配一次
 * （容忍模型首尾空白，不破坏合法含空格卡名）；不做大小写折叠、不做全角归一
 * ——不匹配即未命中，由调用方报错并附在线清单。歧义（多个在线同名）与
 * 命中自己都不投递。
 */
export function resolveWhisperTargetFromRoster(
	input: string,
	roster: WhisperRoster,
	selfId: string,
): WhisperTargetOutcome {
	const trimmed = input.trim();
	const stages = trimmed === input ? [input] : [input, trimmed];
	for (const stage of stages) {
		// id 本身就是路径字符串（`../角色卡/admin.md` 形态），与 name 分面判。
		const byId = roster.find((member) => member.character_id === stage);
		if (byId !== undefined) {
			return byId.character_id === selfId
				? { kind: "self", character_id: byId.character_id, name: byId.name }
				: { kind: "resolved", character_id: byId.character_id, name: byId.name };
		}
		const byName = roster.filter((member) => member.name === stage);
		if (byName.length > 1) {
			return {
				kind: "ambiguous",
				candidates: byName.map((member) => ({ name: member.name, character_id: member.character_id })),
			};
		}
		const hit = byName[0];
		if (hit !== undefined) {
			return hit.character_id === selfId
				? { kind: "self", character_id: hit.character_id, name: hit.name }
				: { kind: "resolved", character_id: hit.character_id, name: hit.name };
		}
	}
	return { kind: "not-found", roster };
}

/** 成员条目列表文本（`注册名（character_id）` 顿号连接），用于候选与在线清单。 */
export function formatMemberList(members: ReadonlyArray<{ name: string; character_id: string }>): string {
	return members.map((member) => `${member.name}（${member.character_id}）`).join("、");
}

/** `tavern_members` 的简介截断上限（默认值，工具面复用）。 */
export const MEMBER_DESCRIPTION_LIMIT = 80;

/** 简介截断：超限时按字符截断并追加省略号。 */
export function truncateDescription(text: string, limit: number = MEMBER_DESCRIPTION_LIMIT): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** 名册排序：自己置首，其余保持快照顺序（join 序）——列表与错误清单同序。 */
export function orderRoster(roster: WhisperRoster): OnlineCharacterWire[] {
	return [...roster.filter((member) => member.is_self), ...roster.filter((member) => !member.is_self)];
}
