import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG_MAX_MESSAGES, loadTavernConfig } from "../config/load-config.js";
import type { CreatorReloadHandoff } from "../controller/reload-handoff-registry.js";
import { countPersistedEntries } from "../data/cursor-store.js";
import type { ActiveGroupChatDescriptor } from "../data/discovery/active-descriptor.js";
import {
	getActiveDescriptorPath,
	getGroupChatSessionDirectory,
	publishActiveDescriptor,
	readActiveDescriptor,
	removeOwnedActiveDescriptor,
} from "../data/discovery/active-descriptor.js";
import { createGroupChatState, type GroupChatState } from "../data/group-chat-state.js";
import { SessionStore } from "../data/session-store.js";
import type { PublicMessageState } from "../protocol/public-message-state.js";
import {
	HEARTBEAT_PING_INTERVAL_MS,
	HEARTBEAT_TIMEOUT_MS,
	SHORT_COORDINATION_TIMEOUT_MS,
} from "../shared/constants.js";
import type { ResumeCreatorRuntimeOptions, StartNewCreatorRuntimeOptions } from "./creator-runtime.js";
import { CreatorRuntime, type CreatorRuntimeDependencies } from "./creator-runtime.js";
import { closeWebSocketServer, listenOnLocalhost } from "./ws-utils.js";

/** 默认依赖装配（startNew/resume 共用；测试经 overrides 注入）。 */
export function buildCreatorDependencies(
	overrides: Partial<CreatorRuntimeDependencies> = {},
): CreatorRuntimeDependencies {
	return {
		createId: randomUUID,
		now: () => new Date(),
		pid: process.pid,
		readyTimeoutMs: SHORT_COORDINATION_TIMEOUT_MS,
		publishDescriptor: publishActiveDescriptor,
		writeFile: (path, data) => writeFile(path, data),
		rm: (path) => rm(path, { force: true }),
		heartbeatIntervalMs: HEARTBEAT_PING_INTERVAL_MS,
		heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
		drainTimeoutMs: SHORT_COORDINATION_TIMEOUT_MS,
		...overrides,
	};
}

/** 新建群聊装配（PR-B：拆自 CreatorRuntime.startNew，组合根/controller 经公开 API 调用）。 */
export async function createNewRuntime(
	options: StartNewCreatorRuntimeOptions,
	dependencies: CreatorRuntimeDependencies,
): Promise<CreatorRuntime> {
	// #25：懒刷新默认装配——优先 options 注入，其次 dependencies 覆盖，
	// 兜底真实磁盘重扫（组合根语义）。失败/空结果由
	// CreatorRuntime.refreshCharacters 内部回退旧快照。
	const runtimeDeps: CreatorRuntimeDependencies = {
		...dependencies,
		loadCharacters:
			options.loadCharacters ??
			dependencies.loadCharacters ??
			(() => loadTavernConfig({ agentDir: options.agentDir, cwd: options.cwd }).then((config) => config.characters)),
	};
	const groupChatId = runtimeDeps.createId();
	const instanceId = runtimeDeps.createId();
	const createdAt = runtimeDeps.now().toISOString();
	const cwd = resolve(options.cwd);
	const configMaxMessages = options.configMaxMessages ?? DEFAULT_CONFIG_MAX_MESSAGES;
	const state = createGroupChatState({
		groupChatId,
		createdAt,
		groupMaxMessages: configMaxMessages,
	});
	const sessionStore = SessionStore.create(
		SessionManager,
		cwd,
		getGroupChatSessionDirectory(options.agentDir, cwd),
		{ id: groupChatId },
		{ writeFile: dependencies.writeFile, rm: dependencies.rm },
	);
	const webSocketServer = await listenOnLocalhost(`/${groupChatId}/${instanceId}`);
	const address = webSocketServer.address() as AddressInfo;
	const activeDescriptor: ActiveGroupChatDescriptor = {
		instanceId,
		groupChatId,
		name: null,
		cwd,
		pid: dependencies.pid,
		host: "127.0.0.1",
		port: address.port,
		startedAt: createdAt,
	};
	const activeDescriptorPath = getActiveDescriptorPath(options.agentDir, cwd, groupChatId);
	const runtime = new CreatorRuntime(
		webSocketServer,
		sessionStore,
		state,
		activeDescriptor,
		activeDescriptorPath,
		configMaxMessages,
		options.characters ?? [],
		runtimeDeps.readyTimeoutMs,
		runtimeDeps,
	);

	try {
		await dependencies.publishDescriptor(options.agentDir, activeDescriptor);
		runtime.connectionManager.attach(runtime.webSocketServer);
		return runtime;
	} catch (error) {
		await removeOwnedActiveDescriptor(activeDescriptorPath, instanceId);
		await closeWebSocketServer(webSocketServer);
		throw error;
	}
}

/**
 * 从群聊历史 JSONL 文件恢复此前持久化的群聊。从会话条目重建 name、
 * groupMaxMessages、Round、next sequence 与公开消息列表；分配全新
 * instance_id 与端口；不恢复任何成员连接。发布 active descriptor 即
 * 原子排他声明——并发 resume 的群聊在硬链接竞争上失败。
 */
