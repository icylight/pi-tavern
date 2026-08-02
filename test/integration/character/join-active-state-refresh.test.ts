import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { JoinAttempt } from "../../../src/character/join-attempt.js";
import { type CharacterCard, loadCharacterCard } from "../../../src/config/character-card.js";
import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";

/**
 * A6（验收清单 #21-A6）：join 后主动拉取——「成员数未知」窗口消除。
 *
 * 架构师定位的 #21 根因：join 完成不主动拉状态，加入/离开广播不进批次
 * 不触发 flush，首条公开消息前 lastGroupChatState 恒为 null。
 * 修法（③-2）：claimCharacter 尾部主动 refreshGroupChatState()。
 * 本测试锁定：join 完成后、无任何公开消息时，character 侧快照已含
 * 真实成员数（不再"成员数未知"）。
 */

const temporaryDirectories: string[] = [];
const creatorRuntimes: CreatorRuntime[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-a6-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(creatorRuntimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function startCreator(
	characterFiles: Array<{ path: string; content: string }> = [
		{
			path: "architect.md",
			content: "---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt",
		},
	],
): Promise<{ creator: CreatorRuntime; character: CharacterCard }> {
	const root = await createTemporaryDirectory();
	await mkdir(join(root, "characters"), { recursive: true });
	const characters: CharacterCard[] = [];
	for (const file of characterFiles) {
		const characterPath = join(root, "characters", file.path);
		const configPath = join(root, "tavern.json");
		await writeFile(characterPath, file.content);
		characters.push(await loadCharacterCard(characterPath, configPath));
	}
	const creator = await CreatorRuntime.startNew({
		cwd: join(root, "project"),
		agentDir: join(root, "agent"),
		characters,
	});
	creatorRuntimes.push(creator);
	return { creator, character: characters[0] as CharacterCard };
}

describe("A6: join-time active state refresh (#21 成员数未知窗口)", () => {
	it("joins with a populated snapshot: no messages yet, member count already known", async () => {
		const { creator, character } = await startCreator();
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1");
		const runtime = await attempt.claimCharacter(character.characterId);

		// claimCharacter 尾部主动 refreshGroupChatState → lastGroupChatState
		// 在无任何公开消息时也已填充（不再是 null / "成员数未知"）。
		await vi.waitFor(() => expect(runtime.lastGroupChatState).not.toBeNull(), { timeout: 2000 });

		expect(runtime.lastGroupChatState?.online_characters).toHaveLength(1);
		expect(runtime.lastGroupChatState?.online_characters[0]).toMatchObject({
			character_id: character.characterId,
			is_self: true,
			hand_raised: false,
		});
		// Round stays null: no User Persona message yet — only the member
		// snapshot must be visible.
		expect(runtime.lastGroupChatState?.round).toBeNull();

		await runtime.close();
	});

	it("sees the plan-A membership broadcast on its connection (方案 A 广播到达，完整刷新链路落 acceptance)", async () => {
		const { creator, character } = await startCreator([
			{ path: "architect.md", content: "---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt" },
			{ path: "developer.md", content: "---\nname: Developer\ndescription: Writes code\n---\nDeveloper prompt" },
		]);
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1");
		const runtime = await attempt.claimCharacter(character.characterId);
		await vi.waitFor(() => expect(runtime.lastGroupChatState).not.toBeNull(), { timeout: 2000 });
		const messagesBefore = runtime.receivedMessages.length;

		// A second member joins via the real WS flow: creator broadcasts
		// character_joined + group_chat_update (方案 A) to every member.
		const second = new WebSocket(
			`ws://127.0.0.1:${creator.activeDescriptor.port}/${encodeURIComponent(creator.state.groupChat.groupChatId)}/${encodeURIComponent(creator.activeDescriptor.instanceId)}`,
		);
		await new Promise<void>((resolve, reject) => {
			second.once("open", () => resolve());
			second.once("error", reject);
		});
		second.send(JSON.stringify({ id: "1", type: "join_group_chat", session_id: "session-2" }));
		second.send(JSON.stringify({ id: "2", type: "claim_character", character_id: "characters/developer.md" }));
		second.send(JSON.stringify({ id: "3", type: "character_ready" }));

		// Broadcast arrives on the existing character connection: the
		// member-change notification channel works without any message.
		await vi.waitFor(
			() =>
				expect(
					runtime.receivedMessages
						.slice(messagesBefore)
						.some((m) => m.type === "group_chat_update" && m.latest_sequence === 0),
				).toBe(true),
			{ timeout: 2000 },
		);

		// Note: the refresh-on-broadcast link (GroupChatInput handler →
		// refreshGroupChatState → widget member count) needs the real pi
		// context (groupChatInput only attaches when pi is present) — that
		// full chain is covered at the acceptance layer (A4 plan-A refresh).
		second.terminate();
		await runtime.close();
	});
});
