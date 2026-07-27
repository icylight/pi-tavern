import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import WebSocket from "ws";
import { SHORT_COORDINATION_TIMEOUT_MS } from "../shared/constants.js";
import {
	type ActiveGroupChatDescriptor,
	getActiveDescriptorDirectory,
	readActiveDescriptor,
	removeOwnedActiveDescriptor,
} from "./active-descriptor.js";

export interface DiscoverGroupChatsOptions {
	agentDir: string;
	cwd: string;
}

export interface DiscoverGroupChatsDependencies {
	isProcessAlive: (pid: number) => boolean;
	verifyDescriptor: (descriptor: ActiveGroupChatDescriptor) => Promise<boolean>;
}

export async function discoverGroupChats(
	options: DiscoverGroupChatsOptions,
	dependencyOverrides: Partial<DiscoverGroupChatsDependencies> = {},
): Promise<ActiveGroupChatDescriptor[]> {
	const dependencies: DiscoverGroupChatsDependencies = {
		isProcessAlive,
		verifyDescriptor,
		...dependencyOverrides,
	};
	const cwd = resolve(options.cwd);
	const activeDirectory = getActiveDescriptorDirectory(options.agentDir, cwd);
	let names: string[];
	try {
		names = await readdir(activeDirectory);
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return [];
		}
		throw new Error(`Failed to discover active PiTavern group chats: ${activeDirectory}`, {
			cause: error,
		});
	}
	names.sort();

	const candidates: ActiveGroupChatDescriptor[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) {
			continue;
		}
		const path = join(activeDirectory, name);
		let descriptor: ActiveGroupChatDescriptor | null;
		try {
			descriptor = await readActiveDescriptor(path);
		} catch {
			continue;
		}
		if (!descriptor || resolve(descriptor.cwd) !== cwd) {
			continue;
		}

		if (!dependencies.isProcessAlive(descriptor.pid)) {
			await removeOwnedActiveDescriptor(path, descriptor.instanceId);
			continue;
		}
		if (!(await dependencies.verifyDescriptor(descriptor))) {
			await removeOwnedActiveDescriptor(path, descriptor.instanceId);
			continue;
		}
		candidates.push(descriptor);
	}

	return candidates;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (isNodeError(error, "ESRCH")) {
			return false;
		}
		if (isNodeError(error, "EPERM")) {
			return true;
		}
		throw error;
	}
}

async function verifyDescriptor(descriptor: ActiveGroupChatDescriptor): Promise<boolean> {
	const url =
		`ws://${descriptor.host}:${descriptor.port}/` +
		`${encodeURIComponent(descriptor.groupChatId)}/${encodeURIComponent(descriptor.instanceId)}`;
	const socket = new WebSocket(url, { maxPayload: 1024 * 1024 });

	return new Promise<boolean>((resolveVerification) => {
		let settled = false;
		const finish = (verified: boolean): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
				socket.terminate();
			}
			resolveVerification(verified);
		};
		const timeout = setTimeout(() => finish(false), SHORT_COORDINATION_TIMEOUT_MS);

		socket.once("open", () => finish(true));
		socket.once("error", () => finish(false));
		socket.once("unexpected-response", (_request, response) => {
			response.destroy();
			finish(false);
		});
	});
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === code;
}
