import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WebSocketServer } from "ws";

import {
	type ActiveGroupChatDescriptor,
	getActiveDescriptorPath,
	getGroupChatSessionDirectory,
	publishActiveDescriptor,
	removeOwnedActiveDescriptor,
	updateActiveDescriptorName,
} from "../discovery/active-descriptor.js";
import {
	createGroupChatState,
	type GroupChatState,
	normalizeGroupChatName,
	setGroupChatName,
	setGroupMaxMessages,
} from "./group-chat-state.js";

export interface StartNewCreatorRuntimeOptions {
	cwd: string;
	agentDir: string;
	configMaxMessages?: number;
}

export interface CreatorRuntimeDependencies {
	createId: () => string;
	now: () => Date;
	pid: number;
	publishDescriptor: (agentDir: string, descriptor: ActiveGroupChatDescriptor) => Promise<string>;
}

const DEFAULT_CONFIG_MAX_MESSAGES = 10;

export class CreatorRuntime {
	readonly webSocketServer: WebSocketServer;
	readonly groupSessionManager: SessionManager;
	readonly state: GroupChatState;
	readonly activeDescriptor: ActiveGroupChatDescriptor;
	readonly activeDescriptorPath: string;

	private closePromise: Promise<void> | null = null;

	private constructor(
		webSocketServer: WebSocketServer,
		groupSessionManager: SessionManager,
		state: GroupChatState,
		activeDescriptor: ActiveGroupChatDescriptor,
		activeDescriptorPath: string,
	) {
		this.webSocketServer = webSocketServer;
		this.groupSessionManager = groupSessionManager;
		this.state = state;
		this.activeDescriptor = activeDescriptor;
		this.activeDescriptorPath = activeDescriptorPath;
	}

	static async startNew(
		options: StartNewCreatorRuntimeOptions,
		dependencyOverrides: Partial<CreatorRuntimeDependencies> = {},
	): Promise<CreatorRuntime> {
		const dependencies: CreatorRuntimeDependencies = {
			createId: randomUUID,
			now: () => new Date(),
			pid: process.pid,
			publishDescriptor: publishActiveDescriptor,
			...dependencyOverrides,
		};
		const groupChatId = dependencies.createId();
		const instanceId = dependencies.createId();
		const createdAt = dependencies.now().toISOString();
		const cwd = resolve(options.cwd);
		const state = createGroupChatState({
			groupChatId,
			createdAt,
			groupMaxMessages: options.configMaxMessages ?? DEFAULT_CONFIG_MAX_MESSAGES,
		});
		const groupSessionManager = SessionManager.create(cwd, getGroupChatSessionDirectory(options.agentDir, cwd), {
			id: groupChatId,
		});
		const webSocketServer = await listenOnLocalhost();
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
		const expectedDescriptorPath = getActiveDescriptorPath(options.agentDir, cwd, groupChatId);

		try {
			const activeDescriptorPath = await dependencies.publishDescriptor(options.agentDir, activeDescriptor);
			return new CreatorRuntime(webSocketServer, groupSessionManager, state, activeDescriptor, activeDescriptorPath);
		} catch (error) {
			await removeOwnedActiveDescriptor(expectedDescriptorPath, instanceId);
			await closeWebSocketServer(webSocketServer);
			throw error;
		}
	}

	async setName(name: string): Promise<string | null> {
		const normalizedName = normalizeGroupChatName(name);
		await updateActiveDescriptorName(this.activeDescriptorPath, this.activeDescriptor.instanceId, normalizedName);
		setGroupChatName(this.state, name);
		this.activeDescriptor.name = normalizedName;
		return normalizedName;
	}

	setMaxMessages(maxMessages: number): void {
		setGroupMaxMessages(this.state, maxMessages);
	}

	close(): Promise<void> {
		this.closePromise ??= this.closePermanently();
		return this.closePromise;
	}

	private async closePermanently(): Promise<void> {
		await closeWebSocketServer(this.webSocketServer);
		await removeOwnedActiveDescriptor(this.activeDescriptorPath, this.activeDescriptor.instanceId);
	}
}

async function listenOnLocalhost(): Promise<WebSocketServer> {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });

	try {
		await new Promise<void>((resolve, reject) => {
			const onListening = (): void => {
				server.off("error", onError);
				resolve();
			};
			const onError = (error: Error): void => {
				server.off("listening", onListening);
				reject(error);
			};

			server.once("listening", onListening);
			server.once("error", onError);
		});
		return server;
	} catch (error) {
		await closeWebSocketServer(server);
		throw error;
	}
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
	if (server.address() === null) {
		return;
	}

	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
}