export async function resumeRuntime(
	options: ResumeCreatorRuntimeOptions,
	dependencies: CreatorRuntimeDependencies,
): Promise<CreatorRuntime> {
	// #25：同 createNewRuntime——懒刷新默认装配（options 注入优先，兜底磁盘重扫）。
	const runtimeDeps: CreatorRuntimeDependencies = {
		...dependencies,
		loadCharacters:
			options.loadCharacters ??
			dependencies.loadCharacters ??
			(() => loadTavernConfig({ agentDir: options.agentDir, cwd: options.cwd }).then((config) => config.characters)),
	};
	const cwd = resolve(options.cwd);
	const configMaxMessages = options.configMaxMessages ?? DEFAULT_CONFIG_MAX_MESSAGES;
	// 前置拒绝缺失/空文件：SessionManager.open() 在文件不存在或为空时静默
	// 创建全新随机会话，会导致为幽灵群聊发布 active descriptor。
	const sessionStat = statSync(options.sessionPath, { throwIfNoEntry: false });
	if (!sessionStat?.isFile() || sessionStat.size === 0) {
		throw new Error(`Group chat session file does not exist or is empty: ${options.sessionPath}`);
	}
	const sessionStore = SessionStore.open(
		SessionManager,
		options.sessionPath,
		getGroupChatSessionDirectory(options.agentDir, cwd),
		cwd,
		{ writeFile: dependencies.writeFile, rm: dependencies.rm },
	);
	const header = sessionStore.getHeader();
	if (!header?.id) {
		throw new Error("Group chat session file has no id header");
	}

	// 活跃实例排他：已活跃的群聊不可被 resume。
	const activeDescriptorPath = getActiveDescriptorPath(options.agentDir, cwd, header.id);
	const existingActive = await readActiveDescriptor(activeDescriptorPath);
	if (existingActive) {
		throw new Error(`Group chat ${header.id} is already active; leave the active group chat before resuming`);
	}

	// 按文件顺序扫描会话条目重建 PiTavern 扩展状态。
	const entries = sessionStore.getEntries();
	const publicMessages: PublicMessageState[] = [];
	let name: string | null = null;
	let groupMaxMessages = configMaxMessages;
	let round: GroupChatState["round"] = null;
	let nextSequence = 0;
	const persistedCount = countPersistedEntries(entries);
	for (const entry of entries) {
		if (entry.type === "session_info") {
			name = entry.name?.trim() || null;
		} else if (entry.type === "custom" && entry.customType === "pi-tavern.group-settings") {
			const max = (entry.data as { group_max_messages?: number } | undefined)?.group_max_messages;
			if (typeof max === "number" && Number.isSafeInteger(max) && max >= 0) {
				groupMaxMessages = max;
			}
		} else if (entry.type === "custom_message" && entry.customType === "pi-tavern.public-message") {
			const details = entry.details as
				| {
						sender: { type: "user_persona" } | { type: "character"; character_id: string; name: string };
						content: string;
						sequence: number;
						round: {
							round_max_messages: number;
							used_messages: number;
							remaining_messages: number;
						};
				  }
				| undefined;
			if (!details || typeof details.sequence !== "number") {
				continue;
			}
			publicMessages.push({
				sender: details.sender,
				content: details.content,
				event_id: entry.id,
				sequence: details.sequence,
				timestamp: entry.timestamp,
				round: details.round,
			});
			nextSequence = details.sequence;
			round = {
				roundMaxMessages: details.round.round_max_messages,
				usedMessages: details.round.used_messages,
			};
		}
	}

	const createdAt = header.timestamp;
	const state = createGroupChatState({
		groupChatId: header.id,
		createdAt,
		groupMaxMessages,
	});
	state.groupChat.name = name;
	state.round = round;
	state.nextSequence = nextSequence;

	// 全新运行时身份：新 instance_id 与新端口；无成员连接。
	const instanceId = dependencies.createId();
	const startedAt = dependencies.now().toISOString();
	const webSocketServer = await listenOnLocalhost(`/${header.id}/${instanceId}`);
	const address = webSocketServer.address() as AddressInfo;
	const activeDescriptor: ActiveGroupChatDescriptor = {
		instanceId,
		groupChatId: header.id,
		name,
		cwd,
		pid: dependencies.pid,
		host: "127.0.0.1",
		port: address.port,
		startedAt,
	};
	const runtime = new CreatorRuntime(
		webSocketServer,
		sessionStore,
		state,
		activeDescriptor,
		activeDescriptorPath,
		configMaxMessages,
		options.characters ?? [],
		runtimeDeps.readyTimeoutMs,
		runtimeDeps,
		{ publicMessages, persistedCount },
	);

	try {
		await dependencies.publishDescriptor(options.agentDir, activeDescriptor);
		runtime.connectionManager.attach(runtime.webSocketServer);
		return runtime;
	} catch (error) {
		await removeOwnedActiveDescriptor(activeDescriptorPath, instanceId);
		await closeWebSocketServer(webSocketServer);
		throw error;
	}
}

/** reload handoff 装配（PR-B：拆自 CreatorRuntime.takeHandoff 的构造段）。 */
export function createFromHandoff(
	handoff: CreatorReloadHandoff,
	dependencyOverrides: Partial<CreatorRuntimeDependencies> = {},
): CreatorRuntime {
	const dependencies = buildCreatorDependencies(dependencyOverrides);
	const sessionStore = new SessionStore(handoff.groupSessionManager, SessionManager, {
		writeFile: dependencies.writeFile,
		rm: dependencies.rm,
	});
	return new CreatorRuntime(
		handoff.webSocketServer,
		sessionStore,
		handoff.groupChatState,
		handoff.activeDescriptor,
		handoff.activeDescriptorPath,
		handoff.configMaxMessages,
		handoff.characters,
		dependencies.readyTimeoutMs,
		dependencies,
		{ publicMessages: handoff.publicMessages, persistedCount: handoff.persistedCount },
	);
}
