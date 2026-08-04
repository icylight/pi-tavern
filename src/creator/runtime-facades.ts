import type { ActiveGroupChatDescriptor } from "../data/discovery/active-descriptor.js";
import { updateActiveDescriptorName } from "../data/discovery/active-descriptor.js";
import {
	assertValidMaxMessages,
	type GroupChatState,
	normalizeGroupChatName,
	setGroupChatName,
	setGroupMaxMessages,
} from "../data/group-chat-state.js";
import type { SessionStore } from "../data/session-store.js";
import { SubmitMessagePipeline } from "./creator-pipelines/submit-message-pipeline.js";

/** 门面 API 访问的骨架窄接口（结构类型；模块不 import CreatorRuntime 类本身）。 */
export interface RuntimeFacadesHost {
	state: GroupChatState;
	sessionStore: SessionStore;
	activeDescriptor: ActiveGroupChatDescriptor;
	activeDescriptorPath: string;
	persistedCount: { get: () => number; add: (delta: number) => void };
	submitMessageDeps: ConstructorParameters<typeof SubmitMessagePipeline>[0];
	enqueue: <T>(operation: () => T | Promise<T>) => Promise<T>;
}

/** 公开门面 API（PR-B 拆自 CreatorRuntime.setName/setMaxMessages/submitUserPersonaMessage）。 */
export class RuntimeFacades {
	private readonly host: RuntimeFacadesHost;

	constructor(host: RuntimeFacadesHost) {
		this.host = host;
	}

	setName(name: string): Promise<string | null> {
		return this.host.enqueue(async () => {
			const normalizedName = normalizeGroupChatName(name);

			// 空群聊：仅更新内存（尚无文件）
			if (!this.host.persistedCount.get()) {
				await updateActiveDescriptorName(
					this.host.activeDescriptorPath,
					this.host.activeDescriptor.instanceId,
					normalizedName,
				);
				setGroupChatName(this.host.state, name);
				this.host.activeDescriptor.name = normalizedName;
				return normalizedName;
			}

			this.host.sessionStore.assertWritable();

			// 活跃群聊：经 session-store 持久化条目
			try {
				this.host.sessionStore.appendSessionInfo(normalizedName ?? "");
			} catch (error) {
				this.host.sessionStore.recoverFromFailedAppend(error);
			}
			this.host.persistedCount.add(1);

			// 持久化成功后提交内存状态（权威）
			setGroupChatName(this.host.state, name);
			this.host.activeDescriptor.name = normalizedName;

			// 尽力而为的 descriptor 更新（发现投影；失败非致命）
			try {
				await updateActiveDescriptorName(
					this.host.activeDescriptorPath,
					this.host.activeDescriptor.instanceId,
					normalizedName,
				);
			} catch {
				// descriptor 更新失败，但内存与 JSONL 一致
			}

			return normalizedName;
		});
	}

	setMaxMessages(maxMessages: number): Promise<void> {
		return this.host.enqueue(async () => {
			// 在任何持久化/状态变更之前校验：非法值绝不能写入 JSONL 或推进
			// persistedCount（BC-18）。
			assertValidMaxMessages(maxMessages);

			// 空群聊：仅更新内存
			if (!this.host.persistedCount.get()) {
				setGroupMaxMessages(this.host.state, maxMessages);
				return;
			}

			this.host.sessionStore.assertWritable();

			// 活跃群聊：经 session-store 持久化条目
			try {
				this.host.sessionStore.appendCustomEntry("pi-tavern.group-settings", {
					group_max_messages: maxMessages,
				});
			} catch (error) {
				this.host.sessionStore.recoverFromFailedAppend(error);
			}
			this.host.persistedCount.add(1);

			setGroupMaxMessages(this.host.state, maxMessages);
		});
	}

	submitUserPersonaMessage(content: string): Promise<string> {
		// 请求级管线实例：校验 → 持久化（first-persist/append）→ 提交 → 广播/投影
		return this.host.enqueue(() => new SubmitMessagePipeline(this.host.submitMessageDeps).runUserPersona(content));
	}
}
