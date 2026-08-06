import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "../protocol/messages.js";
import {
	METHOD_BOARD_UPDATE,
	METHOD_CHARACTER_JOINED,
	METHOD_CHARACTER_LEFT,
	METHOD_GROUP_CHAT_UPDATE,
	METHOD_MESSAGE_HISTORY,
	METHOD_PUBLIC_MESSAGE,
} from "../shared/messages.js";
import type { CharacterRuntime } from "./character-runtime.js";

/**
 * 仅供验收套件使用的观察通道（ISSUE-003 身份行契约，cab1fd7）。RPC 模式
 * 没有输入通道、也无法调用扩展工具，因此身份行通过 pi.ui.notify() 重发
 * （以 extension_ui_request 形式呈现）。notify 函数从 session_start 处理器
 * 注入（唯一有 UI 访问权的位置）；每次会话启动（含 reload）都会重新绑定。
 */
let testNotify: ((message: string) => void) | undefined;

export function setTestNotify(notify: ((message: string) => void) | undefined): void {
	testNotify = notify;
}

export interface GroupChatInputReloadSnapshot {
	pendingEvents: ServerMessage[];
	debounceDueAt: number | null;
	/** 可选仅为兼容新字段加入前创建的进程内 handoff。 */
	idleWindowDueAt?: number | null | undefined;
	idleWindowAbortEligible?: boolean | undefined;
	incrementPending?: boolean | undefined;
}

/**
 * M7（ISSUE-012/#24）修订（#64 pull 模型）：非 update 事件（join 历史、成员
 * 变化）后提交环境批次前的等待时长。旧的 1s 后沿 debounce 已从 group_chat_update
 * 移除——update 仅置标记——但成员/历史批次仍短暂合并，避免一次 join 拆成多次输入。
 */
const JOIN_BATCH_DEBOUNCE_MS = 1000;

/**
 * #64：闲态触发窗口（固定窗口，有界延迟）。广播 = 纯标记；无 run 时首条标记
 * 启动 1s 固定窗口，窗口内 N 条并入（不重置）→ 到期 1 次触发拉全（N 条 = 1 次
 * 消费）。忙态（run 活跃期）不走窗口——settle 后立即触发（对话连续性优先）。
 */
const TRIGGER_DEBOUNCE_MS = 1000;

/**
 * 忙态安全边界打断令牌。令牌作为隐藏 custom message 经 steer 排队，在下一次
 * provider 请求前由 context 钩子消费；session JSONL 保留记录，但模型上下文
 * 始终过滤该类型。
 */
export const ABORT_CONTROL_CUSTOM_TYPE = "pi-tavern.abort-control";

export class GroupChatInput {
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private debounceDueAt: number | null = null;
	/** #64：闲态触发窗口定时器（fixed 1s，窗口内并入不重置；reload 本地交接）。 */
	private idleWindowTimer: ReturnType<typeof setTimeout> | null = null;
	private idleWindowDueAt: number | null = null;
	/** 闲态窗口内是否已有通知可确认包含他人公共消息。 */
	private idleWindowAbortEligible = false;
	/**
	 * ISSUE-013 A1/A2：待投递窗口。持有加入时的公共历史与白板更新（经
	 * debounce 合并），以及因 Agent turn 运行中而等待的非群消息流输入。
	 */
	private pendingEvents: ServerMessage[] = [];
	private handler: ((message: ServerMessage) => void) | undefined;
	private stopped = false;
	/** 单飞行锁：最多同时一个 fetch_messages_since 在途。 */
	private fetchInFlight = false;
	/** 拉取在途时有新触发 → 之后补拉一次。 */
	private refetchRequested = false;
	/**
	 * 忙态标记（#64）：Agent 运行中有 update 到达时置位；settle = 忙态触发点，
	 * 立即消费拉全（游标单调，消费即拉全，无尾部补拉）。ISSUE-013 B3 的
	 * stale 拒绝恢复也走同一标记。
	 */
	private incrementPending = false;
	/** 当前 run 是否已有一个安全边界打断令牌排队。 */
	private abortTokenQueued = false;
	/** 当前 run 是否已经在安全边界请求过 abort。 */
	private abortRequested = false;
	/**
	 * #128：最近一帧 group_chat_update 的完整水位知识（latest_sequence +
	 * preview）。speak 前置「未读先读」判定以此推导——单一事实源 = 投递游标 +
	 * 最新水位，不引入独立计数器（reload 不携带水位，未知即不阻塞，服务端
	 * stale 兜底）。只存最新一帧：update 是累积水位，新帧包含旧帧信息。
	 */
	private latestGroupChatUpdate: Extract<ServerMessage, { method: "group_chat_update" }> | null = null;

