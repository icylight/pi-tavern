import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";

// v0.5 功能收窄：group_chat_update 只承载公共消息水位；流式状态翻转只更新
// creator 权威状态，不再广播该通知。此钉防止状态广播重新接回 Agent 输入链。
const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-loop-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CreatorRuntime 流式状态通知收窄", () => {
	it("流式状态翻转不广播 group_chat_update，但权威状态仍更新", async () => {
		const root = await createTemporaryDirectory();
		// 字符卡（agentDir/tavern.json + characters/dev.md），使 claim 成功
		const agentDir = join(root, "agent");
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await writeFile(join(agentDir, "characters", "dev.md"), "---\nname: Dev\ndescription: Developer\n---\nDev prompt");
		await writeFile(join(agentDir, "tavern.json"), JSON.stringify({ characters: ["characters/dev.md"] }));
		const runtime = await CreatorRuntime.startNew({
			cwd: join(root, "project"),
			agentDir,
		});

		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.activeDescriptor.port}/${encodeURIComponent(runtime.state.groupChat.groupChatId)}/${encodeURIComponent(runtime.activeDescriptor.instanceId)}`,
		);
		await new Promise((res, rej) => {
			client.once("open", res);
			client.once("error", rej);
		});

		let cmdId = 0;
		const send = (message: Record<string, unknown>): void => {
			cmdId += 1;
			client.send(JSON.stringify({ id: String(cmdId), ...message }));
		};
		const waitFor = async (
			pred: (m: Record<string, unknown>) => boolean,
			timeoutMs = 10_000,
		): Promise<Record<string, unknown>> => {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const hit = frames.find(pred);
				if (hit) return hit;
				if (Date.now() > deadline) throw new Error("timeout waiting for frame");
				await new Promise((r) => setTimeout(r, 50));
			}
		};

		// 注册角色
		const frames: Record<string, unknown>[] = [];
		let broadcastCount = 0;
		client.on("message", (data) => {
			const message = JSON.parse(data.toString()) as Record<string, unknown>;
			frames.push(message);
			if (message.type === "group_chat_update") {
				broadcastCount += 1;
			}
		});

		// join → 动态 claim（available_characters[0]）→ ready
		send({ type: "join_group_chat", session_id: "j4-s1" });
		const joinResp = await waitFor((m) => m.id === "1" && m.type === "response");
		expect(joinResp.success).toBe(true);
		const available = (joinResp.data as { available_characters?: Array<{ character_id: string }> })
			?.available_characters;
		const claimId = available?.[0]?.character_id;
		expect(claimId).toBeTruthy();
		send({ type: "claim_character", character_id: claimId ?? "dev" });
		await waitFor((m) => m.id === "2" && m.type === "response");
		expect(frames.find((m) => m.id === "2")?.success).toBe(true);
		send({ type: "character_ready" });
		await waitFor((m) => m.id === "3" && m.type === "response");
		expect(frames.find((m) => m.id === "3")?.success).toBe(true);

		// 模拟 agent_start 点亮（false→true 翻转）
		broadcastCount = 0;
		client.send(JSON.stringify({ type: "update_character_state", is_streaming: true }));

		await new Promise((r) => setTimeout(r, 300));
		expect(broadcastCount).toBe(0);
		send({ type: "get_group_chat_state" });
		const state = await waitFor((m) => m.id === "4" && m.type === "response");
		const self = (
			state.data as { online_characters?: Array<{ is_self?: boolean; is_streaming?: boolean }> }
		)?.online_characters?.find((character) => character.is_self);
		expect(self?.is_streaming).toBe(true);

		client.close();
		await runtime.close();
	});
});
