import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

/**
 * #201：可消费型 mock pi——`sendMessage` 录制（vi.fn，与既有替身同形）+ `on`
 * 注册，`emitConsumption()` 模拟 pi 把已入队批次推入 agent 上下文（agent-loop
 * 在消费点 emit `message_start`，载荷 `{ message }`），`dropQueued()` 模拟
 * clearAllQueues 静默丢弃（无返还、无事件）。
 *
 * 生产语义：游标只在消费确认时推进（`GroupChatInput.confirmBatchConsumed`）——
 * 断言「投递后游标推进」的用例须显式 `emitConsumption()`；断言丢弃后重拉的
 * 用例用 `dropQueued()`。
 */
export interface ConsumableMockPi {
	pi: ExtensionAPI;
	/** 对全部未处置批次 fire message_start（重复调用只处理新增批次）。 */
	emitConsumption(): void;
	/** 直接派发 message_start（构造降级 / 旧格式载荷用）。 */
	emitMessageStart(payload: unknown): void;
	/** 静默丢弃未处置批次（不发消费事件）。 */
	dropQueued(): void;
}

/** pi 实例 → 替身句柄（同文件测试可继续用 `createMockPi(): ExtensionAPI` 原调用形态）。 */
const harnesses = new WeakMap<ExtensionAPI, ConsumableMockPi>();

export function createConsumableMockPi(): ConsumableMockPi {
	const api = buildConsumableMockPi();
	harnesses.set(api.pi, api);
	return api;
}

/** 对任意由 `createConsumableMockPi` 创建的替身派发消费事件（按 pi 实例查找）。 */
export function emitBatchConsumption(pi: ExtensionAPI): void {
	harnesses.get(pi)?.emitConsumption();
}

/** 对任意由 `createConsumableMockPi` 创建的替身静默丢弃未处置批次。 */
export function dropQueuedBatches(pi: ExtensionAPI): void {
	harnesses.get(pi)?.dropQueued();
}

function buildConsumableMockPi(): ConsumableMockPi {
	const handlers = new Map<string, Array<(payload: unknown) => void>>();
	let handled = 0;
	const sendMessage = vi.fn(async () => undefined);
	const pi = {
		sendMessage,
		on: (event: string, handler: (payload: unknown) => void) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				handlers.set(
					event,
					(handlers.get(event) ?? []).filter((entry) => entry !== handler),
				);
			};
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		emitMessageStart: (payload: unknown) => {
			for (const handler of handlers.get("message_start") ?? []) handler(payload);
		},
		emitConsumption: () => {
			// mockClear 后调用记录重基——已处置指针不得越过新的调用数（否则静默跳过）。
			if (sendMessage.mock.calls.length < handled) handled = 0;
			for (let index = handled; index < sendMessage.mock.calls.length; index += 1) {
				const message = (sendMessage.mock.calls[index] as unknown[])[0];
				for (const handler of handlers.get("message_start") ?? []) handler({ message });
			}
			handled = sendMessage.mock.calls.length;
		},
		dropQueued: () => {
			handled = sendMessage.mock.calls.length;
		},
	};
}
