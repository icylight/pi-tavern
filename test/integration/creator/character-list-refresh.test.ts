import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import type { CharacterCard } from "../../../src/config/character-card.js";
import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";
import { decodeServerMessage, encodeMessage } from "../../../src/protocol/codec.js";

/**
 * #25：宿主角色清单懒刷新（feat/character-list-refresh）。
 * 验收锚点（对应 #25 六条中的核心三条）：
 *  ① 新增角色卡 join 可见（loadCharacters 返回扩展清单 → available_characters 含新卡）
 *  ② name/description 变更 leave→join 成功（claim 响应返回新摘要，不抛旧快照校验错）
 *  ③ 重扫失败优雅降级（loadCharacters reject / 空结果 → 回退旧快照，join 仍可用）
 */

const temporaryDirectories: string[] = [];
const runtimes: CreatorRuntime[] = [];
const sockets: WebSocket[] = [];

const architect: CharacterCard = {
	characterId: "characters/architect.md",
	name: "Architect",
	description: "Architecture",
	path: "/characters/architect.md",
	prompt: "Architect prompt",
};

const developer: CharacterCard = {
	characterId: "characters/developer.md",
	name: "Developer",
	description: "Development",
	path: "/characters/developer.md",
	prompt: "Developer prompt",
};

const qaCard: CharacterCard = {
	characterId: "characters/qa.md",
	name: "QA",
	description: "Quality",
	path: "/characters/qa.md",
	prompt: "QA prompt",
};

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-refresh-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const socket of sockets.splice(0)) {
		socket.terminate();
	}
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface StartRuntimeOptions {
	characters: CharacterCard[];
	loadCharacters?: () => Promise<CharacterCard[]>;
}

async function startRuntime(options: StartRuntimeOptions, readyTimeoutMs = 5_000): Promise<CreatorRuntime> {
	const root = await createTemporaryDirectory();
	const runtime = await CreatorRuntime.startNew(
		{
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: options.characters,
			...(options.loadCharacters !== undefined ? { loadCharacters: options.loadCharacters } : {}),
		},
		{ readyTimeoutMs },
	);
	runtimes.push(runtime);
	return runtime;
}

interface Peer {
	socket: WebSocket;
	send(message: unknown): void;
	next(): Promise<unknown>;
	closed: Promise<void>;
}

async function connectPeer(runtime: CreatorRuntime): Promise<Peer> {
	const descriptor = runtime.activeDescriptor;
	const socket = new WebSocket(
		`ws://${descriptor.host}:${descriptor.port}/${descriptor.groupChatId}/${descriptor.instanceId}`,
	);
	sockets.push(socket);
	const messages: unknown[] = [];
	const waiters: Array<(message: unknown) => void> = [];
	socket.on("message", (data) => {
		const message = decodeServerMessage(data);
		const waiter = waiters.shift();
		if (waiter) {
			waiter(message);
		} else {
			messages.push(message);
		}
	});
	const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});

	return {
		socket,
		send(message) {
			socket.send(encodeMessage(message));
		},
		next() {
			const message = messages.shift();
			if (message) {
				return Promise.resolve(message);
			}
			return new Promise((resolve) => waiters.push(resolve));
		},
		closed,
	};
}

function toSummaryMessage(character: CharacterCard) {
	return {
		character_id: character.characterId,
		name: character.name,
		description: character.description,
	};
}

