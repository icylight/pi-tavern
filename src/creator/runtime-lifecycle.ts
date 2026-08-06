import type WebSocket from "ws";
import type { WebSocketServer } from "ws";

import type { ActiveGroupChatDescriptor } from "../data/discovery/active-descriptor.js";
import { removeOwnedActiveDescriptor } from "../data/discovery/active-descriptor.js";
import type { GroupChatState } from "../data/group-chat-state.js";
import { JSONRPC_VERSION } from "../protocol/messages.js";
import {
	ERROR_CREATOR_RUNTIME_DETACHED,
	ERROR_GROUP_CHAT_CLOSED,
	METHOD_GROUP_CHAT_CLOSED,
} from "../shared/messages.js";
import type { RuntimeCloseReason, RuntimeCloseResult } from "../shared/runtime-close.js";
import type { BroadcastHub } from "./broadcast-hub.js";
import type { HeartbeatRegistry } from "./heartbeat-registry.js";
import { closeWebSocketServer } from "./ws-utils.js";

/** 生命周期流程访问的骨架窄接口（结构类型；模块不 import CreatorRuntime 类本身）。 */
export interface RuntimeLifecycleHost {
	/** 生命周期 getter（构造期值拷贝会冻结守卫判定——Arch A.2，须调用时读取）。 */
	readLifecycle: () => "active" | "detaching" | "disposed";
	setLifecycle: (value: "active" | "detaching" | "disposed") => void;
	heartbeatRegistry: HeartbeatRegistry;
	broadcastHub: BroadcastHub;
	state: GroupChatState;
	webSocketServer: WebSocketServer;
	connections: Map<string, WebSocket>;
	activeDescriptor: ActiveGroupChatDescriptor;
	activeDescriptorPath: string;
	deps: { drainTimeoutMs: number };
	/** 运行时串行队列尾 getter（骨架持有；drain 等待其排空——取值须在调用时，测试期队列会继续增长）。 */
	readRuntimeTail: () => Promise<unknown>;
	enqueue: <T>(operation: () => T | Promise<T>) => Promise<T>;
}

/**
 * 永久终止流程（PR-B 拆自 CreatorRuntime.close/performClose/drain）。
 * 幂等：并发调用共享同一结果；先排空队列（受协调超时约束），队列永不排空
 * 时本地清理仍强制完成。
 */
export class RuntimeLifecycle {
	private readonly host: RuntimeLifecycleHost;
	private closePromise: Promise<RuntimeCloseResult> | null = null;

	constructor(host: RuntimeLifecycleHost) {
		this.host = host;
	}

	close(reason: RuntimeCloseReason = "user_leave"): Promise<RuntimeCloseResult> {
		this.closePromise ??= this.performClose(reason);
		return this.closePromise;
	}

	private async performClose(_reason: RuntimeCloseReason): Promise<RuntimeCloseResult> {
		if (this.host.readLifecycle() === "detaching") {
			// close() 与 detachForReload() 是互斥路径。
			throw new Error(ERROR_CREATOR_RUNTIME_DETACHED);
		}
		const errors: Error[] = [];
		this.host.setLifecycle("disposed");
		this.host.heartbeatRegistry.stop();
		const timedOut = await this.drainRuntimeQueue(this.host.deps.drainTimeoutMs);

		try {
			this.host.broadcastHub.broadcast({
				jsonrpc: JSONRPC_VERSION,
				method: METHOD_GROUP_CHAT_CLOSED,
				params: {
					group_chat_id: this.host.state.groupChat.groupChatId,
				},
			});
		} catch (error) {
			errors.push(asError(error));
		}
		for (const socket of this.host.webSocketServer.clients) {
			socket.close(1001, ERROR_GROUP_CHAT_CLOSED);
		}
		await closeWebSocketServer(this.host.webSocketServer);
		this.host.connections.clear();
		this.host.state.onlineCharacters.clear();
		this.host.state.characterReservations.clear();
		this.host.heartbeatRegistry.clear();
		try {
			await removeOwnedActiveDescriptor(this.host.activeDescriptorPath, this.host.activeDescriptor.instanceId);
		} catch (error) {
			errors.push(asError(error));
		}
		return { timedOut, errors };
	}

	/** 等待运行时队列排空，最长 timeoutMs；超时返回 true。 */
	async drainRuntimeQueue(timeoutMs: number): Promise<boolean> {
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				this.host.readRuntimeTail().then(() => false),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(true), timeoutMs);
					timer.unref?.();
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