	constructor(
		private readonly runtime: CharacterRuntime,
		private readonly pi: ExtensionAPI,
		private readonly triggerDebounceMs: number = TRIGGER_DEBOUNCE_MS,
	) {
		// 公共群消息正文不在 run 中投递。运行中到达的 update 只置忙态标记并
		// 按需排隐藏令牌；settle = 正文拉取触发点。
		this.onSettled = () => {
			if (this.stopped) {
				return;
			}
			this.abortTokenQueued = false;
			this.abortRequested = false;
			if (this.incrementPending) {
				this.incrementPending = false;
				void this.pullIncrement();
			}
		};
	}

	private readonly onSettled: () => void;

	start(): void {
		this.handler = (message: ServerMessage) => {
			if ("method" in message && message.method === METHOD_MESSAGE_HISTORY && Array.isArray(message.params.messages)) {
				// join 时快照：展开为单个 public_message 事件。
				// ISSUE-008：has_more 时通过 cursor 分页剩余历史，避免丢失更早消息。
				// M7：持久化光标优先——回归的 character 从上次投递位置差量同步，
				// 而不是重读历史。
				const before = this.pendingEvents.length;
				for (const m of message.params.messages) {
					if (m && typeof m === "object" && "method" in m && m.method === METHOD_PUBLIC_MESSAGE) {
						if (!this.isEnvironmentEvent(m as ServerMessage)) continue;
						this.pendingEvents.push(m as ServerMessage);
					}
				}
				// 仅当确实添加了消息才启动 debounce
				if (this.pendingEvents.length > before) {
					this.resetJoinDebounce();
				}
				// 分页刻意 fire-and-forget：下方已排定的 flush 携带第一页；更早的
				// 页到达后追加，由随后的 debounce 一并 flush。
				if (message.params.has_more) {
					this.pageOlderHistory(message.params.cursor).catch(() => undefined);
				}
				return;
			}
			if ("method" in message && message.method === METHOD_GROUP_CHAT_UPDATE) {
				// #64（pull 模型）：广播 = 纯标记（水位），消费 = run 边界拉全未读。
				// 闲态：首条标记启动 1s 固定窗口（窗口内并入不重置），到期 1 次触发
				// 拉全；忙态：置忙态标记，settle 后立即触发（零中间注入红线）。
				// preview 仅供 TUI（同一数据源，内容不会分叉）。
				// v0.5 收窄：group_chat_update 只表示公共消息水位；白板使用独立
				// board_update，成员/流式状态不再触发本通知。发送者仍会收到广播，
				// 但完整 preview 足以证明新增窗口全是自身消息时不得 abort/拉取。
				// #128：先记录水位知识（即使早退也要刷新——后续 speak 判定据此推导）。
				this.latestGroupChatUpdate = message;
				const cursor = this.runtime.loadCursor() ?? 0;
				const selfPreview = this.classifySelfPreview(message, cursor);
				if (message.params.latest_sequence <= cursor || selfPreview === "complete-self-only") {
					return;
				}
				if (this.runtime.isAgentActive) {
					// 忙态只置未读标记，不提前拉取正文。可确认含他人消息时，最多排队
					// 一个隐藏 steer 令牌；令牌在工具批结束后的 context 安全边界消费，
					// 才 abort 当前 run。preview 不完整且含自身回显时无法证明他人消息
					// 归属，只保留待拉取状态，让当前 run 自然 settled 后补拉，避免自身
					// 连续发言造成自打断。
					this.incrementPending = true;
					if (selfPreview !== "incomplete-with-self") {
						this.queueAbortControlToken();
					}
				} else {
					this.armIdleWindow(selfPreview === "external");
				}
				void this.runtime.refreshGroupChatState();
				return;
			}
			if (!this.isEnvironmentEvent(message)) return;
			this.pendingEvents.push(message);
			this.resetJoinDebounce();
		};
		this.runtime.onEnvironmentMessage = this.handler;
		// （重新）启动时重新挂接 settle 钩子。
		this.runtime.onAgentSettled = this.onSettled;
	}

