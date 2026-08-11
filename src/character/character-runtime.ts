import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMessageConnection, type MessageConnection, ResponseError } from "vscode-jsonrpc";
import WebSocket from "ws";

import { type CharacterCard, loadCharacterCard } from "../config/character-card.js";
import { loadTavernConfig, type TavernConfig } from "../config/load-config.js";
import type { MessageTemplateKey } from "../config/message-templates.js";
import {
	type BufferedFrame,
	type CharacterJsonRpcTransfer,
	type CharacterReloadHandoff,
	getReloadHandoffRegistry,
} from "../controller/reload-handoff-registry.js";
import { readCursorFile, writeCursorFile } from "../data/cursor-store.js";
import { decodeServerMessage, encodeMessage, MAX_WEBSOCKET_FRAME_BYTES } from "../protocol/codec.js";
import {
	type BoardNoteWire,
	type BoardWriteDataWire,
	type GroupChatStateMessage,
	JSONRPC_VERSION,
	type ServerMessage,
} from "../protocol/messages.js";
import { WebSocketMessageReader, WebSocketMessageWriter } from "../protocol/ws-message-io.js";
import {
	HEARTBEAT_PING_INTERVAL_MS,
	HEARTBEAT_TIMEOUT_MS,
	SHORT_COORDINATION_TIMEOUT_MS,
} from "../shared/constants.js";
import {
	ERROR_BINARY_FRAME_RECEIVED,
	ERROR_CHARACTER_RUNTIME_DETACHED,
	ERROR_CHARACTER_RUNTIME_NOT_ACTIVE,
	ERROR_CONNECTION_CLOSED,
	ERROR_CONNECTION_CLOSED_DURING_RELOAD,
	ERROR_CONNECTION_HAS_BEEN_CLOSED,
	ERROR_CONNECTION_NOT_OPEN,
	ERROR_FRAME_TOO_LARGE,
	ERROR_HEARTBEAT_TIMEOUT,
	ERROR_REQUEST_TIMED_OUT,
	ERROR_RUNTIME_ALREADY_ACTIVATED_OR_DISPOSED,
	ERROR_UNEXPECTED_BOARD_QUERY_RESPONSE,
	ERROR_UNEXPECTED_BOARD_WRITE_RESPONSE,
	ERROR_UNEXPECTED_FETCH_RESPONSE,
	ERROR_UNEXPECTED_HISTORY_RESPONSE,
	ERROR_UNEXPECTED_SPEAK_RESPONSE,
	ERROR_UNEXPECTED_STATE_RESPONSE,
	ERROR_UNEXPECTED_WHISPER_RESPONSE,
	METHOD_BOARD_QUERY,
	METHOD_BOARD_WRITE,
	METHOD_FETCH_MESSAGES_SINCE,
	METHOD_GET_GROUP_CHAT_STATE,
	METHOD_GET_MESSAGE_HISTORY,
	METHOD_GROUP_CHAT_CLOSED,
	METHOD_GROUP_CHAT_UPDATE,
	METHOD_LEAVE_GROUP_CHAT,
	METHOD_MESSAGE_HISTORY,
	METHOD_PUBLIC_MESSAGE,
	METHOD_SPEAK,
	METHOD_UPDATE_CHARACTER_STATE,
	METHOD_WHISPER,
} from "../shared/messages.js";
import { GroupChatInput } from "./group-chat-input.js";
import { CHARACTER_REQUEST_TYPES } from "./request-types.js";
import { PENDING_RESPONSE_REJECTED_CODE, validateResult } from "./response-gate.js";

export interface CharacterConnectionTransfer {
	socket: WebSocket;
	bufferedMessages: ServerMessage[];
	/** 可选：JoinAttempt 握手连接移交（缺省 = 测试直构/兼容路径，attach 新建）。 */
	jsonrpc?: CharacterJsonRpcTransfer;
}

interface PrepareCharacterRuntimeOptions {
	groupChatId: string;
	sessionId: string;
	character: CharacterCard;
	requestTimeoutMs?: number;
	onDisconnected?: () => void;
	/** 心跳检查间隔（默认 30s）。 */
	heartbeatIntervalMs?: number;
	/** creator ping 超时阈值（默认 120s）；超时 → 终止连接。 */
	heartbeatTimeoutMs?: number;
	/**
	 * M7 (ISSUE-012/#24)：群聊级游标文件绝对路径
	 * （“最后一条成功投递的消息序号”），跨重启持久化。
	 * 缺省 → 增量拉取关闭（仅历史模式）。
	 */
	cursorStorePath?: string;
	/**
	 * #66: run wedged watchdog 超时（agent_start 布防、agent_settled 清除；
	 * 超时 → 强制 settle，恢复增量投递）。默认 180s（3min，产品参数 PM 定值）；
	 * 测试可注入短值（QA 红钉 1/2 窗口用）。
	 */
	agentWedgedTimeoutMs?: number;
	/** 闲态触发窗口（Arch 提速项，注入化；undefined = 默认 1000ms）。 */
	triggerDebounceMs?: number;
	/**
	 * #138：增量拉取上下文窗口 getter（getter 闭包注入，每轮拉取实时取值，
	 * 非快照）。拉取起点前移至 max(0, cursor - window)——额外 N 条已读上下文
	 * 不更新游标、不污染未读语义。缺省 undefined → 窗口 0（行为不变）；
	 * 生产接线 = 客户端域组合根注入 getFetchContextWindow（默认 1）。
	 */
	getFetchContextWindow?: () => number;
	/** #154：群聊文案模板集（缺省 undefined → 消费面回落 DEFAULT_TEMPLATES）。 */
	messageTemplates?: Record<MessageTemplateKey, string>;
	/** #154 复评：reload 时重新加载磁盘配置所需路径（可选；无则 reload 沿用快照）。 */
	agentDir?: string;
	cwd?: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = SHORT_COORDINATION_TIMEOUT_MS;

/** #66 产品参数（PM/User 定值 2026-08-02）：run wedged 判定阈值，默认 3 分钟。 */
const DEFAULT_AGENT_WEDGED_TIMEOUT_MS = 180_000;

/**
 * ISSUE-013 B5：每轮自动 stale 恢复拉取的上限。超过预算后 speak 工具
 * 直接上报拒绝而不再自动拉取，防止消息洪泛让 agent 在拒绝与重发之间
 * 死循环。
 */
const MAX_STALE_AUTO_RECOVERIES = 2;

export class CharacterRuntime {
	readonly groupChatId: string;
	readonly sessionId: string;
	readonly character: CharacterCard;
	readonly receivedMessages: ServerMessage[] = [];
	onEnvironmentMessage: ((message: ServerMessage) => void) | undefined;
	/** 最新群聊状态快照（缓存供只读 TUI 投影）。 */
	lastGroupChatState: GroupChatStateMessage | null = null;
	/**
	 * ISSUE-014/#14：agent_end 看门狗——若 agent_settled 迟迟不到则把
	 * is_streaming 复位（被中止/报错的 run 不能一直挂着“正在发言”灯）。
	 * agent_settled 清除；reload 经 activateFromHandoff 的显式 false 重发重新布防。
	 */
	private streamingResetWatchdog: NodeJS.Timeout | null = null;
	/**
	 * #66: run wedged watchdog——agent_start 布防、agent_settled 清除。覆盖双
	 * wedged 窗口（Arch 2026-08-02）：① agent_start 后无 agent_end（完全卡死）
	 * ② agent_end 已到但 agent_settled 永不到（#14 只复位 is_streaming，不碰
	 * isAgentActive——② 为真洞）。v2 = #14 超集；超时 → 强制 settle（同路径
	 * 幂等：isAgentActive=false + 冲刷排队增量，incrementPending 防重入）。
	 */
	private runWedgedWatchdog: NodeJS.Timeout | null = null;
	private readonly agentWedgedTimeoutMs: number;
	/** 闲态触发窗口（Arch 提速项，注入化；undefined = 默认 1000ms）。 */
	private readonly triggerDebounceMs: number | undefined;
	/** #138：增量拉取上下文窗口 getter（undefined → 窗口 0，行为不变）。 */
	private readonly getFetchContextWindow: (() => number) | undefined;
	readonly messageTemplates: Record<MessageTemplateKey, string> | undefined;
	/** #154 复评：reload 重载磁盘配置所需路径（join 时透传；undefined = 不重载）。 */
	private readonly agentDir: string | undefined;
	private readonly cwd: string | undefined;
	/** 新鲜状态快照到达后触发（TUI 刷新钩子）。 */
	onStateSnapshot: ((snapshot: GroupChatStateMessage) => void) | undefined;
	/**
	 * M7 (ISSUE-012/#24)：pi Agent 运行中（agent_start 已触发、agent_settled
	 * 未到）为 true。GroupChatInput 在活跃期间排队增量、run 一 settle 立即
	 * 冲刷，拉取永远不会打断当前 run。
	 */
	isAgentActive = false;
	/**
	 * Agent run settle（agent_settled）后触发，供排队输入冲刷。
	 * #66：wedged 强制收敛后（wedgedSettled=true）getter 返回 undefined——迟到的
	 * 真实 settle 经 onAgentSettled?.() 路径幂等跳过，不重复冲刷。
	 */
	private _onAgentSettled: (() => void) | undefined;
	get onAgentSettled(): (() => void) | undefined {
		if (this.wedgedSettled) {
			return undefined;
		}
		return this._onAgentSettled;
	}
	set onAgentSettled(callback: (() => void) | undefined) {
		this._onAgentSettled = callback;
	}
	/** #66：run wedged 强制收敛已执行标记（下一 run agent_start 时重置）。 */
	private wedgedSettled = false;
	groupChatInput: GroupChatInput | undefined;

