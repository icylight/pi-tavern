import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type WebSocket from "ws";
import type { ActiveGroupChatDescriptor } from "../../src/data/discovery/active-descriptor.js";
import type { PiProcess } from "./pi-process.js";
import { leaveAndReset, spawnCreator, startFreshGroup } from "./process-fixture.js";
import type { BufferedWsClient } from "./ws-helper.js";
import { joinCharacterWs } from "./ws-helper.js";

/**
 * #170 服务端投影半场 acceptance 锚点（QA 起草，2026-08-10 风暴定案）：
 *
 * 本地半场（#170 客户端修复）剔除占位对 unread_first 的阻塞后，旁观者可在
 * 「占位未消费」状态下直接发言——首请求携带旧 based_on_sequence，服务端 stale
 * 扫描若仍把 A→B whisper 计为 latestOtherSequence（无投影视角），请求将被判
 * stale，#170 目标（协议性回复一次成功）不实现。服务端半场 = stale 判定按请求者
 * 投影：旁观者视角（sender≠我 且 recipient≠我）的 whisper 跳过，公开消息与
 * 接收者全文恒计入（防线保留）。
 *
 * 锚点（对 #170 验收口径）：
 * - 旁观者 C 游标落后于 A→B whisper（只见占位、未消费）时，C 的 speak 与
 *   whisper 首请求均 published（无 stale）；
 * - 防线回归：全文接收者（recipient=我）游标落后时 speak 仍 stale；公开消息
 *   游标落后时 speak 仍 stale。
 *
 * WS 直驱（剧本驱动 e2e 方案 1）：基于真实 pi 进程 + 协议帧，显式携带
 * based_on_sequence 模拟「占位未消费直接发言」的首请求（绕开客户端本地门，
 * 与服务端投影判定形成红/绿判别——修复前 stale，修复后 published）。
 */
describe("acceptance: #170 服务端投影半场（旁观者占位不触发 stale）", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	let creator: PiProcess;
	const sockets: WebSocket[] = [];

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-tavern-acc-wps-"));
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await mkdir(projectDir, { recursive: true });
		for (const [file, name] of [
			["alice.md", "Alice"],
			["carol.md", "Carol"],
			["bystander.md", "Bystander"],
		] as const) {
			await writeFile(
				join(agentDir, "characters", file),
				`---\nname: ${name}\ndescription: ${name} role\n---\n${name} prompt`,
			);
		}
		await writeFile(
			join(agentDir, "tavern.json"),
			JSON.stringify({
				config_max_messages: 10,
				characters: ["characters/alice.md", "characters/carol.md", "characters/bystander.md"],
			}),
		);
		creator = spawnCreator({
			label: "creator",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator"),
			cwd: projectDir,
		});
		await creator.waitForTavernReady(60_000);
	});

	afterEach(async () => {
		for (const socket of sockets.splice(0)) {
			socket.terminate();
		}
		try {
			await leaveAndReset(creator, creator.checkpoint(), 10_000);
		} catch {
			await creator.kill("SIGKILL");
		}
		if (creator.exited) {
			creator = spawnCreator({
				label: "creator",
				agentDir,
				sessionDir: join(agentDir, "sessions", "creator"),
				cwd: projectDir,
			});
			await creator.waitForTavernReady(60_000);
		}
	});

	afterAll(async () => {
		for (const socket of sockets.splice(0)) {
			socket.terminate();
		}
		if (creator && !creator.exited) {
			await creator.kill("SIGTERM");
		}
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
	});

	async function startTrio(): Promise<{
		alice: BufferedWsClient;
		carol: BufferedWsClient;
		bystander: BufferedWsClient;
		descriptor: ActiveGroupChatDescriptor;
	}> {
		const { descriptor } = await startFreshGroup(creator, projectDir, agentDir);
		await creator.runCommand("/tavern-test-message 开场：私信投影轮次");
		const alice = await joinCharacterWs(descriptor, "wps-alice", "characters/alice.md");
		const carol = await joinCharacterWs(descriptor, "wps-carol", "characters/carol.md");
		const bystander = await joinCharacterWs(descriptor, "wps-bystander", "characters/bystander.md");
		sockets.push(alice.socket, carol.socket, bystander.socket);
		return { alice, carol, bystander, descriptor };
	}

	it("旁观者占位未消费时 speak/whisper 首请求成功（#170 服务端半场红/绿判别）", async () => {
		const { alice, bystander, descriptor } = await startTrio();
		try {
			// A→B whisper（seq2）：bystander 只见占位、游标停在 seq1。
			const whisper = await alice.sendAndWait("whisper", {
				character_id: "characters/carol.md",
				content: "确认一下方案",
			});
			const whisperResult = whisper.result as { published?: boolean; sequence?: number };
			expect(whisperResult.published).toBe(true);
			expect(whisperResult.sequence).toBe(2);

			// 红钉语义：占位未消费（基于旧游标 1 < whisper seq 2）直接发言。
			// 修复前：latestOtherSequence=2 > 1 → stale；修复后：旁观者投影跳过 → published。
			const speak = await bystander.sendAndWait("speak", { content: "回复 Alice", based_on_sequence: 1 });
			const speakResult = speak.result as { published?: boolean; reason?: string };
			expect(speakResult.published).toBe(true);
			expect(speakResult.reason).toBeUndefined();

			// whisper 路径同源（WhisperMessagePipeline 同一 helper）。
			const reply = await bystander.sendAndWait("whisper", {
				character_id: "characters/alice.md",
				content: "私信回复",
				based_on_sequence: 1,
			});
			const replyResult = reply.result as { published?: boolean; reason?: string };
			expect(replyResult.published).toBe(true);
			expect(replyResult.reason).toBeUndefined();
			expect(descriptor).toBeDefined();
		} finally {
			// 清理由 afterEach 兜底（sockets + leaveAndReset）。
		}
	});

	it("防线：全文接收者（recipient=我）游标落后仍 stale", async () => {
		const { alice, carol } = await startTrio();
		try {
			await alice.sendAndWait("whisper", { character_id: "characters/carol.md", content: "给 Carol 全文" });
			// Carol 是接收者（实时收到全文、游标应已推进）——若基于旧游标 1 发言，
			// recipient=我 的 whisper 恒计入 latestOtherSequence → 仍 stale（防线不破）。
			const speak = await carol.sendAndWait("speak", { content: "全文后回复", based_on_sequence: 1 });
			const speakResult = speak.result as { published?: boolean; reason?: string };
			expect(speakResult.published).toBe(false);
			expect(speakResult.reason).toBe("stale");
		} finally {
			// 清理由 afterEach 兜底。
		}
	});

	it("防线：公开消息游标落后仍 stale（public 恒计入）", async () => {
		const { alice, bystander } = await startTrio();
		try {
			// 公开消息 seq2（Alice 发言）；bystander 基于旧游标 1 发言。
			const publicSpeak = await alice.sendAndWait("speak", { content: "公开消息", based_on_sequence: 1 });
			expect((publicSpeak.result as { published?: boolean }).published).toBe(true);
			const speak = await bystander.sendAndWait("speak", { content: "落后公开消息", based_on_sequence: 1 });
			const speakResult = speak.result as { published?: boolean; reason?: string };
			expect(speakResult.published).toBe(false);
			expect(speakResult.reason).toBe("stale");
		} finally {
			// 清理由 afterEach 兜底。
		}
	});
});