	/**
	 * #64：消费原语——拉取持久化光标之后的所有未读并立即投递（一次拉全，
	 * 保序不重不漏）。由两个触发点调用：闲态窗口到期 / settle（忙态标记）。
	 *
	 * 单飞行：并发的消费只标记 refetchRequested，合并为一次后续拉取。
	 * ISSUE-038 的 settle 竞态修复保留：拉取期间 run 可能 settle/启动，投递
	 * 前重查 isAgentActive 决定通道（空闲 → followUp 触发新 run；活跃 → steer
	 * 兜底，绝不打断 run）。
	 */
	private async pullIncrement(): Promise<void> {
		if (this.stopped || this.fetchInFlight) {
			this.refetchRequested = true;
			return;
		}
		this.fetchInFlight = true;
		try {
			do {
				this.refetchRequested = false;
				const since = this.runtime.loadCursor() ?? 0;
				const page = await this.runtime.fetchMessagesSince(since);
				if (!page || this.stopped) {
					return;
				}
				const messages: ServerMessage[] = [];
				for (const m of page.messages) {
					if (m && typeof m === "object" && "method" in m && m.method === METHOD_PUBLIC_MESSAGE) {
						if (!this.isEnvironmentEvent(m as ServerMessage)) continue;
						messages.push(m as ServerMessage);
					}
				}
				if (messages.length > 0) {
					// 游标推进移至投递成功判定（双通道契约：idle followUp /
					// 忙态 steer 入队成功 = 投递成功 → saveCursor；失败不推进，
					// settle 兜底重投——A5 强化实现）。
					await this.deliver(messages, page.latestSequence);
				} else if (page.messages.some((message) => "method" in message && message.method === METHOD_PUBLIC_MESSAGE)) {
					// 拉取窗口只有自身回显时不生成 Agent 输入，但仍消费对应水位；否则
					// preview 超限的连续自身消息会在每次 settle 被永久重拉。
					this.runtime.saveCursor(page.latestSequence);
				}
			} while (this.refetchRequested && !this.stopped);
		} catch {
			// 拉取失败：保持光标；下次 update 或 join 会重拉同一窗口
			// （按 sequence 幂等）。
		} finally {
			this.fetchInFlight = false;
		}
	}

	/**
	 * ISSUE-013 A1/A2 + ISSUE-038：统一投递窗口。将增量与待处理的加入公共
	 * 历史/白板事件合并并保证顺序。公共消息增量在 settled 后走 followUp；
	 * 白板等独立事件在活跃 run 中仍可走其既有 steer 通道。
	 */
	private async deliver(messages: ServerMessage[], latestSequence: number): Promise<void> {
		if (this.stopped) {
			return;
		}
		const events = [...this.pendingEvents, ...messages];
		this.pendingEvents = [];
		if (events.length === 0) {
			return;
		}
		// await 投递链：flush 内 preflightResult 成功才推进游标——do-while 补拉
		// 决策必须基于已推进的游标（否则重复投递已投窗口）。
		await this.flush(events, latestSequence);
	}

	/**
	 * 逐页遍历剩余群聊历史（最旧页在最后），将每条公开消息追加到待投递窗口。
	 * 任何失败都会中止遍历：第一页已在队列中，重连会重新同步历史。ISSUE-008。
	 */
	private async pageOlderHistory(cursor: string | null): Promise<void> {
		try {
			let nextCursor: string | null = cursor;
			// A1 守卫：绝不重复请求同一 cursor。服务器不推进（或回显陈旧 cursor）
			// 时不能无限循环。
			const seenCursors = new Set<string>();
			while (nextCursor !== null && !this.stopped) {
				if (seenCursors.has(nextCursor)) {
					break;
				}
				seenCursors.add(nextCursor);
				const page = await this.runtime.fetchMessageHistoryPage(nextCursor);
				if (!page) {
					return;
				}
				for (const m of page.messages) {
					if (m && typeof m === "object" && "method" in m && m.method === METHOD_PUBLIC_MESSAGE) {
						if (!this.isEnvironmentEvent(m as ServerMessage)) continue;
						this.pendingEvents.push(m as ServerMessage);
					}
				}
				this.resetJoinDebounce();
				nextCursor = page.cursor;
				if (!page.hasMore) {
					break;
				}
			}
		} catch {
			// 尽力而为：保留已收集到的历史。
		}
	}

	stop(): void {
		this.stopped = true;
		this.runtime.onEnvironmentMessage = undefined;
		if (this.runtime.onAgentSettled === this.onSettled) {
			this.runtime.onAgentSettled = undefined;
		}
		this.handler = undefined;
		this.clearDebounce();
		this.cancelIdleWindow();
		this.pendingEvents = [];
		this.abortTokenQueued = false;
		this.abortRequested = false;
	}

	/**
	 * context 钩子在令牌进入下一次模型调用前调用。仅当前输入实例仍有未读待拉取、
	 * run 仍活跃且令牌尚未消费时请求一次 abort；历史令牌不会再次打断。
	 */
	consumeAbortControlToken(abort: () => void): boolean {
		if (
			this.stopped ||
			!this.abortTokenQueued ||
			this.abortRequested ||
			!this.incrementPending ||
			!this.runtime.isAgentActive
		) {
			return false;
		}
		this.abortTokenQueued = false;
		this.abortRequested = true;
		abort();
		if (process.env.PITAVERN_TEST === "1") {
			testNotify?.(`[tavern-inject] group=${this.runtime.groupChatId} abort=1 boundary=steer`);
		}
		return true;
	}

