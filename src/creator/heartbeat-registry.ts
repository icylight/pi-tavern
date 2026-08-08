import type WebSocket from "ws";

/** 成员心跳簿记（时间为 epoch 毫秒）。 */
interface HeartbeatState {
	lastPongAt: number;
}

interface HeartbeatRegistryOptions {
	/** 心跳 ping 间隔（默认 30s）。 */
	intervalMs: number;
	/** Pong 超时阈值（默认 120s）；超时成员被终止。 */
	timeoutMs: number;
	now: () => Date;
	/** 按 sessionId 取在线 socket（tick 发 ping 用；不存在则跳过）。 */
	getSocket: (sessionId: string) => WebSocket | undefined;
	/** 半开连接超时处置（terminate 触发 close → 统一断连清理）。 */
	onStale: (sessionId: string) => void;
}

/**
 * 成员心跳簿记 + 定时器（PR-B 拆自 CreatorRuntime）。
 * 无状态语义：簿记与处置动作经回调注入，不持有连接表本身。
 */
export class HeartbeatRegistry {
	private readonly states = new Map<string, HeartbeatState>();
	private readonly options: HeartbeatRegistryOptions;
	private timer: NodeJS.Timeout | null = null;

	constructor(options: HeartbeatRegistryOptions) {
		this.options = options;
	}

	start(): void {
		if (this.timer) {
			return;
		}
		this.timer = setInterval(() => this.tick(), this.options.intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** 成员首次就绪时登记簿记（初始 lastPongAt = now）。 */
	register(sessionId: string): void {
		this.states.set(sessionId, { lastPongAt: this.options.now().getTime() });
	}

	recordPong(sessionId: string): void {
		const state = this.states.get(sessionId);
		if (state) {
			state.lastPongAt = this.options.now().getTime();
		}
	}

	remove(sessionId: string): void {
		this.states.delete(sessionId);
	}

	clear(): void {
		this.states.clear();
	}

	/** reload handoff 快照（与 v1 共享数据形状一致：plain Map）。 */
	snapshot(): Map<string, { lastPongAt: number }> {
		const out = new Map<string, { lastPongAt: number }>();
		for (const [sessionId, state] of this.states) {
			out.set(sessionId, { lastPongAt: state.lastPongAt });
		}
		return out;
	}

	restore(entries: Map<string, { lastPongAt: number }>): void {
		for (const [sessionId, state] of entries) {
			this.states.set(sessionId, { lastPongAt: state.lastPongAt });
		}
	}

	private tick(): void {
		const now = this.options.now().getTime();
		for (const [sessionId, state] of this.states) {
			if (now - state.lastPongAt > this.options.timeoutMs) {
				// 半开连接：terminate 触发 close → 统一断连清理。
				this.options.onStale(sessionId);
				continue;
			}
			this.options.getSocket(sessionId)?.ping();
		}
	}
}