	private socket: WebSocket | null = null;
	/** #119 connection 接线：per-socket JSON-RPC 连接（响应关联/超时取消由库承担）。
	 * 连接实例跨 owner 延续（JoinAttempt → runtime → reload 新 runtime），
	 * 断线终态才 dispose。 */
	private jsonrpcConnection: MessageConnection | null = null;
	/** reader 引用：响应帧 deliver 喂入 connection。 */
	private jsonrpcReader: WebSocketMessageReader | null = null;
	/** writer 引用：跨 handoff 延续时重设请求登记回调到新 owner。 */
	private jsonrpcWriter: WebSocketMessageWriter | null = null;
	/** 断线原因（request() 映射库 dispose 拒绝码 -32097 → 以断线原因 reject）。 */
	private disconnectError: Error | undefined;
	/** 在途请求登记（detach 显式取消用：clearTimeout + reject——三轮评审阻断⑨：
	 * 旧 owner 的 timer 不得在移交后点火，否则 failConnection → finishDisconnected
	 * 会 dispose 新 runtime 正在使用的共享 connection）。 */
	private readonly inflightRequests = new Set<{ timer: NodeJS.Timeout; reject: (error: Error) => void }>();
	private readonly requestTimeoutMs: number;
	private readonly onDisconnected: (() => void) | undefined;
	private readonly heartbeatIntervalMs: number;
	private readonly heartbeatTimeoutMs: number;
	private readonly cursorStorePath: string | undefined;
	private cursorSequence: number | null = null;
	/**
	 * P1-4 方案 a：ready 响应携带的进入时刻水位（latest_sequence）。
	 * 新帧有值 → 游标预置直接用（精确锚点，误差窗口归零）；旧帧 null →
	 * 回退查询预置（双路径兼容旧服务端）。只读快照语义（join 时写入，
	 * 值传豁免）。
	 */
	readyLatestSequence: number | null = null;

	/**
	 * ISSUE-013 B5：每轮 stale 自动恢复预算。按每次 speak 响应带回的轮次
	 * 快照跟踪；轮次变化（新轮或他人发布）时 key 变化即重置预算。超过预算后
	 * 客户端不再标记 A2 注入，而是上报拒绝供人工重新决策。
	 */
	private staleRecoveryKey: string | null = null;
	private staleRecoveryCount = 0;
	/**
	 * #128：speak 被「未读先读」阻止后置位（首拒已 markIncrementPending）。
	 * 游标追平后下次 speak 判定通过即复位；置位期间重复 speak 只返回短告知，
	 * 不重复标记（风暴场景防刷）。
	 */
	private unreadBlockNotified = false;
	private closePromise: Promise<void> | null = null;
	private disconnected = false;
	private lastPingAt = 0;
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private lifecycle: "active" | "detaching" | "disposed" = "active";
	private bufferingHandlers: { message: (data: WebSocket.RawData) => void; close: () => void } | null = null;

	private readonly onPing = (): void => {
		this.lastPingAt = Date.now();
	};

	private readonly onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
		this.handleIncomingData(data, isBinary);
	};

	private handleIncomingData(data: WebSocket.RawData, isBinary: boolean): void {
		if (isBinary) {
			this.failConnection(new Error(ERROR_BINARY_FRAME_RECEIVED));
			return;
		}
		let message: ServerMessage;
		try {
			message = decodeServerMessage(data);
		} catch (error) {
			this.failConnection(asError(error));
			return;
		}
		this.handleServerMessage(message);
	}

	private readonly onClose = (): void => {
		this.finishDisconnected(new Error(ERROR_CONNECTION_CLOSED));
	};

	private readonly onError = (): void => undefined;

	private constructor(options: PrepareCharacterRuntimeOptions) {
		this.groupChatId = options.groupChatId;
		this.sessionId = options.sessionId;
		this.character = options.character;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.onDisconnected = options.onDisconnected;
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_PING_INTERVAL_MS;
		this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
		this.cursorStorePath = options.cursorStorePath;
		this.agentWedgedTimeoutMs = options.agentWedgedTimeoutMs ?? DEFAULT_AGENT_WEDGED_TIMEOUT_MS;
		this.triggerDebounceMs = options.triggerDebounceMs;
		this.getFetchContextWindow = options.getFetchContextWindow;
		this.messageTemplates = options.messageTemplates;
		this.agentDir = options.agentDir;
		this.cwd = options.cwd;
	}