describe("#25 CreatorRuntime character list lazy refresh", () => {
	it("① makes a newly added character visible on join (no restart)", async () => {
		const runtime = await startRuntime({
			characters: [architect, developer],
			// 磁盘新增 qa.md：懒刷新后 join 的 available_characters 应含新卡
			loadCharacters: async () => [architect, developer, qaCard],
		});
		const peer = await connectPeer(runtime);

		peer.send({ id: "join", type: "join_group_chat", session_id: "session-1" });
		const response = await peer.next();
		expect(response).toMatchObject({
			id: "join",
			type: "response",
			command: "join_group_chat",
			success: true,
			data: {
				available_characters: [architect, developer, qaCard].map(toSummaryMessage),
			},
		});
	});

	it("①b newly added character can be claimed after refresh", async () => {
		const runtime = await startRuntime({
			characters: [architect, developer],
			loadCharacters: async () => [architect, developer, qaCard],
		});
		const peer = await connectPeer(runtime);

		peer.send({ id: "join", type: "join_group_chat", session_id: "session-1" });
		await peer.next();

		peer.send({ id: "claim", type: "claim_character", character_id: qaCard.characterId });
		const claimResponse = await peer.next();
		expect(claimResponse).toMatchObject({
			id: "claim",
			type: "response",
			command: "claim_character",
			success: true,
			data: {
				character: {
					...toSummaryMessage(qaCard),
					path: qaCard.path,
				},
			},
		});
	});

	it("② name/description change is picked up on leave→join (claim returns new summary)", async () => {
		const renamed: CharacterCard = { ...architect, name: "Architect v2", description: "Architecture v2" };
		const runtime = await startRuntime({
			characters: [architect, developer],
			// 磁盘上 architect 卡已改名/改描述：leave→join 后 claim 应返回新摘要
			loadCharacters: async () => [renamed, developer],
		});
		const peer = await connectPeer(runtime);

		peer.send({ id: "join", type: "join_group_chat", session_id: "session-1" });
		const joinResponse = (await peer.next()) as { data: { available_characters: Array<{ name: string }> } };
		expect(joinResponse.data.available_characters.find((c) => c.name === "Architect v2")).toBeDefined();

		peer.send({ id: "claim", type: "claim_character", character_id: architect.characterId });
		const claimResponse = (await peer.next()) as { data: { character: { name: string; description: string } } };
		expect(claimResponse.data.character).toMatchObject({
			name: "Architect v2",
			description: "Architecture v2",
		});
	});

	it("③a refresh failure falls back to the startup snapshot", async () => {
		const runtime = await startRuntime({
			characters: [architect, developer],
			loadCharacters: async () => {
				throw new Error("disk unavailable");
			},
		});
		const peer = await connectPeer(runtime);

		peer.send({ id: "join", type: "join_group_chat", session_id: "session-1" });
		const response = await peer.next();
		expect(response).toMatchObject({
			id: "join",
			type: "response",
			command: "join_group_chat",
			success: true,
			data: {
				available_characters: [architect, developer].map(toSummaryMessage),
			},
		});
	});

	it("③b empty refresh result falls back to the startup snapshot (no accidental wipe)", async () => {
		const runtime = await startRuntime({
			characters: [architect, developer],
			loadCharacters: async () => [],
		});
		const peer = await connectPeer(runtime);

		peer.send({ id: "join", type: "join_group_chat", session_id: "session-1" });
		const response = await peer.next();
		expect(response).toMatchObject({
			id: "join",
			type: "response",
			command: "join_group_chat",
			success: true,
			data: {
				available_characters: [architect, developer].map(toSummaryMessage),
			},
		});
	});

	it("③c no loadCharacters injection keeps the startup snapshot semantics (zero change)", async () => {
		const runtime = await startRuntime({ characters: [architect, developer] });
		const peer = await connectPeer(runtime);

		peer.send({ id: "join", type: "join_group_chat", session_id: "session-1" });
		const response = await peer.next();
		expect(response).toMatchObject({
			id: "join",
			type: "response",
			command: "join_group_chat",
			success: true,
			data: {
				available_characters: [architect, developer].map(toSummaryMessage),
			},
		});
	});

	it("refresh only triggers on join/claim/query — speak/history do not rescan", async () => {
		let refreshCount = 0;
		const runtime = await startRuntime({
			characters: [architect, developer],
			loadCharacters: async () => {
				refreshCount += 1;
				return [architect, developer];
			},
		});
		const peer = await connectPeer(runtime);

		// get_message_history 不应触发刷新
		peer.send({ id: "history", type: "get_message_history" });
		await peer.next();
		expect(refreshCount).toBe(0);

		// join 触发一次
		peer.send({ id: "join", type: "join_group_chat", session_id: "session-1" });
		await peer.next();
		expect(refreshCount).toBe(1);

		// claim 再触发一次
		peer.send({ id: "claim", type: "claim_character", character_id: architect.characterId });
		await peer.next();
		expect(refreshCount).toBe(2);
	});
});
