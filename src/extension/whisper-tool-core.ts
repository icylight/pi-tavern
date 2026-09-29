import type { CharacterRuntime } from "../character/character-runtime.js";
import {
	formatMemberList,
	MEMBER_DESCRIPTION_LIMIT,
	orderRoster,
	truncateDescription,
} from "../character/whisper-target.js";
import { TOOL_MEMBERS_HEADER_PREFIX, TOOL_MEMBERS_OFFLINE_NOTE } from "../shared/messages.js";

/** 工具与 test 缝共用的执行结果（工具面文案原文；缝负责单行化）。
 *
 * `ok` = 私信已发布 / 列表已获取（缝与工具共用判据）；`isError` = 工具错误态
 *（工具 isError 位）——stale / 轮次上限 / 未读阻断属**业务拒绝**，
 * 与发布失败同 ok=false 但 **isError=false**（既有工具语义，不得回归）。
 */
export interface ToolCoreResult {
	ok: boolean;
	isError: boolean;
	text: string;
	sequence?: number;
	details?: unknown;
}

/** `tavern_whisper` 执行核心（工具 handler 与 `/tavern-test-whisper` 缝同调）。
 *
 * 解析（#183）在工具侧完成：命中后仍以**精确 `character_id`** 走既有 wire
 * 请求；`roster-unavailable` 放行原串交服务端判（保持既有 `-32110` 语义）。
 */
export async function runWhisperToolCore(
	runtime: CharacterRuntime,
	target: string,
	content: string,
): Promise<ToolCoreResult> {
	const outcome = await runtime.resolveWhisperTarget(target);
	if (outcome.kind === "self") {
		return {
			ok: false,
			isError: true,
			text:
				`Error: 目标「${outcome.name}」是你自己——不能给自己发私信。` +
				`要公开发言请用 tavern_speak；向他人私信请改传对方的注册名或 character_id。`,
		};
	}
	if (outcome.kind === "ambiguous") {
		return {
			ok: false,
			isError: true,
			text:
				`Error: 目标「${target}」在在线成员中有多个同名命中，无法确定收件人。` +
				`候选：${formatMemberList(outcome.candidates)}。` +
				`请改用 character_id 精确指定（可用 tavern_members 查看在线成员）。`,
		};
	}
	if (outcome.kind === "not-found") {
		return {
			ok: false,
			isError: true,
			text:
				`Error: 目标「${target}」不在当前在线成员中——离线成员无法收私信（也可能是拼写不同或本群没有该角色）。` +
				`当前在线：${formatMemberList(orderRoster(outcome.roster))}。` +
				`请核对注册名或 character_id，或用 tavern_members 查看在线成员。`,
		};
	}
	const characterId = outcome.kind === "resolved" ? outcome.character_id : target;
	try {
		const result = await runtime.whisper(characterId, content);
		if (!result.published) {
			if (result.reason === "stale") {
				// stale 自愈（与 speak 同路径）：预算内标记增量待投递，
				// settle 补拉（合并流含 whisper 帧 → 机械消费占位/全文 + 游标推进）。
				if (result.autoRecover) {
					runtime.markIncrementPending();
				}
				return {
					ok: false,
					isError: false,
					text:
						`Message NOT published: you are out of sync with the group chat ` +
						`(you last saw seq ${result.missingFrom !== undefined ? result.missingFrom - 1 : "?"}; ` +
						`messages ${result.missingFrom}..${result.missingTo} arrived before your whisper). ` +
						`Your message was not counted against the round quota and no hand was raised.` +
						(result.autoRecover
							? `\nThe new messages will be delivered to you after this turn (auto-recovery); re-decide then — revise or drop.`
							: `\nAuto-recovery budget exhausted this round — wait for the group chat input before whispering again.`),
				};
			}
			if (result.reason === "round_limit_reached") {
				// 与 speak 同款 round-limit 文案（已举手排队），
				// 不得误报「未读已安排拉取」（未读分支语义不同）。
				return {
					ok: false,
					isError: false,
					text:
						`Message not published: round limit reached. ` +
						`Your hand is now raised — the creator will see you have more to say. ` +
						`The full message remains in your private session.`,
				};
			}
			// 未读先读阻止（与 speak 同款）——不占额度、不举手。
			return {
				ok: false,
				isError: false,
				text: "Message NOT published: 有未读消息，请先阅读再决定是否发言。" + "未读已安排拉取，注入后将自动重新决策。",
			};
		}
		return {
			ok: true,
			isError: false,
			text: `Message sent (sequence ${result.sequence}).`,
			...(result.sequence !== undefined ? { sequence: result.sequence } : {}),
		};
	} catch (error) {
		// 错误码透传（-32110 离线 / -32111 自发自收 / 超额 / stale 等）。
		return { ok: false, isError: true, text: error instanceof Error ? error.message : String(error) };
	}
}

/** `tavern_members` 执行核心（工具 handler 与 `/tavern-test-members` 缝同调）。
 *
 * 在线 only（数据源 = `get_group_chat_state` 的在线成员表）：注册名 /
 * character_id / 状态 / 截断简介；自己置首。离线成员不在列（无法收私信）。
 */
export async function runMembersToolCore(runtime: CharacterRuntime): Promise<ToolCoreResult> {
	let members: ReturnType<typeof orderRoster>;
	try {
		const state = await runtime.getGroupChatState("other");
		members = orderRoster(state.online_characters ?? []);
	} catch (error) {
		return {
			ok: false,
			isError: true,
			text: `Error: 在线成员列表暂不可用：${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const lines = members.map(
		(member) =>
			`- ${member.name}（character_id：${member.character_id}，self=${member.is_self ? "yes" : "no"}，` +
			`streaming=${member.is_streaming ? "yes" : "no"}，hand=${member.hand_raised ? "yes" : "no"}）：` +
			truncateDescription(member.description),
	);
	return {
		ok: true,
		isError: false,
		text:
			`${TOOL_MEMBERS_HEADER_PREFIX}${members.length}${TOOL_MEMBERS_OFFLINE_NOTE}` +
			(lines.length > 0 ? `\n${lines.join("\n")}` : ""),
		details: {
			count: members.length,
			description_limit: MEMBER_DESCRIPTION_LIMIT,
			members: members.map((member) => ({
				name: member.name,
				character_id: member.character_id,
				is_self: member.is_self,
				is_streaming: member.is_streaming,
				hand_raised: member.hand_raised,
				description: truncateDescription(member.description),
			})),
		},
	};
}
