import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { MessageConnection } from "vscode-jsonrpc";
import type WebSocket from "ws";
import type { WebSocketServer } from "ws";

import type { CharacterCard } from "../config/character-card.js";
import type { BoardStore } from "../data/board-store.js";
import type { ActiveGroupChatDescriptor } from "../data/discovery/active-descriptor.js";
import type { GroupChatState } from "../data/group-chat-state.js";
import type { ServerMessage } from "../protocol/messages.js";
import type { PublicMessageState } from "../protocol/public-message-state.js";
import type { WebSocketMessageReader, WebSocketMessageWriter } from "../protocol/ws-message-io.js";

/** 私有 globalThis 键，让 reload 后的扩展代码能找到槽位。 */
export const RELOAD_HANDOFF_SYMBOL: unique symbol = Symbol.for("pi-tavern.reload-handoff");

export interface BufferedFrame {
	receivedAt: number;
	data: WebSocket.RawData;
}

/**
 * #119 connection 延续三件套（评审阻断②）：JSON-RPC 连接实例跨 owner 移交
 * （JoinAttempt → CharacterRuntime → reload 后新 runtime）——连接不重建 =
 * 库内序列单调，代际 id 不撞车（旧代际迟到响应不可能命中新请求）。
 */
export interface CharacterJsonRpcTransfer {
	connection: MessageConnection;
	reader: WebSocketMessageReader;
	writer: WebSocketMessageWriter;
}

interface HeartbeatStateSnapshot {
	lastPongAt: number;
}

/**
 * 从旧 Extension Runtime 移交到 reload 后新 runtime 的资源。
 * 一次性：take() 恰好成功一次；5s 过期后由 handoff 自身的 cleanup
 * 释放全部资源。
 */
export interface CreatorReloadHandoff {
	kind: "creator";
	piSessionId: string;
	expiresAt: number;

	webSocketServer: WebSocketServer;
	groupSessionManager: SessionManager;
	groupChatState: GroupChatState;
	/** 白板模型（#114）：store 实例随 handoff 传递（reload 进程内，缓存存活）。 */
	boardStore: BoardStore;
	connections: Map<string, WebSocket>;
	heartbeatStates: Map<string, HeartbeatStateSnapshot>;
	activeDescriptor: ActiveGroupChatDescriptor;
	activeDescriptorPath: string;
	configMaxMessages: number;
	characters: CharacterCard[];
	publicMessages: PublicMessageState[];
	persistedCount: number;

	bufferedFrames: Map<string, BufferedFrame[]>;
	bufferingHandlers: Map<string, { message: (data: WebSocket.RawData) => void; close: () => void }>;
	closedSessionIds: Set<string>;

	/** 释放服务端、成员 socket 与活跃描述符。 */
	cleanup: () => Promise<void>;
}

export interface CharacterReloadHandoff {
	kind: "character";
	piSessionId: string;
	expiresAt: number;

	groupChatId: string;
	socket: WebSocket;
	character: CharacterCard;
	/** M7 (ISSUE-012/#24)：跨 reload 携带的游标文件路径。 */
	cursorStorePath?: string;
	pendingEvents: ServerMessage[];
	debounceDueAt: number | null;
	/** 可选仅为兼容这些字段加入前创建的跨版本 reload handoff。 */
	idleWindowDueAt?: number | null | undefined;
	idleWindowAbortEligible?: boolean | undefined;
	incrementPending?: boolean | undefined;
	lastPingAt: number;

	/** #119 connection 延续：旧 runtime 的 JSON-RPC 连接实例（可选：兼容旧态 handoff）。 */
	jsonrpc?: CharacterJsonRpcTransfer;

	bufferedFrames: BufferedFrame[];
	bufferingHandlers: { message: (data: WebSocket.RawData) => void; close: () => void };
	socketClosed: boolean;

	/** 关闭 socket 并丢弃未冲刷的挂起事件。 */
	cleanup: () => Promise<void>;
}

export type ReloadHandoff = CreatorReloadHandoff | CharacterReloadHandoff;

class ReloadHandoffRegistry {
	private handoff: ReloadHandoff | null = null;
	private expireTimer: NodeJS.Timeout | null = null;

	/** 发布交接；之前未被取走的交接先过期。 */
	publish(handoff: ReloadHandoff): void {
		this.clearExpireTimer();
		const previous = this.handoff;
		this.handoff = handoff;
		if (previous) {
			void previous.cleanup();
		}
		const delay = Math.max(0, handoff.expiresAt - Date.now());
		this.expireTimer = setTimeout(() => this.expire(), delay);
		this.expireTimer.unref?.();
	}

	/**
	 * 取走交接。只有同一 pi session 可以取；session 不匹配时返回 null，
	 * 槽位留给真正的归属者。
	 */
	take(piSessionId: string): ReloadHandoff | null {
		const handoff = this.handoff;
		if (!handoff || handoff.piSessionId !== piSessionId) {
			return null;
		}
		this.clearExpireTimer();
		this.handoff = null;
		return handoff;
	}

	/** 若仍有交接则使其过期（测试也用）。 */
	expireNow(): Promise<void> {
		this.clearExpireTimer();
		const handoff = this.handoff;
		this.handoff = null;
		if (handoff) {
			return handoff.cleanup();
		}
		return Promise.resolve();
	}

	private expire(): void {
		this.expireTimer = null;
		const handoff = this.handoff;
		this.handoff = null;
		if (handoff) {
			void handoff.cleanup();
		}
	}

	private clearExpireTimer(): void {
		if (this.expireTimer) {
			clearTimeout(this.expireTimer);
			this.expireTimer = null;
		}
	}
}

/**
 * 以 Symbol.for 为键的进程级注册表：reload 后的扩展代码（全新模块实例）
 * 能找到旧 runtime 发布的槽位。
 */
export function getReloadHandoffRegistry(): ReloadHandoffRegistry {
	const holder = globalThis as Record<symbol, ReloadHandoffRegistry | undefined>;
	const existing = holder[RELOAD_HANDOFF_SYMBOL];
	if (existing) {
		return existing;
	}
	const registry = new ReloadHandoffRegistry();
	holder[RELOAD_HANDOFF_SYMBOL] = registry;
	return registry;
}