	private queueAbortControlToken(): void {
		if (this.stopped || this.abortTokenQueued || this.abortRequested) {
			return;
		}
		this.abortTokenQueued = true;
		try {
			this.pi.sendMessage(
				{
					customType: ABORT_CONTROL_CUSTOM_TYPE,
					content: "",
					display: false,
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
			if (process.env.PITAVERN_TEST === "1") {
				testNotify?.(`[tavern-inject] group=${this.runtime.groupChatId} abort=0 token=queued`);
			}
		} catch {
			this.abortTokenQueued = false;
		}
	}

	/**
	 * 捕获未 flush 的环境事件与 debounce 截止时间，供 reload 交接。
	 * 快照恰好被新 runtime 消费一次。
	 */
	snapshotForReload(): GroupChatInputReloadSnapshot {
		return {
			pendingEvents: [...this.pendingEvents],
			debounceDueAt: this.debounceDueAt,
			idleWindowDueAt: this.idleWindowDueAt,
			idleWindowAbortEligible: this.idleWindowAbortEligible,
			incrementPending: this.incrementPending,
		};
	}

	/** 恢复 reload 前拍摄的快照；必须在 start() 之后调用。 */
	restoreFromReload(snapshot: GroupChatInputReloadSnapshot): void {
		this.pendingEvents = [...snapshot.pendingEvents];
		if (snapshot.debounceDueAt !== null) {
			const remaining = snapshot.debounceDueAt - Date.now();
			if (remaining <= 0) {
				// 已到期：当前 tick 之后立即处理。
				setTimeout(() => {
					if (!this.stopped) void this.flush();
				}, 0);
			} else {
				this.debounceTimer = setTimeout(() => {
					this.debounceTimer = null;
					void this.flush();
				}, remaining);
			}
		}
		// 跨版本 reload：旧代码生成的 handoff 没有以下新字段。此时无法知道
		// detach 前属于忙态未读还是闲态窗口，保守地按持久化游标补拉一次；
		// 无未读时为空操作，重复可接受但跳过不可接受。
		const legacyUnreadState = snapshot.incrementPending === undefined;
		if (snapshot.incrementPending === true || legacyUnreadState) {
			// reload 已终止旧 run；原忙态未读现在可立即按游标拉全并 followUp 重开。
			void this.pullIncrement();
			return;
		}
		if (snapshot.idleWindowDueAt !== null && snapshot.idleWindowDueAt !== undefined) {
			this.idleWindowAbortEligible = snapshot.idleWindowAbortEligible ?? false;
			this.scheduleIdleWindow(Math.max(0, snapshot.idleWindowDueAt - Date.now()));
		}
	}

	/**
	 * #64：闲态触发窗口（固定 1s，窗口内并入不重置）。窗口到期派生判定：
	 * run 已活跃（窗口开启期间他源启动的 run）→ 交忙态；已确认含他人消息时
	 * 排隐藏令牌，否则自然等待 settle。正文均不提前拉取；仍空闲 → 消费拉全。
	 */
	private armIdleWindow(abortEligible = false): void {
		if (this.stopped) {
			return;
		}
		// 固定窗口内通知不重置计时，但保留“至少一条可确认含他人消息”的证据。
		// 若窗口期间由其他来源启动 run，到期后据此决定是否安全打断。
		this.idleWindowAbortEligible ||= abortEligible;
		if (this.idleWindowTimer !== null) {
			return;
		}
		this.scheduleIdleWindow(this.triggerDebounceMs);
	}

	private scheduleIdleWindow(delayMs: number): void {
		this.idleWindowDueAt = Date.now() + delayMs;
		this.idleWindowTimer = setTimeout(() => {
			this.idleWindowTimer = null;
			this.idleWindowDueAt = null;
			const shouldAbort = this.idleWindowAbortEligible;
			this.idleWindowAbortEligible = false;
			if (this.stopped) {
				return;
			}
			if (this.runtime.isAgentActive) {
				// 窗口期间由其他来源启动了 run：交忙态。已确认含他人消息时补排
				// 隐藏令牌，避免新 run 在未见该消息的旧上下文上继续；preview 不完整
				// 且含自身消息时仍自然 settled，避免自身回显误打断。
				this.incrementPending = true;
				if (shouldAbort) {
					this.queueAbortControlToken();
				}
				return;
			}
			void this.pullIncrement();
		}, delayMs);
	}

	private cancelIdleWindow(): void {
		if (this.idleWindowTimer !== null) {
			clearTimeout(this.idleWindowTimer);
			this.idleWindowTimer = null;
		}
		this.idleWindowDueAt = null;
		this.idleWindowAbortEligible = false;
	}

	hasPendingBatch(): boolean {
		return this.debounceTimer !== null;
	}

	private isEnvironmentEvent(message: ServerMessage): boolean {
		if (!("method" in message)) {
			return false;
		}
		switch (message.method) {
			case METHOD_PUBLIC_MESSAGE:
				return !this.isOwnEcho(message);
			case METHOD_MESSAGE_HISTORY:
				return true;
			// 白板模型（#114，ADR-0007）：board_update = 环境事件（通知渲染），
			// 与 group_chat_update（拉取触发）是两套消费语义——进 pendingEvents 批处理，
			// 绝不挂 incrementPending（board 不在消息流，拉取只会空转）。
			// 自回显过滤（09:27 版 User 拍板）：写者本人不收自己写的回显（响应已含
			// 结果、actor 限定本人板——自回显 100% 冗余）；他人更新不受影响。
			case METHOD_BOARD_UPDATE:
				return message.params.actor !== this.runtime.character.characterId;
			default:
				return false;
		}
	}

	private isOwnEcho(message: Extract<ServerMessage, { method: "public_message" }>): boolean {
		return (
			message.params.sender.type === "character" &&
			message.params.sender.character_id === this.runtime.character.characterId
		);
	}

	/**
	 * #128：speak 前置「未读先读」判定——推导式计数（Arch 评审 ①：单一事实源
	 * = 投递游标 + 最新水位，不维护独立计数器，reload/重连无状态同步风险）。
	 * 语义与服务端 stale 判定同源：自身回显排除在未读之外。
	 *
	 * 返回 undefined = 水位未知（reload 后、join 早期）→ 不阻塞（服务端 stale
	 * 兜底，Arch ①/③ 口径）；count = 已证明的他人未读条数（preview 截断时给出
	 * 下界），exact = preview 是否完整覆盖 cursor 后窗口。阻塞条件除 count > 0
	 * 外，还包括「截断窗口含自身回显」这一发送者未知场景（#128 定稿要求保守阻止）。
	 */
	unreadOthersProven(): { shouldBlock: boolean; count: number; exact: boolean } | undefined {
		const update = this.latestGroupChatUpdate;
		if (update === null) {
			return undefined;
		}
		const cursor = this.runtime.loadCursor() ?? 0;
		if (update.params.latest_sequence <= cursor) {
			return { shouldBlock: false, count: 0, exact: true };
		}
		const unseen = update.params.preview_messages.filter((preview) => preview.params.sequence > cursor);
		const expected = update.params.latest_sequence - cursor;
		const exact = unseen.length === expected;
		const otherUnseen = unseen.filter(
			(preview) =>
				preview.params.sender.type !== "character" ||
				preview.params.sender.character_id !== this.runtime.character.characterId,
		);
		const containsSelf = unseen.some(
			(preview) =>
				preview.params.sender.type === "character" &&
				preview.params.sender.character_id === this.runtime.character.characterId,
		);
		return {
			// preview 被截断且含自身回显时，缺口中的发送者未知。按 #128 定稿
			// 保守阻止，由 settle 拉全后再决策；此时 count 只表示已明确看到的
			// 他人消息数，可能为 0，调用方不得把 0 表述为精确数量。
			shouldBlock: otherUnseen.length > 0 || (!exact && containsSelf),
			count: otherUnseen.length,
			exact,
		};
	}

	/**
	 * 自身公共消息回显过滤。只有 preview 完整覆盖 cursor 后的连续窗口，且窗口内
	 * 全部消息均由自己发送时才跳过；preview 有缺口时仍拉取，避免漏掉被截出窗口
	 * 的他人消息。
	 */
	private classifySelfPreview(
		message: Extract<ServerMessage, { method: "group_chat_update" }>,
		cursor: number,
	): "complete-self-only" | "incomplete-with-self" | "external" {
		const unseen = message.params.preview_messages
			.filter((preview) => preview.params.sequence > cursor)
			.sort((a, b) => a.params.sequence - b.params.sequence);
		const expectedCount = message.params.latest_sequence - cursor;
		if (unseen.length !== expectedCount) {
			return unseen.some(
				(preview) =>
					preview.params.sender.type === "character" &&
					preview.params.sender.character_id === this.runtime.character.characterId,
			)
				? "incomplete-with-self"
				: "external";
		}
		return unseen.every(
			(preview, index) =>
				preview.params.sequence === cursor + index + 1 &&
				preview.params.sender.type === "character" &&
				preview.params.sender.character_id === this.runtime.character.characterId,
		)
			? "complete-self-only"
			: "external";
	}

	private resetJoinDebounce(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceDueAt = Date.now() + JOIN_BATCH_DEBOUNCE_MS;
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.debounceDueAt = null;
			void this.flush();
		}, JOIN_BATCH_DEBOUNCE_MS);
	}