	static prepare(options: PrepareCharacterRuntimeOptions): CharacterRuntime {
		return new CharacterRuntime(options);
	}

	/** #119 connection 接线：新建 per-socket JSON-RPC 连接（character 侧只发请求收响应）。
	 * 仅无既有连接时使用（首次 join / 测试直构兼容）；跨 owner 移交走 adoptJsonRpc。 */
	private attachJsonRpc(socket: WebSocket): void {
		const reader = new WebSocketMessageReader();
		const writer = new WebSocketMessageWriter(socket);
		const jsonrpcConnection = createMessageConnection(reader, writer);
		this.jsonrpcConnection = jsonrpcConnection;
		this.jsonrpcReader = reader;
		this.jsonrpcWriter = writer;
		jsonrpcConnection.listen();
	}

	/** #119 connection 延续：接管既有 JSON-RPC 连接（不重建 = 库内序列单调，
	 * 代际 id 不撞车——评审阻断②）。 */
	private adoptJsonRpc(jsonrpc: CharacterJsonRpcTransfer): void {
		this.jsonrpcConnection = jsonrpc.connection;
		this.jsonrpcReader = jsonrpc.reader;
		this.jsonrpcWriter = jsonrpc.writer;
	}

	activate(transfer: CharacterConnectionTransfer, pi?: ExtensionAPI): void {
		if (this.socket || this.disconnected) {
			throw new Error(ERROR_RUNTIME_ALREADY_ACTIVATED_OR_DISPOSED);
		}
		this.socket = transfer.socket;
		if (transfer.jsonrpc) {
			this.adoptJsonRpc(transfer.jsonrpc);
		} else {
			this.attachJsonRpc(transfer.socket);
		}
		this.socket.on("message", this.onMessage);
		this.socket.on("close", this.onClose);
		this.socket.on("error", this.onError);
		this.socket.on("ping", this.onPing);
		this.lastPingAt = Date.now();
		this.startHeartbeat();

		if (pi) {
			this.groupChatInput = new GroupChatInput(this, pi, this.triggerDebounceMs);
			this.groupChatInput.start();
		}

		for (const message of transfer.bufferedMessages) {
			this.handleServerMessage(message);
		}
	}

	/**
	 * ISSUE-014/#14 看门狗：agent_end 之后，若 agent_settled 在窗口内未到，
	 * 强制把 is_streaming 复位为 false。Node 定时器不依赖 agent 状态，
	 * 因此 wedged run 也会被复位。
	 */
	armStreamingResetWatchdog(delayMs = 5_000): void {
		this.clearStreamingResetWatchdog();
		this.streamingResetWatchdog = setTimeout(() => {
			this.streamingResetWatchdog = null;
			// #90：isAgentActive 守卫——run 仍活跃（continue 段进行中）时不灭灯；
			// 误灭窗口 = agent_end 布防后 5s 内无 agent_start/settle，段内 LLM
			// 调用 >5s 时触发。真悬挂（agent_end 后无任何事件）由 wedged 3min
			// 兜底强制收敛（#66），显示复位语义不丢失（#14/W2 回归保持）。
			if (this.isAgentActive) {
				return;
			}
			this.updateStreaming(false);
		}, delayMs);
	}

	clearStreamingResetWatchdog(): void {
		if (this.streamingResetWatchdog !== null) {
			clearTimeout(this.streamingResetWatchdog);
			this.streamingResetWatchdog = null;
		}
	}

	/**
	 * #66：agent_start 时布防 run wedged watchdog。agent_settled 正常到达由
	 * clearRunWedgedWatchdog 清除（happy path 零触发）；超时触发强制 settle——
	 * 与正常 settle 同路径幂等（isAgentActive 先判、触发自清、onAgentSettled
	 * 内部 incrementPending 防重入）。覆盖双窗口（① 无 agent_end ② #14 不碰
	 * isAgentActive），v2 = #14 超集。
	 */
	armRunWedgedWatchdog(delayMs?: number): void {
		this.clearRunWedgedWatchdog();
		this.wedgedSettled = false;
		this.runWedgedWatchdog = setTimeout(() => {
			this.runWedgedWatchdog = null;
			if (!this.isAgentActive) {
				return;
			}
			// 强制收敛 = agent_settled 处理路径：解除忙态、冲刷排队增量（游标
			// 差量拉全，不丢不重）；pi 原生 followUp 队列串行，无 run 重叠。
			this.wedgedSettled = true;
			this.isAgentActive = false;
			this.clearStreamingResetWatchdog();
			this.updateStreaming(false);
			this._onAgentSettled?.();
		}, delayMs ?? this.agentWedgedTimeoutMs);
	}

	clearRunWedgedWatchdog(): void {
		if (this.runWedgedWatchdog !== null) {
			clearTimeout(this.runWedgedWatchdog);
			this.runWedgedWatchdog = null;
		}
	}

	/**
	 * #66：agent_settled 统一处理（agent-lifecycle 接线）。与强制收敛幂等合并——
	 * wedged 已触发时迟到 settle 只复位显示，不重复冲刷；happy path 正常冲刷。
	 */
	settleRun(): void {
		this.isAgentActive = false;
		this.clearStreamingResetWatchdog();
		this.clearRunWedgedWatchdog();
		this.updateStreaming(false);
		if (this.wedgedSettled) {
			return;
		}
		this._onAgentSettled?.();
	}

	/**
	 * ISSUE-014/#14 / #21：按需刷新缓存的群聊状态快照。v0.5 收窄后成员/
	 * 流式变化不再广播 group_chat_update；调用点只在消息边界或显式交互刷新，
	 * 无消息期间不承诺 Character widget 实时。失败仅影响展示。
	 */
	async refreshGroupChatState(): Promise<void> {
		try {
			await this.getGroupChatState();
		} catch {
			// 仅刷新展示，不影响协议与成员资格。副作用注记：失败时
			// lastGroupChatState 保持旧值（不置空），onStateSnapshot 不触发
			// ——展示态陈旧可接受（下个消息边界重试），不静默清空缓存。
		}
	}

	async getGroupChatState(): Promise<GroupChatStateMessage> {
		const response = await this.request({ method: METHOD_GET_GROUP_CHAT_STATE, params: {} });
		if ("error" in response) {
			throw new Error(response.error.message);
		}
		if (!("result" in response)) {
			throw new Error(ERROR_UNEXPECTED_STATE_RESPONSE);
		}
		const result = response.result as GroupChatStateMessage;
		this.lastGroupChatState = result;
		this.onStateSnapshot?.(result);
		// 半开连接点亮丢失自愈：仅当快照中本角色仍为 false 且本地 run 活跃
		// 时补发一次。状态翻转不再广播 group_chat_update，因此不会回接输入链。
		if (this.isAgentActive) {
			const self = result.online_characters?.find((c) => c.is_self);
			if (self && !self.is_streaming) {
				this.updateStreaming(true);
			}
		}
		return result;
	}

