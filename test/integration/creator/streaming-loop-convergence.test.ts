import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";

// #83 J4 断言 1（QA，PM 主线验收锚点）：#77 状态广播自激循环收敛。
// 机制（User 定案根因，PM 四级核验）：活跃 run 中角色收到 group_chat_update →
// 拉状态 → 快照 is_streaming==true → 补偿重发 update_character_state(true) →
// creator 无条件广播（未修复 f2ac85f）→ 循环风暴 → 5s 请求超时 failConnection 掉线。
// 修复（User 双防线）：creator 侧 runUpdateCharacterState 仅 isStreaming 实际
// 翻转时广播（true→true 直接返回）→ 环断。
// 本测试：真实 CreatorRuntime + 协议级模拟活跃角色（收到广播 → 拉状态 → 快照
// 活跃则补偿重发点亮），计数 group_chat_update 广播帧。
// 断言：① 点亮后必须有广播（有效性检查，防假绿）② 广播有界收敛（≤4 且稳定）。
// 红绿：未修复 f2ac85f 预期红（循环 → 广播持续增长）；修复后预期绿（翻转 1 次收敛）。
const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-loop-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CreatorRuntime #83 J4 广播收敛（自激循环修复验收）", () => {
	it("活跃角色补偿重发点亮时，group_chat_update 广播有界收敛（无自激）", async () => {
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
		const waitFor = async (pred: (m: Record<string, unknown>) => boolean, timeoutMs = 10_000): Promise<Record<string, unknown>> => {
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
		let simulating = true;
		client.on("message", (data) => {
			const message = JSON.parse(data.toString()) as Record<string, unknown>;
			frames.push(message);
			if (!simulating) return;
			if (message.type === "group_chat_update") {
				broadcastCount += 1;
				// 模拟活跃角色的补偿链：收到广播 → 拉状态 → 快照活跃 → 补偿重发点亮
				const stateId = String(++cmdId);
				client.send(JSON.stringify({ id: stateId, type: "get_group_chat_state" }));
				const checkState = (): void => {
					const resp = frames.find((f) => f.id === stateId && f.type === "response");
					if (!resp) {
						setTimeout(checkState, 50);
						return;
					}
					const self = (resp.data as { online_characters?: Array<{ is_self?: boolean; is_streaming?: boolean }> })
						?.online_characters?.find((c) => c.is_self);
					// 快照活跃 → 补偿重发点亮（update_character_state schema 不含 id）
					if (self?.is_streaming) {
						client.send(JSON.stringify({ type: "update_character_state", is_streaming: true }));
					}
				};
				checkState();
			}
		});

		// join → 动态 claim（available_characters[0]）→ ready
		send({ type: "join_group_chat", session_id: "j4-s1" });
		const joinResp = await waitFor((m) => m.id === "1" && m.type === "response");
		expect(joinResp.success).toBe(true);
		const available = (joinResp.data as { available_characters?: Array<{ character_id: string }> })?.available_characters;
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

		// 有效性检查：点亮后必须有广播（未修复 f2ac85f 无条件广播；修复后翻转广播 1 次）
		await new Promise((r) => setTimeout(r, 1000));
		expect(broadcastCount).toBeGreaterThan(0);

		// 观察窗 2s：允许翻转广播 + 少量补偿往返
		await new Promise((r) => setTimeout(r, 2000));
		const countAfterWindow = broadcastCount;
		// 收敛窗口 1s：计数不得继续增长（自激循环 = 持续增长 = 红）
		await new Promise((r) => setTimeout(r, 1000));
		const countAfterSettle = broadcastCount;

		simulating = false;
		client.close();
		await runtime.close();

		expect(countAfterSettle).toBeLessThanOrEqual(4);
		expect(countAfterSettle).toBe(countAfterWindow);
	});
});