	private clearDebounce(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
			this.debounceDueAt = null;
		}
	}

	/**
	 * ISSUE-013 B3：从外部标记增量标记（A2）——stale 被拒的 speak 希望错过的
	 * 增量在当前 run settle 后经统一管线投递。无新机制：settle 钩子拉取一次，
	 * 覆盖光标之后的所有内容。
	 */
	markIncrementPending(): void {
		if (this.stopped) {
			return;
		}
		this.incrementPending = true;
	}

	/**
	 * 向 agent 上下文投递一批事件。无参数时投递待处理窗口。ISSUE-038（口径
	 * A）：通道在状态拉取之后与发送同微任务原子决定——Agent 运行中事件经
	 * steer 通道（下一个工具调用间隙可见，秒级而非分钟级；绝不打断 run，
	 * M7 A5 保持）；若拉取期间 run 已 settle，则走 idle 路径
	 * （followUp + triggerTurn + 群聊标记），批次仍能唤醒 agent
	 * （Arch settle 竞态修复）。
	 */
	private async flush(events?: ServerMessage[], latestSequence?: number): Promise<void> {
		const toDeliver = events ?? this.pendingEvents;
		if (events === undefined) {
			this.pendingEvents = [];
		}

		if (toDeliver.length === 0 || this.stopped) return;

		let groupChatState: unknown = null;
		try {
			groupChatState = await this.runtime.getGroupChatState();
		} catch (e) {}

		if (this.stopped) return;

		// Arch settle 竞态修复：在 await 之后、与发送同一微任务内重查
		// isAgentActive。若拉取状态期间 run 已 settle，pi 不再 streaming——
		// steer 只会 append 而不唤醒（idle 时 triggerTurn 被忽略）。回退到
		// idle 路径，批次开启群聊触发的 turn（marker 按 #14 正确点亮
		// is_streaming）。
		if (this.runtime.isAgentActive) {
			await this.deliverSteer(toDeliver, groupChatState, latestSequence);
			return;
		}

		// 向 agent 上下文投递一批事件（#77：run 活跃即亮，投递不再设置
		// 群聊触发标记——语义 = 「正在工作」，agent_start 无条件点亮）。

		const content = this.buildContent(toDeliver, groupChatState);

		if (process.env.PITAVERN_TEST === "1") {
			// M7 A6 观察通道：经 notify 重发已投递增量，验收套件可断言到达
			// agent 上下文的内容与通知源一致（同一数据）。
			const sequences = toDeliver
				.filter((e) => "method" in e && e.method === METHOD_PUBLIC_MESSAGE)
				.map((e) => e.params.sequence)
				.sort((a, b) => a - b);
			if (sequences.length > 0) {
				testNotify?.(
					`[tavern-inject] group=${this.runtime.groupChatId} latest_seq=${sequences[sequences.length - 1]} count=${sequences.length}`,
				);
			}
			// 白板模型（#114）：白板更新事件计数（无 sequence——不在消息流）。
			// 断言：门闸放行（进批处理）→ 白板桶渲染可达。
			const boardUpdates = toDeliver.filter((e) => "method" in e && e.method === METHOD_BOARD_UPDATE).length;
			if (boardUpdates > 0) {
				testNotify?.(`[tavern-inject] group=${this.runtime.groupChatId} board_updates=${boardUpdates}`);
			}
		}

		// 投递承诺（Arch 竞态审计形状）：入队接受（preflightResult）即 resolve——
		// pi SDK 的 sendMessage 在 run 结束后才 resolve（prompt() 内部 await 链），
		// await 它会锁死单飞行锁；saveCursor 在 preflightResult 内同步执行，
		// 承诺 resolve 时游标已推进（do-while 复查读新游标，不重投）。
		await this.sendWithDeliveryAck(toDeliver, content, groupChatState, latestSequence, "followUp");
	}

	/**
	 * 统一投递 + 游标双通道判定（Arch 契约 2026-08-02）：sendMessage 挂
	 * preflightResult 回调——入队接受（true）即推进游标并 resolve 短承诺；
	 * 拒绝/抛错不推进（settle 兜底重投）且同样 resolve（防飞行锁挂死）。
	 * 不 await sendMessage 全量完成（pi SDK：run 结束后才 resolve）。
	 */
	private async sendWithDeliveryAck(
		events: ServerMessage[],
		content: string,
		groupChatState: unknown,
		latestSequence: number | undefined,
		deliverAs: "followUp" | "steer",
	): Promise<void> {
		try {
			// 方案 A（Arch 裁决 2026-08-02）：乐观推进——sendMessage 调用后
			// 同步 saveCursor，不 await（await 会持有单飞行锁整个 run 时长，
			// 忙态秒级可见在连续对话主场景退化回 run 边界——PM 矛盾实证）。
			// 忙态 steer/followUp = agent.steer/followUp 同步入队无失败返回
			// （QA 实证）；idle triggerTurn 的异步 run 启动失败 = pi 环境
			// 不可用例外（与改造前语义一致、与 wedged 同类，QA 钉注明）。
			// T2 竞态由调用方 await deliver 闭合（同步推进后 do-while 复查
			// 读新游标）。
			this.pi.sendMessage(
				{
					customType: "pi-tavern.group-chat-input",
					content,
					display: true,
					details: {
						group_chat_id: this.runtime.groupChatId,
						character_id: this.runtime.character.characterId,
						events,
						group_chat_state: groupChatState,
					},
				},
				{ triggerTurn: true, deliverAs },
			);
			if (latestSequence !== undefined) {
				this.runtime.saveCursor(latestSequence);
			}
		} catch {
			// 同步抛错（入队拒绝）：不推进 → settle 兜底重投（A5 保持）。
		}
	}

	/**
	 * ISSUE-038 口径 A：run 活跃时经 pi 的 steer 通道向 agent 上下文投递事件。
	 * steer 语义（pi agent-session）：当前 assistant turn 完成其工具调用后、
	 * 下一次 LLM 调用前投递——即工具调用间隙，长工具循环下秒级而非分钟级，
	 * 且绝不打断 run。
	 *
	 * triggerTurn:true —— Arch 滞留救援：pi 在 streaming 时忽略 triggerTurn
	 * （steer 照常入队），但若 isAgentActive 陈旧（agent_settled 永不到达的
	 * wedged run，#14 watchdog 场景），投递仍能唤醒 agent，而非被静默 append。
	 * #77：run 活跃即亮（agent_start 无条件点亮），steer 投递不再涉及点亮判定
	 * ——投递内容（群聊/救援）不区分触发源（User 2026-08-03 拍板）。
	 */
	private async deliverSteer(events: ServerMessage[], groupChatState: unknown, latestSequence?: number): Promise<void> {
		const content = this.buildContent(events, groupChatState);

		if (process.env.PITAVERN_TEST === "1") {
			// M7 A6 观察通道（与 idle flush 相同）：验收中断言 steer 投递的
			// 增量已到达 agent 上下文。
			const sequences = events
				.filter((e) => "method" in e && e.method === METHOD_PUBLIC_MESSAGE)
				.map((e) => e.params.sequence)
				.sort((a, b) => a - b);
			if (sequences.length > 0) {
				testNotify?.(
					`[tavern-inject] group=${this.runtime.groupChatId} latest_seq=${sequences[sequences.length - 1]} count=${sequences.length}`,
				);
			}
			// 白板模型（#114）：白板更新事件计数（与 idle flush 同通道）。
			const boardUpdates = events.filter((e) => "method" in e && e.method === METHOD_BOARD_UPDATE).length;
			if (boardUpdates > 0) {
				testNotify?.(`[tavern-inject] group=${this.runtime.groupChatId} board_updates=${boardUpdates}`);
			}
		}

		await this.sendWithDeliveryAck(events, content, groupChatState, latestSequence, "steer");
	}

	private buildContent(events: ServerMessage[], state: unknown): string {
		const parts: string[] = ["PiTavern 群聊环境更新"];

		// #104：注入时点统一基准（Arch 评审 B 级观察）——头部当前时间与
		// 每条消息间隔共用同一 now，避免毫秒级基准漂移。
		const now = new Date();
		parts.push(`\n当前时间：${formatDateTime(now)}`);

		// 身份锚（ISSUE-003 三字段契约，cab1fd7）：始终声明本会话是哪个
		// Character，模型无需从上下文或可用技能猜测自己的身份。格式：
		// 你的当前角色：<persona 名>（character_id=<characterId>，注册名=<name>）
		const identity =
			`你的当前角色：${this.runtime.character.name}` +
			`（character_id=${this.runtime.character.characterId}，注册名=${this.runtime.character.name}）`;
		parts.push(`\n${identity}`);

		if (process.env.PITAVERN_TEST === "1") {
			// 验收套件的观察通道（RPC 模式把 notify 呈现为 extension_ui_request；
			// 参见 identity-consistency.test.ts）
			testNotify?.(`[tavern-test-injection] ${identity}`);
		}

		// 群聊名
		const stateObj = state as {
			group_chat?: { name?: string | null };
			round?: { round_max_messages: number; used_messages: number; remaining_messages: number };
			online_characters?: Array<{ character_id?: string; name: string }>;
		} | null;
		const name = stateObj?.group_chat?.name;
		if (name) {
			parts.push(`\n群聊：${name}`);
		}

		// 新消息
		const messages = events.filter(
			(e) => "method" in e && (e.method === METHOD_PUBLIC_MESSAGE || e.method === METHOD_MESSAGE_HISTORY),
		);
		if (messages.length > 0) {
			parts.push("\n新消息：");
			for (const message of messages) {
				if ("method" in message && message.method === METHOD_PUBLIC_MESSAGE) {
					const sender = message.params.sender.type === "user_persona" ? "User Persona" : message.params.sender.name;
					// #104：每条消息带发言时间 + 距当前注入时点的间隔（相对时间）。
					// timestamp 为 ISO 字符串（creator 侧 toISOString 填充），
					// 解析失败时静默降级为不带时间渲染，不阻塞消息展示。
					const when = formatMessageTime(message.params.timestamp, now);
					parts.push(
						when ? `${sender}（${when}）:\n${message.params.content}` : `${sender}:\n${message.params.content}`,
					);
				}
			}
		}

		// 成员变化
		const memberChanges = events.filter(
			(e) => "method" in e && (e.method === METHOD_CHARACTER_JOINED || e.method === METHOD_CHARACTER_LEFT),
		);
		if (memberChanges.length > 0) {
			parts.push("\n成员变化：");
			for (const event of memberChanges) {
				if ("method" in event && event.method === METHOD_CHARACTER_JOINED) {
					parts.push(`${event.params.character.name} 加入了群聊。`);
				} else if ("method" in event && event.method === METHOD_CHARACTER_LEFT) {
					parts.push(`${event.params.character.name} 离开了群聊。`);
				}
			}
		}

		// 白板更新（#114，ADR-0007）：增量摘要——谁/动作/内容摘要。与
		// group_chat_update 是两套消费语义（通知渲染 vs 拉取触发）：board_update
		// 只渲染不进消息流拉取（无 sequence、不挂 incrementPending）。
		const boardUpdates = events.filter((e) => "method" in e && e.method === METHOD_BOARD_UPDATE);
		if (boardUpdates.length > 0) {
			parts.push("\n白板更新：");
			const onlineCharacters = stateObj?.online_characters ?? [];
			for (const event of boardUpdates) {
				if (!("method" in event) || event.method !== METHOD_BOARD_UPDATE) {
					continue;
				}
				const actor = onlineCharacters.find((c) => c.character_id === event.params.actor)?.name ?? event.params.actor;
				if (event.params.action === "clear") {
					parts.push(`${actor} 清空白板。`);
				} else if (
					event.params.action === "add" ||
					event.params.action === "update" ||
					event.params.action === "remove"
				) {
					const verb = event.params.action === "add" ? "贴条" : event.params.action === "update" ? "改条" : "撕条";
					parts.push(`${actor} ${verb}：「${event.params.note?.content ?? ""}」`);
				}
			}
		}

		// 当前状态
		const round = stateObj?.round;
		if (round) {
			parts.push("\n当前状态：");
			const onlineChars = stateObj?.online_characters?.map((c) => c.name).join("、");
			if (onlineChars) {
				parts.push(`- 在线 Character：${onlineChars}`);
			}
			parts.push(`- Round 发言次数：${round.used_messages} / ${round.round_max_messages}`);
			parts.push(`- 剩余发言次数：${round.remaining_messages}`);
		}

		parts.push(
			"\n请根据这些群聊变化继续当前工作。",
			"如果需要公开回复，请调用 tavern_speak；",
			"普通回复不会自动进入群聊。",
			"公开回复应简洁，通常不超过 2000 个字符；",
			"较长的完整分析应保留在当前私有 pi session，",
			"只向群聊发布结论、关键理由和需要其他成员知道的信息。",
		);

		return parts.join("\n");
	}
}