	/**
	 * 从 creator 拉取一页群聊历史，按最新在前排序。
	 * cursor（服务端提供的不透明序号边界）向更早消息推进；
	 * 传入 message_history 事件或上一页响应中的 cursor 可继续向后翻页。
	 * 服务端拒绝请求时返回 null（例如窗口中途掉线）。
	 * ISSUE-008：join 时 message_history 只携带最近 10 条消息，
	 * 客户端靠本方法走完剩余历史。
	 */
	async fetchMessageHistoryPage(cursor: string | null): Promise<{
		messages: ServerMessage[];
		cursor: string | null;
		hasMore: boolean;
		totalMessages: number;
	} | null> {
		let response: ServerMessage;
		try {
			response = await this.request({
				method: METHOD_GET_MESSAGE_HISTORY,
				params: { ...(cursor !== null ? { cursor } : {}) },
			});
		} catch (error) {
			// 翻页期间连接可能已断开：调用方保留已拿到的历史，
			// 而不是让本轮失败。
			if (this.disconnected) {
				return null;
			}
			throw error;
		}
		if ("error" in response) {
			throw new Error(response.error.message);
		}
		if (!("result" in response)) {
			throw new Error(ERROR_UNEXPECTED_HISTORY_RESPONSE);
		}
		const data = response.result as {
			messages: ServerMessage[];
			cursor: string | null;
			has_more: boolean;
			total_messages: number;
		};
		return {
			messages: data.messages,
			cursor: data.cursor,
			hasMore: data.has_more,
			totalMessages: data.total_messages,
		};
	}

	/**
	 * M7 (ISSUE-012/#24)：从 creator 拉取所有 sequence > since 的消息。
	 * 服务端按 sequence 过滤，因此漏掉的通知（gap）由下一次拉取补齐。
	 * 连接中途断开时返回 null。
	 */
	/**
	 * #138：拉取起点前移游标前 N 条已读上下文（方案 A，零协议变更）。
	 * 额外 N 条仅作上下文窗口：不更新游标、不污染未读语义；前移只作用
	 * 增量拉取路径（pageOlderHistory 走 fetchMessageHistoryPage，不叠加）。
	 * 默认 0 行为不变（无注入/显式传 0 = 既有语义，测试零影响）。
	 */
	async fetchMessagesSince(
		sinceSequence: number,
		contextWindow: number = this.getFetchContextWindow?.() ?? 0,
	): Promise<{
		messages: ServerMessage[];
		latestSequence: number;
		totalMessages: number;
		/**
		 * #146 P1（Copilot）：前导上下文条数 = seq ≤ sinceSequence 的窗口内容
		 * （含游标自身最近已读）。未读 = 本字段之后（seq > sinceSequence）。
		 * 下游据此只在未读区间存在可投递事件时才携带上下文投递。
		 */
		contextCount: number;
	} | null> {
		// 前移起点 clamp 到 0（历史不足 N 条时取实际可用全量）。
		const adjustedSince = Math.max(0, sinceSequence - contextWindow);
		let response: ServerMessage;
		try {
			response = await this.request({
				method: METHOD_FETCH_MESSAGES_SINCE,
				params: { since_sequence: adjustedSince },
			});
		} catch (error) {
			if (this.disconnected) {
				return null;
			}
			throw error;
		}
		if ("error" in response) {
			throw new Error(response.error.message);
		}
		if (!("result" in response)) {
			throw new Error(ERROR_UNEXPECTED_FETCH_RESPONSE);
		}
		const data = response.result as {
			messages: ServerMessage[];
			latest_sequence: number;
			total_messages: number;
		};
		// #146 P1：上下文/未读分界 = 原始 since（窗口前移前的拉取起点）。
		// 服务端按 sequence 升序返回（submit 原子 +1 无空洞），上下文恒为前缀。
		const contextCount = data.messages.filter((m) => {
			const sequence = "params" in m && (m.params as { sequence?: unknown }).sequence;
			return typeof sequence === "number" && sequence <= sinceSequence;
		}).length;
		return {
			messages: data.messages,
			latestSequence: data.latest_sequence,
			totalMessages: data.total_messages,
			contextCount,
		};
	}

