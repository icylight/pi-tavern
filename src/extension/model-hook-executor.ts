/**
 * model hook 执行器装配（#180，契约 §10）——adapter 层：pi 侧能力归一为
 * 六方法注入接口（已冻结），队列不感知 pi 异常形态。
 *
 * - resolveModel/getModelIdentity 走 ctx（modelRegistry.find / ctx.model）：
 *   经不可重赋值闭包实时取值（组合根持有最新 ctx，防值拷贝陷阱）；
 * - applyModel/applyThinking 走 pi API（会话作用域，不写 settings）；
 * - notifyWarning = 单一 warning 通道（由入口装配：命令 ctx.ui.notify /
 *   headless stderr）；
 * - ctx 不可用（跨 reload 旧引用、RPC 早期窗口）或调用抛错 → 返回 undefined，
 *   归一为「观测失败」交给队列提示，不让异常逃逸出执行器表面。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelIdentity, ModelTransitionExecutor } from "../character/model-transition-queue.js";

export interface ModelTransitionExecutorOptions {
	pi: ExtensionAPI;
	/** 最新 ExtensionContext（session_start 捕获；未就绪/已失效时 undefined）。 */
	getContext: () => ExtensionContext | undefined;
	notifyWarning: (message: string) => void;
}

export function createModelTransitionExecutor(options: ModelTransitionExecutorOptions): ModelTransitionExecutor {
	const { pi, getContext, notifyWarning } = options;
	/** ctx 读取归一：未就绪、已失效（reload 后旧 runner assertActive 抛错）→ undefined。 */
	const readContext = <T>(read: (ctx: ExtensionContext) => T): T | undefined => {
		try {
			const ctx = getContext();
			return ctx === undefined ? undefined : read(ctx);
		} catch {
			return undefined;
		}
	};

	return {
		getModelIdentity: () =>
			readContext((ctx): ModelIdentity | undefined => {
				const model = ctx.model;
				return model === undefined ? undefined : { provider: model.provider, id: model.id };
			}),
		getThinkingLevel: () => {
			try {
				return pi.getThinkingLevel();
			} catch {
				return undefined;
			}
		},
		resolveModel: (provider, id) => readContext((ctx) => ctx.modelRegistry.find(provider, id)),
		applyModel: (model) => pi.setModel(model as Parameters<ExtensionAPI["setModel"]>[0]),
		applyThinking: (level) => pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]),
		notifyWarning,
	};
}
