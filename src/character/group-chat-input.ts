import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "../protocol/messages.js";
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
}

/**
 * M7（ISSUE-012/#24）：非 update 事件（join 历史、成员变化）后提交环境批次
 * 前的等待时长。旧的 1s 后沿 debounce 已从 group_chat_update 移除——update
 * 立即拉取——但成员/历史批次仍短暂合并，避免一次 join 拆成多次输入。
 */
const JOIN_BATCH_DEBOUNCE_MS = 1000;

export class GroupChatInput {
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private debounceDueAt: number | null = null;
	/**
	 * ISSUE-013 A1/A2：待投递窗口。持有 join/成员事件（经 debounce 合并，避免
	 * join 拆散）以及因 Agent turn 运行中而等待的增量。空闲期间公开消息增量
	 * 不会在此累积——它们被立即拉取并投递（A1）。
	 */
	private pendingEvents: ServerMessage[] = [];
	private handler: ((message: ServerMessage) => void) | undefined;
	private stopped = false;
	/** 单飞行锁：最多同时一个 fetch_messages_since 在途。 */
	private fetchInFlight = false;
	/** 拉取在途时有新 update 到达 → 之后补拉一次。 */
	private refetchRequested = false;
	/** Agent 运行中时有 update 到达（settle 时补拉尾部窗口）。 */
	private incrementPending = false;

	constructor(
		private readonly runtime: CharacterRuntime,
		private readonly pi: ExtensionAPI,
	) {
		// ISSUE-038（口径 A + steer）：run 不再阻塞投递。运行中到达的 update
		// 被拉取后经 steer 通道在工具调用间隙投递（秒级延迟，绝不打断 run——
		// M7 A5 保持）。settle 钩子对最后一次运行中投递之后到达的内容补拉一次；
		// 光标在每次投递时推进，因此 settle 补拉从已投递消息之后开始
		// （单调不重不漏，光标单点推进）。
		this.onSettled = () => {
			if (this.stopped) {
				return;
			}
			if (this.incrementPending) {
				this.incrementPending = false;
				void this.pullIncrement();
			}
		};
	}

	private readonly onSettled: () => void;

