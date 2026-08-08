import WebSocket from "ws";

import type { ActiveGroupChatDescriptor } from "../../src/data/discovery/active-descriptor.js";

/**
 * 缓冲接收到的每一帧的裸 WebSocket 客户端（ws 会丢弃
 * 在监听器挂载之前到达的帧，因此加入时的帧必须从
 * 第一条消息起就捕获）。
 */
export class BufferedWsClient {
	private readonly frames: Record<string, unknown>[] = [];
	private readonly frameWaiters: Array<() => void> = [];

	constructor(readonly socket: WebSocket) {
		socket.on("message", (data) => {
			const message = JSON.parse(data.toString()) as Record<string, unknown>;
			this.frames.push(message);
			for (const waiter of [...this.frameWaiters]) waiter();
		});
	}

	allFrames(): Record<string, unknown>[] {
		return [...this.frames];
	}

	async waitFor(
		predicate: (message: Record<string, unknown>) => boolean,
		timeoutMs = 30_000,
		fromIndex = 0,
	): Promise<Record<string, unknown>> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const existing = this.frames.slice(fromIndex).find(predicate);
			if (existing) {
				return existing;
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				throw new Error("timeout waiting for WebSocket message");
			}
			// 基建修复（QA 2026-08-08，#123 定位）：无新帧到达时 waiter 永不
			// resolve、deadline 永不检查（原实现超时形同虚设——测试挂起而非
			// 明确报错）。独立 timer 保证超时真正生效，帧到达路径清除 timer。
			await new Promise<void>((resolveWait) => {
				const timer = setTimeout(resolveWait, remaining);
				const waiter = (): void => {
					clearTimeout(timer);
					const index = this.frameWaiters.indexOf(waiter);
					if (index !== -1) this.frameWaiters.splice(index, 1);
					resolveWait();
				};
				this.frameWaiters.push(waiter);
			});
		}
	}

	async collect(
		predicate: (message: Record<string, unknown>) => boolean,
		count: number,
		timeoutMs = 30_000,
		fromIndex = 0,
	): Promise<Record<string, unknown>[]> {
		const collected: Record<string, unknown>[] = [];
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const matched = this.frames.slice(fromIndex).filter((m) => !collected.includes(m) && predicate(m));
			collected.push(...matched);
			if (collected.length >= count) {
				return collected.slice(0, count);
			}
			if (Date.now() > deadline) {
				throw new Error("timeout collecting WebSocket messages");
			}
			await new Promise<void>((resolveWait) => {
				const waiter = (): void => {
					const index = this.frameWaiters.indexOf(waiter);
					if (index !== -1) this.frameWaiters.splice(index, 1);
					resolveWait();
				};
				this.frameWaiters.push(waiter);
			});
		}
	}

	send(message: Record<string, unknown>): void {
		this.socket.send(JSON.stringify(message));
	}

	terminate(): void {
		this.socket.terminate();
	}
}

/** 连接裸 WebSocket 客户端并完成加入流程。 */
export async function joinCharacterWs(
	descriptor: ActiveGroupChatDescriptor,
	sessionId: string,
	characterId: string,
): Promise<BufferedWsClient> {
	const client = new BufferedWsClient(
		new WebSocket(
			`ws://${descriptor.host}:${descriptor.port}/` +
				`${encodeURIComponent(descriptor.groupChatId)}/${encodeURIComponent(descriptor.instanceId)}`,
		),
	);
	await new Promise<void>((resolveOpen, rejectOpen) => {
		client.socket.once("open", () => resolveOpen());
		client.socket.once("error", (error) => rejectOpen(error));
	});
	client.send({ jsonrpc: "2.0", id: "1", method: "join_group_chat", params: { session_id: sessionId } });
	await client.waitFor((m) => m.id === "1" && "result" in m);
	client.send({ jsonrpc: "2.0", id: "2", method: "claim_character", params: { character_id: characterId } });
	await client.waitFor((m) => m.id === "2" && "result" in m);
	client.send({ jsonrpc: "2.0", id: "3", method: "character_ready" });
	await client.waitFor((m) => m.id === "3" && "result" in m);
	return client;
}
