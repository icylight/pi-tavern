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
			if (Date.now() > deadline) {
				throw new Error("timeout waiting for WebSocket message");
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

/** Connect a raw WebSocket client and complete the join flow. */
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
	client.send({ id: "1", type: "join_group_chat", session_id: sessionId });
	await client.waitFor((m) => m.type === "response" && m.command === "join_group_chat");
	client.send({ id: "2", type: "claim_character", character_id: characterId });
	await client.waitFor((m) => m.type === "response" && m.command === "claim_character");
	client.send({ id: "3", type: "character_ready" });
	await client.waitFor((m) => m.type === "response" && m.command === "character_ready");
	return client;
}