	start(): void {
		this.handler = (message: ServerMessage) => {
			if (message.type === "message_history" && Array.isArray(message.messages)) {
				// join 时快照：展开为单个 public_message 事件。
				// ISSUE-008：has_more 时通过 cursor 分页剩余历史，避免丢失更早消息。
				// M7：持久化光标优先——回归的 character 从上次投递位置差量同步，
				// 而不是重读历史。
				const before = this.pendingEvents.length;
				for (const m of message.messages) {
					if (m && typeof m === "object" && "type" in m && m.type === "public_message") {
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
				if (message.has_more) {
					this.pageOlderHistory(message.cursor).catch(() => undefined);
				}
				return;
			}
			if (message.type === "group_chat_update") {
				// M7：通知 → 立即增量拉取（无 debounce）。
				// ISSUE-013 A1：拉取结果立即投递（无批次累积）；preview 仅供 TUI
				// （同一数据源，内容不会分叉）。
				// ISSUE-014/#14（方案 A）：成员/流式变化也走此通道——刷新缓存快照，
				// 即使拉取结果为空 widget 也保持最新。
				// ISSUE-038（口径 A）：运行中 update 拉取后立即经 steer 投递；
				// 标记让 settle 钩子补拉最后一次 steer 投递之后的尾部窗口
				// （光标单调，无重复）。
				if (this.runtime.isAgentActive) {
					this.incrementPending = true;
				}
				void this.runtime.refreshGroupChatState();
				void this.pullIncrement();
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
	 * M7 + ISSUE-013 A1/A2 + ISSUE-038：拉取持久化光标之后的所有消息并立即
	 * 投递——中间无批次累积。
	 *
	 * 单飞行：并发的 update 只标记 refetchRequested，合并为一次后续拉取。
	 * ISSUE-038（口径 A）：Agent 运行中不再延迟拉取——update 被拉取后经 steer
	 * 通道在工具调用间隙投递（秒级可见，绝不打断 run）；settle 钩子对尾部
	 * 窗口补拉一次。
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
					if (m && typeof m === "object" && "type" in m && m.type === "public_message") {
						if (!this.isEnvironmentEvent(m as ServerMessage)) continue;
						messages.push(m as ServerMessage);
					}
				}
				if (messages.length > 0) {
					// 光标仅在增量到达上下文时推进
					// （A5：投递失败不得移动光标）。
					this.runtime.saveCursor(page.latestSequence);
					this.deliver(messages);
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
	 * ISSUE-013 A1/A2 + ISSUE-038：统一投递窗口。将增量与待处理的 join/成员
	 * 事件合并，保证顺序（事件先到，消息更新）。Agent 运行中事件经 steer
	 * 通道投递（口径 A）——在下一个工具调用间隙可见，绝不打断 run。
	 */
	private deliver(messages: ServerMessage[]): void {
		if (this.stopped) {
			return;
		}
		const events = [...this.pendingEvents, ...messages];
		this.pendingEvents = [];
		if (events.length === 0) {
			return;
		}
		void this.flush(events);
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
					if (m && typeof m === "object" && "type" in m && m.type === "public_message") {
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
		this.pendingEvents = [];
	}

	/**
	 * 捕获未 flush 的环境事件与 debounce 截止时间，供 reload 交接。
	 * 快照恰好被新 runtime 消费一次。
	 */
	snapshotForReload(): GroupChatInputReloadSnapshot {
		return {
			pendingEvents: [...this.pendingEvents],
			debounceDueAt: this.debounceDueAt,
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
	}

	hasPendingBatch(): boolean {
		return this.debounceTimer !== null;
	}

	private isEnvironmentEvent(message: ServerMessage): boolean {
		switch (message.type) {
			case "public_message":
				return !this.isOwnEcho(message);
			case "character_joined":
			case "character_left":
				return this.runtime.hasPublicMessages;
			case "message_history":
				return true;
			default:
				return false;
		}
	}

	private isOwnEcho(message: ServerMessage & { type: "public_message" }): boolean {
		return message.sender.type === "character" && message.sender.character_id === this.runtime.character.characterId;
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
	private async flush(events?: ServerMessage[]): Promise<void> {
		const toDeliver = events ?? this.pendingEvents;
		if (events === undefined) {
			this.pendingEvents = [];
		}

		if (toDeliver.length === 0 || this.stopped) return;

		let groupChatState: unknown = null;
		try {
			groupChatState = await this.runtime.getGroupChatState();
		} catch {
			// 状态拉取失败也照常投递
		}

		if (this.stopped) return;

		// Arch settle 竞态修复：在 await 之后、与发送同一微任务内重查
		// isAgentActive。若拉取状态期间 run 已 settle，pi 不再 streaming——
		// steer 只会 append 而不唤醒（idle 时 triggerTurn 被忽略）。回退到
		// idle 路径，批次开启群聊触发的 turn（marker 按 #14 正确点亮
		// is_streaming）。
		if (this.runtime.isAgentActive) {
			await this.deliverSteer(toDeliver, groupChatState);
			return;
		}

		// ISSUE-014/#14-A1：本次投递开启一个群聊触发的 turn。
		// agent_start 消费该标记，仅群聊 turn 点亮 is_streaming
		// （用户直聊 turn 保持暗）。
		this.runtime.markGroupChatTurnTriggered();

		const content = this.buildContent(toDeliver, groupChatState);

		if (process.env.PITAVERN_TEST === "1") {
			// M7 A6 观察通道：经 notify 重发已投递增量，验收套件可断言到达
			// agent 上下文的内容与通知源一致（同一数据）。
			const sequences = toDeliver
				.filter((e) => e.type === "public_message")
				.map((e) => e.sequence)
				.sort((a, b) => a - b);
			if (sequences.length > 0) {
				testNotify?.(
					`[tavern-inject] group=${this.runtime.groupChatId} latest_seq=${sequences[sequences.length - 1]} count=${sequences.length}`,
				);
			}
		}

		this.pi.sendMessage(
			{
				customType: "pi-tavern.group-chat-input",
				content,
				display: true,
				details: {
					group_chat_id: this.runtime.groupChatId,
					character_id: this.runtime.character.characterId,
					events: toDeliver,
					group_chat_state: groupChatState,
				},
			},
			{
				triggerTurn: true,
				deliverAs: "followUp",
			},
		);
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
	 * 代价：救援 run 无群聊标记，is_streaming 保持暗（已文档化，ADR-0004）。
	 * 这里不调用 markGroupChatTurnTriggered——steer 不得点亮 is_streaming
	 * （#14 边界，QA T3）。
	 */
	private async deliverSteer(events: ServerMessage[], groupChatState: unknown): Promise<void> {
		const content = this.buildContent(events, groupChatState);

		if (process.env.PITAVERN_TEST === "1") {
			// M7 A6 观察通道（与 idle flush 相同）：验收中断言 steer 投递的
			// 增量已到达 agent 上下文。
			const sequences = events
				.filter((e) => e.type === "public_message")
				.map((e) => e.sequence)
				.sort((a, b) => a - b);
			if (sequences.length > 0) {
				testNotify?.(
					`[tavern-inject] group=${this.runtime.groupChatId} latest_seq=${sequences[sequences.length - 1]} count=${sequences.length}`,
				);
			}
		}

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
			{
				triggerTurn: true,
				deliverAs: "steer",
			},
		);
	}

	private buildContent(events: ServerMessage[], state: unknown): string {
		const parts: string[] = ["PiTavern 群聊环境更新"];

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
			online_characters?: Array<{ name: string }>;
		} | null;
		const name = stateObj?.group_chat?.name;
		if (name) {
			parts.push(`\n群聊：${name}`);
		}

		// 新消息
		const messages = events.filter((e) => e.type === "public_message" || e.type === "message_history");
		if (messages.length > 0) {
			parts.push("\n新消息：");
			for (const message of messages) {
				if (message.type === "public_message") {
					const sender = message.sender.type === "user_persona" ? "User Persona" : message.sender.name;
					parts.push(`${sender}:\n${message.content}`);
				}
			}
		}

		// 成员变化
		const memberChanges = events.filter((e) => e.type === "character_joined" || e.type === "character_left");
		if (memberChanges.length > 0) {
			parts.push("\n成员变化：");
			for (const event of memberChanges) {
				if (event.type === "character_joined") {
					parts.push(`${event.character.name} 加入了群聊。`);
				} else if (event.type === "character_left") {
					parts.push(`${event.character.name} 离开了群聊。`);
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
