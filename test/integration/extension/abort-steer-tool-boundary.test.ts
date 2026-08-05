import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
	type AgentContext,
	type AgentMessage,
	type AgentTool,
	agentLoop,
	type StreamFn,
} from "../../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "../../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";

import { ABORT_CONTROL_CUSTOM_TYPE } from "../../../src/character/group-chat-input.js";
import { wireAgentLifecycle } from "../../../src/extension/agent-lifecycle.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected assistant stream event");
			},
		);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "abort-boundary-test",
		name: "abort-boundary-test",
		api: "openai-responses",
		provider: "test",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "test",
		model: "abort-boundary-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function toLlmMessages(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("steer 隐藏令牌的真实工具安全边界", () => {
	it("工具未结束时不 abort；工具完成后、下一 provider 请求前 abort", async () => {
		const order: string[] = [];
		const toolStarted = deferred();
		const releaseTool = deferred();
		const abortController = new AbortController();
		let contextHandler:
			| ((event: { messages: AgentMessage[] }, ctx: { abort: () => void }) => { messages: AgentMessage[] })
			| undefined;
		let abortCount = 0;
		const consumeAbortControlToken = vi.fn((abort: () => void) => {
			abortCount += 1;
			order.push("abort");
			abort();
			return true;
		});
		const pi = {
			on: vi.fn((event: string, handler: unknown) => {
				if (event === "context") {
					contextHandler = handler as typeof contextHandler;
				}
			}),
		};
		const runtime = { groupChatInput: { consumeAbortControlToken } };
		wireAgentLifecycle(pi as never, { getState: () => ({ type: "character", runtime }) } as never);

		const token = {
			role: "custom",
			customType: ABORT_CONTROL_CUSTOM_TYPE,
			content: "",
			display: false,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		let tokenQueued = false;
		let tokenDrained = false;
		let toolSideEffects = 0;
		const parameters = Type.Object({});
		const tool: AgentTool<typeof parameters> = {
			name: "controlled_tool",
			label: "Controlled tool",
			description: "Waits until the test releases the current tool batch",
			parameters,
			execute: async () => {
				order.push("tool-start");
				toolStarted.resolve();
				await releaseTool.promise;
				toolSideEffects += 1;
				order.push("tool-complete");
				return { content: [{ type: "text", text: "completed" }], details: undefined };
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		let providerRequests = 0;
		let secondRequestSignalAborted = false;
		let secondRequestSawToken = false;
		const streamFn: StreamFn = (_model, llmContext, options) => {
			providerRequests += 1;
			const requestNumber = providerRequests;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (requestNumber === 1) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[{ type: "toolCall", id: "controlled-1", name: "controlled_tool", arguments: {} }],
							"toolUse",
						),
					});
					return;
				}
				order.push("provider-2");
				secondRequestSignalAborted = options?.signal?.aborted === true;
				secondRequestSawToken = llmContext.messages.some(
					(message) => (message as unknown as { customType?: string }).customType === ABORT_CONTROL_CUSTOM_TYPE,
				);
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([], "aborted"),
				});
			});
			return stream;
		};

		const run = agentLoop(
			[{ role: "user", content: "start", timestamp: Date.now() }],
			context,
			{
				model: createModel(),
				convertToLlm: toLlmMessages,
				transformContext: async (messages) => {
					if (!contextHandler) throw new Error("context lifecycle handler was not registered");
					return contextHandler({ messages }, { abort: () => abortController.abort() }).messages;
				},
				getSteeringMessages: async () => {
					if (!tokenQueued || tokenDrained) return [];
					tokenDrained = true;
					return [token];
				},
			},
			abortController.signal,
			streamFn,
		);
		const completion = (async () => {
			for await (const _event of run) {
				// 消费真实 agent-loop 事件，推动工具批与 steer 边界完成。
			}
		})();

		await toolStarted.promise;
		order.push("notification");
		tokenQueued = true;
		await Promise.resolve();
		expect(abortCount).toBe(0);
		expect(providerRequests).toBe(1);
		expect(toolSideEffects).toBe(0);

		releaseTool.resolve();
		await completion;

		expect(toolSideEffects).toBe(1);
		expect(consumeAbortControlToken).toHaveBeenCalledTimes(1);
		expect(secondRequestSignalAborted).toBe(true);
		expect(secondRequestSawToken).toBe(false);
		expect(order).toEqual(["tool-start", "notification", "tool-complete", "abort", "provider-2"]);
	});
});