	/**
	 * 展示态上报，尽力而为（同 refreshGroupChatState 的 display-only 语义）：
	 * 连接已关闭/未建立时静默跳过，绝不 throw。调用面全是 fire-and-forget——
	 * agent_settled→settleRun（agent-lifecycle 接线）与两个 watchdog 定时器在
	 * 连接先断（pi 退出竞态/心跳超时）后仍可能触发，此处 throw 会把异常炸进
	 * ExtensionRunner.emit（settle 路径）或成为 uncaughtException 杀死整个 pi
	 * 进程（定时器路径，见线上两例崩溃堆栈）。展示状态随连接消失失去意义。
	 */
	updateStreaming(isStreaming: boolean): void {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			return;
		}
		this.send({
			jsonrpc: JSONRPC_VERSION,
			method: METHOD_UPDATE_CHARACTER_STATE,
			params: { is_streaming: isStreaming },
		});
	}

	/**
	 * M7：加载本群聊的持久化游标（最后一条成功投递的消息序号）。
	 * 尚无游标（首次 join）或存储不可用时返回 null——调用方随即回退到
	 * 完整历史分页路径。
	 */
	loadCursor(): number | null {
		if (!this.cursorStorePath) {
			return null;
		}
		if (this.cursorSequence !== null) {
			return this.cursorSequence;
		}
		// 游标跟随 Session：只读本 Session 文件。v1 群聊级共享游标无 Session 身份，
		// 可能由其他角色推进——若回退采用其值会跳过本 Session 从未看过的消息，故
		// 不采用（User 2026-08-02：新 Session 无独立游标 = 从完整历史重新拉取，
		// 最多重复、绝不跳过）。旧共享文件物理遗留但不读不写。
		let sequence: number | null = null;
		try {
			sequence = readCursorFile(this.cursorStorePath);
		} catch {
			// 本 Session 文件不存在（ENOENT/EISDIR 等）——无游标，走完整历史分页
		}
		if (sequence !== null) {
			this.cursorSequence = sequence;
		}
		return this.cursorSequence;
	}

	/**
	 * M7：成功投递后持久化游标。写入是原子的（tmp 文件 + rename），
	 * 写中途崩溃不会损坏游标；投递失败绝不能推进游标（重试语义）。
	 * 内存先行窗口：cursorSequence 先推进、文件后写——写失败时同进程
	 * loadCursor 仍回读新值（QA 场景 7 钉）；跨进程恢复以文件为准（
	 * 内存先行不落盘则下次 join 从更早位置重拉，按 sequence 幂等）。
	 */
	saveCursor(sequence: number): void {
		if (!this.cursorStorePath) {
			return;
		}
		// 内存先推进（保持：写失败时同进程 loadCursor 仍回读新值——QA 场景 7 钉）
		this.cursorSequence = sequence;
		try {
			writeCursorFile(this.cursorStorePath, sequence);
		} catch {
			// 持久化尽力而为：游标写入丢失只意味着下次 join
			// 从更早的位置重新拉取（按 sequence 幂等）。
		}
	}

	async speak(content: string): Promise<{
		published: boolean;
		eventId?: string;
		sequence?: number;
		reason?: string;
		handRaised?: boolean;
		missingFrom?: number;
		missingTo?: number;
		autoRecover?: boolean;
		round?: { roundMaxMessages: number; usedMessages: number; remainingMessages: number };
		/** #128：未读先读阻止（first = 首拒，已安排拉取；unreadCount/unreadExact = 告知条数）。 */
		first?: boolean;
		unreadCount?: number;
		unreadExact?: boolean;
	}> {
		// #128：未读先读——发言前若有已证明的他人未读，不发布、不耗配额、不举手。
		// 本地判定（零协议变更，Arch 评审 ②）：判定后直接返回、不发请求；拉取注入
		// 走既有 markIncrementPending → settle 拉全 → followUp 重开的两段式链路。
		// 水位未知（reload 后）时放行；截断窗口含自身回显时按 #128 定稿保守阻止。
		// 其余无法证明他人未读的场景放行，由服务端 stale 拒绝兜底。
		const unread = this.groupChatInput?.unreadOthersProven();
		if (unread?.shouldBlock) {
			const first = !this.unreadBlockNotified;
			if (first) {
				this.unreadBlockNotified = true;
				this.markIncrementPending();
			}
			return {
				published: false,
				reason: "unread_first",
				first,
				...(unread.count > 0 ? { unreadCount: unread.count } : {}),
				unreadExact: unread.exact,
			};
		}
		this.unreadBlockNotified = false;
		// ISSUE-013 B1：客户端始终携带自己的投递游标（最后一条成功投递的
		// sequence——A5：只能由投递路径推进）。客户端不会自行推进游标；
		// 服务端把请求者自己的消息排除在 stale 检查之外（B6），
		// 因此游标停在自己已发布的消息之前永远不会导致误拒。
		// 旧版服务端忽略该字段。
		const basedOnSequence = this.loadCursor() ?? 0;
		const response = await this.request({
			method: METHOD_SPEAK,
			params: { content, based_on_sequence: basedOnSequence },
		});
		if ("error" in response) {
			throw new Error(response.error.message);
		}
		if (!("result" in response)) {
			throw new Error(ERROR_UNEXPECTED_SPEAK_RESPONSE);
		}
		const result = response.result as {
			published: boolean;
			event_id: string;
			sequence: number;
			reason: string;
			hand_raised: boolean;
			missing_sequences: { from: number; to: number };
			round: {
				round_max_messages: number;
				used_messages: number;
				remaining_messages: number;
			};
		};
		const round = {
			roundMaxMessages: result.round.round_max_messages,
			usedMessages: result.round.used_messages,
			remainingMessages: result.round.remaining_messages,
		};
		if (result.published) {
			this.resetStaleRecoveryBudget();
			return {
				published: true,
				eventId: result.event_id,
				sequence: result.sequence,
				round,
			};
		}
		if (result.reason === "stale") {
			const key = `${round.roundMaxMessages}:${round.usedMessages}`;
			if (this.staleRecoveryKey !== key) {
				this.staleRecoveryKey = key;
				this.staleRecoveryCount = 0;
			}
			this.staleRecoveryCount += 1;
			return {
				published: false,
				reason: "stale",
				missingFrom: result.missing_sequences?.from,
				missingTo: result.missing_sequences?.to,
				autoRecover: this.staleRecoveryCount <= MAX_STALE_AUTO_RECOVERIES,
				round,
			};
		}
		return {
			published: false,
			reason: "round_limit_reached",
			handRaised: result.hand_raised,
			round,
		};
	}

	/**
	 * 白板模型（#114）：board_write——贴/改/撕/清本人板。
	 * 返回响应 data（四态：changed:true 带/不带 note；changed:false 带告知/拒绝码）。
	 * 群聊静默：changed:false 不广播 board_update（接口层告知）。
	 */
	/**
	 * 白板写入（#114，F11 收窄）：判别 union 类型——set 带全可选 note（业务幂等
	 * note_unchanged 保留）、remove 必带 {id}（content 禁）、clear 无参。非法组合
	 * 在调用侧（工具层/测试）即拒，不发 wire——避免服务端 fail-close 断连。
	 */
	async boardWrite(
		...args:
			| [action: "set", note?: { id?: string; content?: string }]
			| [action: "remove", note: { id: string }]
			| [action: "clear"]
	): Promise<BoardWriteDataWire> {
		const [action, note] = args;
		const response = await this.request({
			method: METHOD_BOARD_WRITE,
			params: { action, ...(note !== undefined ? { note } : {}) },
		});
		if ("error" in response) {
			throw new Error(response.error.message);
		}
		if (!("result" in response)) {
			throw new Error(ERROR_UNEXPECTED_BOARD_WRITE_RESPONSE);
		}
		return response.result as BoardWriteDataWire;
	}

	/** 白板模型（#114）：board_query——全量 per-character 条目（本人视角）。 */
	async boardQuery(): Promise<Record<string, BoardNoteWire[]>> {
		const response = await this.request({ method: METHOD_BOARD_QUERY, params: {} });
		if ("error" in response) {
			throw new Error(response.error.message);
		}
		if (!("result" in response)) {
			throw new Error(ERROR_UNEXPECTED_BOARD_QUERY_RESPONSE);
		}
		return (response.result as { boards: Record<string, BoardNoteWire[]> }).boards;
	}

	/**
	 * #152 二轮（苍蓝星/PM/Arch 裁定共享化）：stale 自愈预算重置——「成功同步
	 * （游标推进）即归零」，绑定同步成功事件而非入口成功（speak/whisper 同调）。
	 * 预算状态机：key = 轮次额度快照；清零 = 任何成功发布；上限 =
	 * MAX_STALE_AUTO_RECOVERIES；本质 = 防 stale 自愈循环的启发式非系统保证。
	 */
	private resetStaleRecoveryBudget(): void {
		this.staleRecoveryKey = null;
		this.staleRecoveryCount = 0;
	}

	/**
	 * #152：向指定 Character 发送私信。与 speak 共用：未读先读检查（#128）、
	 * 服务端在线校验（WS 活跃）、轮次额度、大小限制与基于游标的 stale 检查
	 * （based_on_sequence 同 speak）；失败不占额度。
	 *
	 * 成功后推进本地游标到 result.sequence（发送者无回显投递，服务端把
	 * 请求者自己的消息排除在 stale 检查之外——schema 注释：sequence 供发送者
	 * 游标）。发送者不收到任何自身事件（服务端过滤，零注入）。
	 */
	async whisper(
		characterId: string,
		content: string,
	): Promise<{
		published: boolean;
		sequence?: number;
		reason?: "stale" | "round_limit_reached";
		missingFrom?: number;
		missingTo?: number;
		autoRecover?: boolean;
		handRaised?: boolean;
	}> {
		// #128：未读先读——与 speak 同款本地判定（whisper 也走未读优先）。
		const unread = this.groupChatInput?.unreadOthersProven();
		if (unread?.shouldBlock) {
			const first = !this.unreadBlockNotified;
			if (first) {
				this.unreadBlockNotified = true;
				this.markIncrementPending();
			}
			return { published: false };
		}
		this.unreadBlockNotified = false;
		const basedOnSequence = this.loadCursor() ?? 0;
		const response = await this.request({
			method: METHOD_WHISPER,
			params: { character_id: characterId, content, based_on_sequence: basedOnSequence },
		});
		if ("error" in response) {
			// 错误码透传（-32110 离线 / -32111 自发自收 / 持久化失败等）。
			throw new Error(response.error.message);
		}
		if (!("result" in response)) {
			throw new Error(ERROR_UNEXPECTED_WHISPER_RESPONSE);
		}
		// #152 修复（PR #160 AI 评审阻断 1 配套）：三态 result 与 schema 一致
		// （published+sequence+round / stale / round_limit_reached，与 speak 同构）。
		const result = response.result as {
			published: boolean;
			sequence?: number;
			reason?: "stale" | "round_limit_reached";
			missing_sequences?: { from: number; to: number };
			hand_raised?: boolean;
			round: { round_max_messages: number; used_messages: number; remaining_messages: number };
		};
		if (result.published) {
			this.saveCursor(result.sequence ?? 0);
			// #152 二轮（共享化裁定）：成功发布（游标推进）即归零预算——与 speak 同 helper。
			this.resetStaleRecoveryBudget();
			return { published: true, ...(result.sequence !== undefined ? { sequence: result.sequence } : {}) };
		}
		if (result.reason === "stale") {
			// stale 自愈（与 speak 同路径）：预算内标记增量待投递，settle 补拉
			// （拉取合并流含 whisper 帧 → 消费占位/全文 + 游标推进）。
			const key = `${result.round.round_max_messages}:${result.round.used_messages}`;
			if (this.staleRecoveryKey !== key) {
				this.staleRecoveryKey = key;
				this.staleRecoveryCount = 0;
			}
			this.staleRecoveryCount += 1;
			return {
				published: false,
				reason: "stale",
				...(result.missing_sequences !== undefined
					? { missingFrom: result.missing_sequences.from, missingTo: result.missing_sequences.to }
					: {}),
				autoRecover: this.staleRecoveryCount <= MAX_STALE_AUTO_RECOVERIES,
			};
		}
		return {
			published: false,
			reason: "round_limit_reached",
			...(result.hand_raised !== undefined ? { handRaised: result.hand_raised } : {}),
		};
	}

	/**
	 * ISSUE-013 B3：标记 A2“增量挂起”标记，让 settle 钩子经统一投递管线
	 * 拉取错过的增量。由 speak 工具在 stale 拒绝需要自动恢复时调用；
	 * 工具本身只返回简短提示（不带消息文本——完整增量在下一轮经正常
	 * 群聊输入到达）。
	 */
	markIncrementPending(): void {
		this.groupChatInput?.markIncrementPending();
	}

	/**
	 * 为 reload 拆离 runtime：停止输入管线与心跳，在存活 socket 上缓冲
	 * reload 窗口帧，并发布一次性交接。连接、Character 身份、未冲刷的
	 * 环境事件、未读标记与各触发窗口截止时刻都保留给新 runtime。
	 */
	async detachForReload(piSessionId: string): Promise<CharacterReloadHandoff> {
		if (this.lifecycle !== "active" || !this.socket || this.disconnected) {
			throw new Error(ERROR_CHARACTER_RUNTIME_NOT_ACTIVE);
		}
		this.lifecycle = "detaching";
		this.stopHeartbeat();
		const snapshot = this.groupChatInput?.snapshotForReload() ?? {
			pendingEvents: [],
			debounceDueAt: null,
			idleWindowDueAt: null,
			idleWindowAbortEligible: false,
			incrementPending: false,
		};
		this.groupChatInput?.stop();
		this.groupChatInput = undefined;

		const socket = this.socket;
		const bufferedFrames: BufferedFrame[] = [];
		let socketClosed = false;
		const handlers = {
			message: (data: WebSocket.RawData) => {
				bufferedFrames.push({ receivedAt: Date.now(), data });
			},
			close: () => {
				socketClosed = true;
			},
		};
		this.bufferingHandlers = handlers;
		socket.off("message", this.onMessage);
		socket.off("close", this.onClose);
		socket.off("error", this.onError);
		socket.off("ping", this.onPing);
		socket.on("message", handlers.message);
		socket.on("close", handlers.close);

		const handoff: CharacterReloadHandoff = {
			kind: "character",
			piSessionId,
			expiresAt: Date.now() + this.requestTimeoutMs,
			groupChatId: this.groupChatId,
			socket,
			character: this.character,
			...(this.cursorStorePath !== undefined ? { cursorStorePath: this.cursorStorePath } : {}),
			// #138：上下文窗口 getter 跨 reload 携带（reload 后与 join 路径行为一致）。
			...(this.getFetchContextWindow !== undefined ? { getFetchContextWindow: this.getFetchContextWindow } : {}),
			// #154 T5：模板集快照跨 reload 携带（reload 后渲染一致，不回落默认）。
			...(this.messageTemplates !== undefined ? { messageTemplates: this.messageTemplates } : {}),
			// #154 复评：路径随 handoff 携带，takeHandoff 据此重新加载磁盘配置。
			...(this.agentDir !== undefined ? { agentDir: this.agentDir } : {}),
			...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
			// #119 connection 延续：连接实例随 handoff 移交（新 runtime 不重建——
			// 库内序列单调，旧代际响应撞不上新请求 id，评审阻断②）。
			...(this.jsonrpcConnection && this.jsonrpcReader && this.jsonrpcWriter
				? {
						jsonrpc: {
							connection: this.jsonrpcConnection,
							reader: this.jsonrpcReader,
							writer: this.jsonrpcWriter,
						},
					}
				: {}),
			pendingEvents: snapshot.pendingEvents,
			debounceDueAt: snapshot.debounceDueAt,
			idleWindowDueAt: snapshot.idleWindowDueAt,
			idleWindowAbortEligible: snapshot.idleWindowAbortEligible,
			incrementPending: snapshot.incrementPending,
			lastPingAt: this.lastPingAt,
			bufferedFrames,
			bufferingHandlers: handlers,
			socketClosed,
			cleanup: async () => {
				if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
					socket.close();
				}
			},
		};
		this.socket = null;
		// 三轮评审阻断⑨：显式取消旧 in-flight（clearTimeout + reject 断线原因）——
		// 旧 owner 的 timer 不再点火，杜绝 failConnection → finishDisconnected →
		// dispose 新 runtime 正在使用的共享 connection；随后脱离共享连接引用与
		// 关联元数据（任何迟到的 finishDisconnected 都碰不到移交的连接）。
		for (const inflight of this.inflightRequests) {
			clearTimeout(inflight.timer);
			inflight.reject(new Error(ERROR_CONNECTION_CLOSED_DURING_RELOAD));
		}
		this.inflightRequests.clear();
		this.jsonrpcConnection = null;
		this.jsonrpcReader = null;
		this.jsonrpcWriter = null;
		getReloadHandoffRegistry().publish(handoff);
		return handoff;
	}

	/**
	 * 接管 character 交接：用新处理器重新挂接存活 socket，恢复心跳跟踪与
	 * 环境输入管线（含挂起事件、未读标记与触发窗口），然后按到达顺序
	 * 重放缓冲帧。reload 窗口期间断线的成员走正常断线清理。
	 *
	 * ISSUE-005：reload 时重新从磁盘读角色卡，因此加入期间对卡片的编辑
	 * （例如四方 0.5 协作合并）会在 reload 后反映到注入的 persona。若重读
	 * 失败则保留旧卡并把警告经可选 notify 回调暴露——reload 继续，绝不
	 * 使会话崩溃。
	 */
	static async takeHandoff(
		handoff: CharacterReloadHandoff,
		pi?: ExtensionAPI,
		notify?: (message: string) => void,
		// #154 复评（Arch）：恢复路径配置加载器注入化（同 headless AutoJoinOptions
		// loadConfig 模式，默认 loadTavernConfig；测试可注入 mock）。
		loadConfig: (options: { agentDir: string; cwd: string }) => Promise<TavernConfig> = loadTavernConfig,
	): Promise<CharacterRuntime> {
		if (handoff.socketClosed) {
			void handoff.cleanup();
			throw new Error(ERROR_CONNECTION_CLOSED_DURING_RELOAD);
		}
		let character = handoff.character;
		try {
			character = await loadCharacterCard(
				handoff.character.path,
				resolve(dirname(handoff.character.path), "tavern.json"),
			);
			// 保留注册时的身份锚：加入期间角色卡可能被编辑过，
			// 但 character_id 以 join 时注册为准。
			// （与 loadClaimedCharacter 同款。）
			character = { ...character, characterId: handoff.character.characterId };
		} catch (error) {
			// 保留旧角色卡；把失败暴露给用户，让其知道 persona
			// 可能已过期。无论哪种情况连接都保持。
			notify?.(
				`reload: failed to re-read character card ${handoff.character.path}, keeping the previous one: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		// #154 复评（苍蓝星）：reload 时重新加载磁盘配置——模板文件（message_templates）
		// 经编辑落盘后，reload 使新配置生效（同角色卡重读模式）。
		// 失败：warning + 保留旧快照，reload 继续，绝不使会话崩溃。
		let messageTemplates = handoff.messageTemplates;
		if (handoff.agentDir !== undefined && handoff.cwd !== undefined) {
			try {
				const reloaded = await loadConfig({ agentDir: handoff.agentDir, cwd: handoff.cwd });
				// 复评（苍蓝星第三轮）：reload 成功即采用磁盘配置——messageTemplates
				// 缺省时清除旧快照（消费面回落内置默认）；仅加载抛错才保留旧快照。
				messageTemplates = reloaded.messageTemplates;
			} catch (error) {
				notify?.(
					`reload: failed to reload tavern.json, keeping the previous message templates: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		const runtime = new CharacterRuntime({
			groupChatId: handoff.groupChatId,
			sessionId: handoff.piSessionId,
			character,
			...(handoff.cursorStorePath !== undefined ? { cursorStorePath: handoff.cursorStorePath } : {}),
			// #138：上下文窗口 getter 跨 reload 延续（reload 后与 join 路径行为一致）。
			...(handoff.getFetchContextWindow !== undefined ? { getFetchContextWindow: handoff.getFetchContextWindow } : {}),
			// #154 T5：模板集跨 reload 延续——先磁盘重载、失败回落快照。
			...(messageTemplates !== undefined ? { messageTemplates } : {}),
			// #154 复评：路径随 runtime 延续（后续再次 reload 仍可重载磁盘配置）。
			...(handoff.agentDir !== undefined ? { agentDir: handoff.agentDir } : {}),
			...(handoff.cwd !== undefined ? { cwd: handoff.cwd } : {}),
		});
		runtime.activateFromHandoff(handoff, pi);
		return runtime;
	}

	private activateFromHandoff(handoff: CharacterReloadHandoff, pi?: ExtensionAPI): void {
		if (this.socket || this.disconnected) {
			throw new Error(ERROR_RUNTIME_ALREADY_ACTIVATED_OR_DISPOSED);
		}
		const socket = handoff.socket;
		socket.off("message", handoff.bufferingHandlers.message);
		socket.off("close", handoff.bufferingHandlers.close);
		this.socket = socket;
		if (handoff.jsonrpc) {
			// #119 connection 延续：接管旧 runtime 的既有连接（序列单调，代际隔离）。
			this.adoptJsonRpc(handoff.jsonrpc);
		} else {
			this.attachJsonRpc(socket);
		}
		this.lastPingAt = handoff.lastPingAt;
		socket.on("message", this.onMessage);
		socket.on("close", this.onClose);
		socket.on("error", this.onError);
		socket.on("ping", this.onPing);
		this.startHeartbeat();

		if (pi) {
			this.groupChatInput = new GroupChatInput(this, pi, this.triggerDebounceMs);
			this.groupChatInput.start();
			this.groupChatInput.restoreFromReload({
				pendingEvents: handoff.pendingEvents,
				debounceDueAt: handoff.debounceDueAt,
				idleWindowDueAt: handoff.idleWindowDueAt,
				idleWindowAbortEligible: handoff.idleWindowAbortEligible,
				incrementPending: handoff.incrementPending,
			});
		}

		for (const frame of [...handoff.bufferedFrames].sort((a, b) => a.receivedAt - b.receivedAt)) {
			this.handleIncomingData(frame.data, false);
		}

		// ISSUE-014/#14 reload 角落：旧 runtime 的流式看门狗定时器
		// 随旧 Extension Runtime 一起消亡。若上一次 agent run 中途被打断
		// （streaming 卡在 true），这里显式复位——run 已死，展示不能一直
		// 挂着。这是 reload 路径唯一确定性的覆盖（M5 handoff）。
		this.updateStreaming(false);
	}

	get hasPublicMessages(): boolean {
		return this.receivedMessages.some((m) => {
			if ("method" in m && m.method === METHOD_PUBLIC_MESSAGE) return true;
			if (
				"method" in m &&
				m.method === METHOD_MESSAGE_HISTORY &&
				Array.isArray(m.params.messages) &&
				m.params.messages.length > 0
			) {
				return true;
			}
			if (
				"method" in m &&
				m.method === METHOD_GROUP_CHAT_UPDATE &&
				Array.isArray(m.params.preview_messages) &&
				m.params.preview_messages.length > 0
			) {
				return true;
			}
			return false;
		});
	}

	close(): Promise<void> {
		this.closePromise ??= this.closePermanently();
		return this.closePromise;
	}

	private async closePermanently(): Promise<void> {
		if (this.lifecycle === "detaching") {
			// close() 与 detachForReload() 是互斥路径。
			throw new Error(ERROR_CHARACTER_RUNTIME_DETACHED);
		}
		this.lifecycle = "disposed";
		this.clearStreamingResetWatchdog();
		if (!this.socket || this.disconnected) {
			this.finishDisconnected();
			return;
		}
		try {
			const response = await this.request({ method: METHOD_LEAVE_GROUP_CHAT, params: {} });
			if ("error" in response) {
				throw new Error(response.error.message);
			}
		} finally {
			this.finishDisconnected();
		}
	}

	/**
	 * #119 connection 接线：sendRequest 替代手写 pending（响应关联/取消由库承担）。
	 * 超时语义保留（Promise.race + failConnection）；ResponseError 包装回
	 * {error:{code,message}} 响应形状——调用方 `"error" in response` 判别语法不变。
	 */
	private request(message: { method: string; params: unknown }): Promise<ServerMessage> {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error(ERROR_CONNECTION_NOT_OPEN));
		}
		const type = CHARACTER_REQUEST_TYPES[message.method];
		if (!type || !this.jsonrpcConnection) {
			return Promise.reject(new Error(`No request type for method: ${message.method}`));
		}
		const pending = (this.jsonrpcConnection as MessageConnection).sendRequest(type as never, message.params as never);
		const withTimeout = new Promise<unknown>((resolveRequest, rejectRequest) => {
			const timer = setTimeout(() => {
				const error = new Error(ERROR_REQUEST_TIMED_OUT);
				rejectRequest(error);
				this.failConnection(error);
			}, this.requestTimeoutMs);
			timer.unref?.();
			const inflight = { timer, reject: rejectRequest };
			this.inflightRequests.add(inflight);
			void pending.then(
				(result) => {
					clearTimeout(timer);
					this.inflightRequests.delete(inflight);
					resolveRequest(result);
				},
				(error) => {
					clearTimeout(timer);
					this.inflightRequests.delete(inflight);
					rejectRequest(error);
				},
			);
		});
		return withTimeout.then(
			(result) => {
				// #139 方案 B：解析时形状校验（method 调用点已知，替代 feed 前 gate）。
				// 同 id 错 result = 协议错位 fail-close：显式 ERROR_UNEXPECTED_* reject +
				// 断链（failConnection → finishDisconnected，其他 in-flight 经 dispose
				// -32097 → disconnectError 路径，文案同源）。
				const failCloseError = validateResult(message.method, result);
				if (failCloseError) {
					this.failConnection(failCloseError);
					return Promise.reject(failCloseError);
				}
				return { jsonrpc: JSONRPC_VERSION, id: "", result } as ServerMessage;
			},
			(error) => {
				if (error instanceof ResponseError && error.code === PENDING_RESPONSE_REJECTED_CODE) {
					// 断线 dispose 的库内拒绝（-32097）：以断线原因 reject（立即收敛，
					// 不悬挂到超时——评审阻断③）。fail-close 场景 = ERROR_UNEXPECTED_*。
					return Promise.reject(this.disconnectError ?? new Error(ERROR_CONNECTION_HAS_BEEN_CLOSED));
				}
				if (error instanceof ResponseError) {
					return {
						jsonrpc: JSONRPC_VERSION,
						id: "",
						error: { code: error.code, message: error.message },
					} as ServerMessage;
				}
				return Promise.reject(error);
			},
		);
	}

	private send(message: unknown): void {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			throw new Error(ERROR_CONNECTION_NOT_OPEN);
		}
		const encoded = encodeMessage(message);
		if (Buffer.byteLength(encoded, "utf8") > MAX_WEBSOCKET_FRAME_BYTES) {
			throw new Error(ERROR_FRAME_TOO_LARGE);
		}
		this.socket.send(encoded);
	}

	private handleServerMessage(message: ServerMessage): void {
		// #139 方案 B：响应帧直接喂 connection（库按 id 关联原请求，id 关联/丢弃
		// 由库承担）；result 形状校验移到 request() 解析时（method 在调用点已知，
		// 同 id 错 result 仍 fail-close——#137 阻断②语义保留）。error 自描述、
		// 未知 id（旧代际迟到响应 / reload 缓冲重放）→ 库按 id 结算或丢弃；
		// 代际隔离由连接延续保证。
		if (("result" in message || "error" in message) && message.id !== undefined) {
			this.jsonrpcReader?.deliver(message);
			return;
		}

		this.receivedMessages.push(message);

		this.onEnvironmentMessage?.(message);

		if ("method" in message && message.method === METHOD_GROUP_CHAT_CLOSED) {
			this.finishDisconnected();
		}
	}

	private startHeartbeat(): void {
		if (this.heartbeatTimer) {
			return;
		}
		this.heartbeatTimer = setInterval(() => {
			if (Date.now() - this.lastPingAt > this.heartbeatTimeoutMs) {
				// 超时窗口内不给 creator 发 ping：连接处于半开状态。
				this.failConnection(new Error(ERROR_HEARTBEAT_TIMEOUT));
			}
		}, this.heartbeatIntervalMs);
		this.heartbeatTimer.unref?.();
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private failConnection(error: Error): void {
		const socket = this.socket;
		if (socket && socket.readyState !== WebSocket.CLOSED) {
			socket.terminate();
		}
		this.finishDisconnected(error);
	}

	private finishDisconnected(error?: Error): void {
		if (this.disconnected) {
			return;
		}
		this.disconnected = true;
		this.disconnectError = error;
		// 死连接上的 watchdog 定时器必须一并拆除：否则 agent_end 布防的 5s
		// 流式复位定时器（或 run wedged 定时器）会在 socket 置空后点火，
		// 定时器上下文内 throw = uncaughtException = 杀死整个 pi 进程。
		this.clearStreamingResetWatchdog();
		this.clearRunWedgedWatchdog();
		this.stopHeartbeat();
		this.groupChatInput?.stop();
		this.groupChatInput = undefined;
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			socket.off("message", this.onMessage);
			socket.off("close", this.onClose);
			socket.off("error", this.onError);
			socket.off("ping", this.onPing);
			if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
				socket.close();
			}
		}
		// #119 connection 接线：断线终态 dispose connection——v9 实证 reader close
		// 只置 Closed 不拒 pending，dispose() 才遍历 reject responsePromises
		// （评审阻断③）。request() 把 -32097 映射为断线原因立即 reject。
		// B3（W3 补全）：显式清本地 in-flight 登记（clearTimeout + reject 断线原因）
		// ——与 detach 先例对称；dispose() 虽已拒库内 pending，但本地 timer 若不
		// 清则悬挂至超时（QA 对抗坐实，超时兜底存在但延迟 5s）。
		for (const inflight of this.inflightRequests) {
			clearTimeout(inflight.timer);
			inflight.reject(error ?? new Error(ERROR_CONNECTION_CLOSED));
		}
		this.inflightRequests.clear();
		const jsonrpcConnection = this.jsonrpcConnection;
		this.jsonrpcConnection = null;
		this.jsonrpcReader = null;
		this.jsonrpcWriter = null;
		jsonrpcConnection?.dispose();
		this.onDisconnected?.();
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
