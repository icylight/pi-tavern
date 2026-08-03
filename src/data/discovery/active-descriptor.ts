import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

export interface ActiveGroupChatDescriptor {
	instanceId: string;
	groupChatId: string;
	name: string | null;
	cwd: string;
	pid: number;
	host: "127.0.0.1";
	port: number;
	startedAt: string;
}

const ActiveGroupChatDescriptorSchema = Type.Object(
	{
		instance_id: Type.String(),
		group_chat_id: Type.String(),
		name: Type.Union([Type.String(), Type.Null()]),
		cwd: Type.String(),
		pid: Type.Integer({ minimum: 1 }),
		host: Type.Literal("127.0.0.1"),
		port: Type.Integer({ minimum: 1, maximum: 65_535 }),
		started_at: Type.String(),
	},
	{ additionalProperties: false },
);

type ActiveGroupChatDescriptorJson = Static<typeof ActiveGroupChatDescriptorSchema>;

const checkActiveGroupChatDescriptor = Compile(ActiveGroupChatDescriptorSchema);

export function getActiveDescriptorPath(agentDir: string, cwd: string, groupChatId: string): string {
	return join(getActiveDescriptorDirectory(agentDir, cwd), `${groupChatId}.json`);
}

export function getActiveDescriptorDirectory(agentDir: string, cwd: string): string {
	return join(getGroupChatProjectDirectory(agentDir, cwd), "active");
}

export function getGroupChatProjectDirectory(agentDir: string, cwd: string): string {
	return join(agentDir, "tavern", getProjectKey(cwd));
}

export function getGroupChatSessionDirectory(agentDir: string, cwd: string): string {
	return join(getGroupChatProjectDirectory(agentDir, cwd), "chats");
}

/**
 * M7 (ISSUE-012/#24)：角色侧的群聊级游标存储目录
 * （“最后一条成功投递的消息序号”）。跨重启持久化；按项目隔离，
 * 不同项目中的不同群聊永不冲突。
 */
export function getGroupChatCursorDirectory(agentDir: string, cwd: string): string {
	return join(getGroupChatProjectDirectory(agentDir, cwd), "cursors");
}

export async function publishActiveDescriptor(
	agentDir: string,
	descriptor: ActiveGroupChatDescriptor,
): Promise<string> {
	const normalizedDescriptor = { ...descriptor, cwd: resolve(descriptor.cwd) };
	const path = getActiveDescriptorPath(agentDir, normalizedDescriptor.cwd, normalizedDescriptor.groupChatId);
	await mkdir(dirname(path), { recursive: true });

	const temporaryPath = getTemporaryPath(path);
	try {
		await writeFile(temporaryPath, serializeDescriptor(normalizedDescriptor), { flag: "wx" });
		await link(temporaryPath, path);
	} finally {
		await unlinkIfPresent(temporaryPath);
	}

	return path;
}

export async function readActiveDescriptor(path: string): Promise<ActiveGroupChatDescriptor | null> {
	let contents: string;
	try {
		contents = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return null;
		}
		throw error;
	}

	try {
		const value: unknown = JSON.parse(contents);
		if (!checkActiveGroupChatDescriptor.Check(value)) {
			return null;
		}
		return fromJson(value);
	} catch {
		return null;
	}
}

export async function updateActiveDescriptorName(path: string, instanceId: string, name: string | null): Promise<void> {
	const descriptor = await readActiveDescriptor(path);
	if (descriptor?.instanceId !== instanceId) {
		throw new Error("Active group chat descriptor is no longer owned by this instance");
	}

	const temporaryPath = getTemporaryPath(path);
	try {
		await writeFile(temporaryPath, serializeDescriptor({ ...descriptor, name }), { flag: "wx" });
		await rename(temporaryPath, path);
	} finally {
		await unlinkIfPresent(temporaryPath);
	}
}

export async function removeOwnedActiveDescriptor(path: string, instanceId: string): Promise<boolean> {
	const descriptor = await readActiveDescriptor(path);
	if (descriptor?.instanceId !== instanceId) {
		return false;
	}

	try {
		await unlink(path);
		return true;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return false;
		}
		throw error;
	}
}

export function getProjectKey(cwd: string): string {
	const normalizedCwd = resolve(cwd);
	return `--${normalizedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function getTemporaryPath(path: string): string {
	return join(dirname(path), `.${randomUUID()}.tmp`);
}

function serializeDescriptor(descriptor: ActiveGroupChatDescriptor): string {
	const json: ActiveGroupChatDescriptorJson = {
		instance_id: descriptor.instanceId,
		group_chat_id: descriptor.groupChatId,
		name: descriptor.name,
		cwd: descriptor.cwd,
		pid: descriptor.pid,
		host: descriptor.host,
		port: descriptor.port,
		started_at: descriptor.startedAt,
	};
	return `${JSON.stringify(json, null, 2)}\n`;
}

function fromJson(json: ActiveGroupChatDescriptorJson): ActiveGroupChatDescriptor {
	return {
		instanceId: json.instance_id,
		groupChatId: json.group_chat_id,
		name: json.name,
		cwd: json.cwd,
		pid: json.pid,
		host: json.host,
		port: json.port,
		startedAt: json.started_at,
	};
}

async function unlinkIfPresent(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (!isNodeError(error, "ENOENT")) {
			throw error;
		}
	}
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === code;
}