/**
 * #104：格式化注入时点，用于环境文本头部「当前时间」行。
 * 本地时区 `YYYY-MM-DD HH:MM:SS`（与消息发言时间的 HH:MM 粒度区分，
 * 秒级让 agent 感知更精确的“现在”）。
 */
function formatDateTime(date: Date): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
		`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
	);
}

/**
 * #104：格式化消息发言时间 + 距当前注入时点的间隔（相对时间）。
 * 返回 `YYYY-MM-DD HH:MM（x 分钟前 / x 秒前）`；timestamp 缺失或非法时
 * 返回 null（调用方降级为不带时间渲染）。<60s 显示秒级，否则分钟级。
 */
function formatMessageTime(timestamp: string | undefined, now: Date): string | null {
	if (timestamp === undefined) {
		return null;
	}
	const parsed = new Date(timestamp);
	if (Number.isNaN(parsed.getTime())) {
		return null;
	}
	const pad = (n: number): string => String(n).padStart(2, "0");
	const at =
		`${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ` +
		`${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
	const elapsedMs = now.getTime() - parsed.getTime();
	const elapsedSec = Math.max(0, Math.floor(elapsedMs / 1000));
	const ago = elapsedSec < 60 ? `${elapsedSec} 秒前` : `${Math.floor(elapsedSec / 60)} 分钟前`;
	return `${at}（${ago}）`;
}
