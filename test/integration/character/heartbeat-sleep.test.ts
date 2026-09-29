import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { CharacterRuntime } from "../../../src/character/character-runtime.js";
import { JoinAttempt } from "../../../src/character/join-attempt.js";
import { type CharacterCard, loadCharacterCard } from "../../../src/config/character-card.js";
import { CreatorRuntime } from "../../../src/creator/creator-runtime.js";

/**
 * #203 睡眠清场 —— 心跳挂起感知验收（a / c / d / a′+J / H1 / H2 / J+L）。
 *
 * 依赖修法形态：挂起感知宽限（tick 间隔 > θ=2×interval ⇒ 疑挂起 ⇒ 重置 baseline
 * + probe，不取消判死）。设计见 tmp/dev-203-suspension-fix-design.md。
 * 保绿钉（真半开仍拆、正常周期不移除）复用既有钉，本文件不重复：
 *   - test/integration/creator/creator-runtime.test.ts「cleans up a member that never
 *     responds to heartbeat pings」/「keeps a responsive member online…」
 *   - test/integration/character/join-attempt.test.ts「terminates the connection when
 *     the creator stops sending heartbeats」
 *
 * 红基线（反向 patch 实测，θ=2I 口径）= a / a′+J / H1 / H2 / J+L / d 六红，
 * c 为保绿钉（小迟到不触发宽限、照常路径不误判）。
 *
 * 坑（实证）：fake Date 跨用例泄漏 → afterEach 必须 vi.useRealTimers()；
 * 创建者侧心跳周期需 ≥600ms，否则 pong 在途刷新增大会假绿。
 */

const temporaryDirectories: string[] = [];
const creatorRuntimes: CreatorRuntime[] = [];
const characterRuntimes: CharacterRuntime[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
	vi.useRealTimers();
	for (const socket of sockets.splice(0)) {
		socket.terminate();
	}
	await Promise.all(characterRuntimes.splice(0).map((runtime) => runtime.close().catch(() => undefined)));
	await Promise.all(creatorRuntimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(temporaryDirectories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** handoff 接管后：旧实例已 detach（不可 close），登记新实例做清理。 */
function trackHandoffTakeover<T extends CreatorRuntime | CharacterRuntime>(owner: T, taken: T): void {
	if (owner instanceof CreatorRuntime) {
		creatorRuntimes.splice(creatorRuntimes.indexOf(owner), 1);
		creatorRuntimes.push(taken as CreatorRuntime);
	} else {
		characterRuntimes.push(taken as CharacterRuntime);
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startCreator(
	creatorOverrides: Partial<import("../../../src/creator/creator-runtime.js").CreatorRuntimeDependencies> = {},
): Promise<{ creator: CreatorRuntime; character: CharacterCard }> {
	const root = await mkdtemp(join(tmpdir(), "pi-tavern-sleep-"));
	temporaryDirectories.push(root);
	const characterPath = join(root, "characters", "architect.md");
	await mkdir(join(root, "characters"), { recursive: true });
	await writeFile(characterPath, "---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt");
	const character = await loadCharacterCard(characterPath, join(root, "tavern.json"));
	const creator = await CreatorRuntime.startNew(
		{ cwd: join(root, "project"), agentDir: join(root, "agent"), characters: [character] },
		creatorOverrides,
	);
	creatorRuntimes.push(creator);
	return { creator, character };
}

/** 成员 ws 客户端（autoPong 默认 true；false = 从不回 pong，模拟连接真死）。 */
async function joinMember(
	creator: CreatorRuntime,
	sessionId: string,
	characterId: string,
	options: { autoPong?: boolean } = {},
): Promise<WebSocket> {
	const client = new WebSocket(
		`ws://127.0.0.1:${creator.activeDescriptor.port}/${encodeURIComponent(creator.state.groupChat.groupChatId)}/${encodeURIComponent(creator.activeDescriptor.instanceId)}`,
		{ autoPong: options.autoPong ?? true },
	);
	sockets.push(client);
	await new Promise<void>((resolve, reject) => {
		client.on("open", () => resolve());
		client.on("error", reject);
	});
	const rpc = (id: string, method: string, params?: unknown) =>
		new Promise<void>((resolve) => {
			const onMessage = (data: WebSocket.RawData) => {
				const parsed = JSON.parse(String(data)) as { id?: string };
				if (parsed.id !== id) return;
				client.off("message", onMessage);
				resolve();
			};
			client.on("message", onMessage);
			client.send(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }));
		});
	await rpc("1", "join_group_chat", { session_id: sessionId });
	await rpc("2", "claim_character", { character_id: characterId });
	await rpc("3", "character_ready");
	return client;
}

/** 哑成员：能 join，但从不回 pong（模拟连接真死）。 */
async function joinDumbMember(creator: CreatorRuntime, sessionId: string, characterId: string): Promise<void> {
	await joinMember(creator, sessionId, characterId, { autoPong: false });
}

describe("#203 睡眠清场 —— 挂起感知验收", () => {
	it("a：角色侧时钟跳变（睡眠）→ 不拆连接", async () => {
		// creator 完全静默（600s 周期）：隔离角色侧判据，无 pong 竞争刷新。
		const { creator, character } = await startCreator({ heartbeatIntervalMs: 600_000, heartbeatTimeoutMs: 600_000 });
		const disconnected = vi.fn();
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1", {
			onDisconnected: disconnected,
			heartbeatIntervalMs: 20,
			heartbeatTimeoutMs: 5_000,
		});
		await attempt.claimCharacter(character.characterId);

		// 基线：真实时钟 300ms（< 5s）→ 存活。
		await sleep(300);
		expect(disconnected).not.toHaveBeenCalled();

		// 睡眠等价：时钟静默跳变 60s（真实定时器不受影响）。
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 60_000);

		await sleep(300);
		// 修后：宽限感知 → 保持；现状：tick 即判超时 → terminate。
		expect(disconnected).not.toHaveBeenCalled();
	});

	it("c：角色侧时钟迟到 < θ → 不触发宽限、照常路径不误判", async () => {
		const { creator, character } = await startCreator({ heartbeatIntervalMs: 600_000, heartbeatTimeoutMs: 600_000 });
		const disconnected = vi.fn();
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1", {
			onDisconnected: disconnected,
			heartbeatIntervalMs: 100,
			heartbeatTimeoutMs: 5_000,
		});
		await attempt.claimCharacter(character.characterId);
		await sleep(200);

		// 跳变 50ms < θ=2×interval=200ms（叠加 tick 相位余量仍 < θ）⇒ 不触发宽限、
		// 走照常判死：迟到量 200+50 ≪ timeout 5s ⇒ 不拆。修法不得改变该路径行为。
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 50);
		await sleep(300);
		expect(disconnected).not.toHaveBeenCalled();
	});

	it("a′+J：创建者侧时钟跳变 → 宽限轮发出 probe、成员保持在线（双侧联合）", async () => {
		const { creator, character } = await startCreator({ heartbeatIntervalMs: 600, heartbeatTimeoutMs: 2_000 });
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1", {
			heartbeatIntervalMs: 20,
			heartbeatTimeoutMs: 600_000,
		});
		await attempt.claimCharacter(character.characterId);
		// 先跑 ≥2 个正常 tick：本用例测「基本宽限」（已有 tick 历史 + 大间隔）。
		await sleep(1_300);

		const memberSocket = creator.connections.get("session-1");
		expect(memberSocket).toBeDefined();
		let pongCount = 0;
		memberSocket?.on("pong", () => {
			pongCount += 1;
		});

		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 60_000);

		// 宽限轮（下一 tick）+ probe 往返余量。
		await sleep(900);
		// J：probe 必须真的发出并被回应（否则「双侧各自宽限、无人探测」= 系统仍死）。
		expect(pongCount).toBeGreaterThanOrEqual(1);
		// a′：成员未被 onStale 摘除。
		expect(creator.state.onlineCharacters.has("session-1")).toBe(true);
	});

	it("H1：角色侧 reload handoff 后首轮宽限 —— handoff 窗口跨睡眠不拆", async () => {
		// handoff 会新建运行时实例（lastTickAt 归零）；若首轮不宽限，
		// 从 handoff 接管的陈旧 lastPingAt 会立刻判死。
		// creator 完全静默（600s 周期）：隔离角色侧判据。
		const { creator, character } = await startCreator({ heartbeatIntervalMs: 600_000, heartbeatTimeoutMs: 600_000 });
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1", {
			heartbeatIntervalMs: 20,
			heartbeatTimeoutMs: 5_000,
		});
		const runtime = await attempt.claimCharacter(character.characterId);

		const handoff = await runtime.detachForReload("session-1");
		const taken = await CharacterRuntime.takeHandoff(handoff);
		trackHandoffTakeover(runtime, taken);

		// 接管实例的心跳参数不随 handoff 传递（默认 30s/120s）——测试需要快 tick，
		// 直接注入私有字段并重启定时器（仅测试用；生产走默认值）。
		const priv = taken as unknown as {
			heartbeatIntervalMs: number;
			heartbeatTimeoutMs: number;
			stopHeartbeat: () => void;
			startHeartbeat: () => void;
		};
		priv.heartbeatIntervalMs = 20;
		priv.heartbeatTimeoutMs = 5_000;
		priv.stopHeartbeat();
		priv.startHeartbeat();

		// handoff 期间发生睡眠：接管后（首轮 tick 前）立即时钟跳变。
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 60_000);

		const disconnected = vi.fn();
		(taken as unknown as { onDisconnected: (() => void) | undefined }).onDisconnected = disconnected;
		await sleep(300);
		expect(disconnected).not.toHaveBeenCalled();
	});

	it("H2：创建者侧 reload handoff 后首轮宽限 —— handoff 窗口跨睡眠成员不清场", async () => {
		const { creator, character } = await startCreator({ heartbeatIntervalMs: 600, heartbeatTimeoutMs: 2_000 });
		await joinMember(creator, "session-1", character.characterId);

		const handoff = await creator.detachForReload("pi-session-1");
		// 心跳参数必须随 takeHandoff 覆盖传入：新实例的依赖默认取常量（30s/120s），
		// 不传则本测试窗口内无 tick（空测）。
		const taken = await CreatorRuntime.takeHandoff(handoff, {
			heartbeatIntervalMs: 600,
			heartbeatTimeoutMs: 2_000,
		});
		trackHandoffTakeover(creator, taken);

		// handoff 期间发生睡眠：接管后立即时钟跳变（新 registry 尚未首轮 tick）。
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 60_000);

		await sleep(1_000);
		expect(taken.state.onlineCharacters.has("session-1")).toBe(true);
	});

	it("d：相位受控假拆窗（S=4600ms、f=500ms）—— θ=timeout 口径假拆；θ=2×interval 后不拆", async () => {
		// QA 独立构造（tmp/qa-203-d-phase.test.ts）：确定性相位 f=500ms。
		// 判死输入 = S+f = 5100 > T=5000；宽限输入 = S+d ≈ 4600+：
		// θ=T 时 4600 < 5000 ⇒ 不宽限 ⇒ 假拆（红）；θ=2I=40ms ⇒ 宽限 ⇒ 不拆。
		const { creator, character } = await startCreator({ heartbeatIntervalMs: 600_000, heartbeatTimeoutMs: 600_000 });
		const disconnected = vi.fn();
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-1", {
			onDisconnected: disconnected,
			heartbeatIntervalMs: 20,
			heartbeatTimeoutMs: 5_000,
		});
		await attempt.claimCharacter(character.characterId);

		// 确定性相位：creator 静默 ⇒ lastPingAt = join 时刻，等 500ms 即 f=500ms。
		await sleep(500);
		expect(disconnected).not.toHaveBeenCalled();

		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 4_600);
		await sleep(300);
		expect(disconnected).not.toHaveBeenCalled();
	});

	it("J+L：跳变后连接真死（无 pong）→ 宽限不续命，重置后 timeout 内必拆", async () => {
		// 创建者 100ms 心跳 / 500ms 超时；哑成员从不回 pong。
		const { creator, character } = await startCreator({ heartbeatIntervalMs: 100, heartbeatTimeoutMs: 500 });
		await joinDumbMember(creator, "session-dumb", character.characterId);
		expect(creator.state.onlineCharacters.has("session-dumb")).toBe(true);
		// 先跑 ≥2 个正常 tick（成员无 pong 但未到 timeout，状态健康）。
		await sleep(300);

		// 睡眠等价：时钟跳变 60s → 宽限轮（重置 baseline + probe，成员无 pong）。
		vi.useFakeTimers({ toFake: ["Date"] });
		let fakeNow = Date.now() + 60_000;
		vi.setSystemTime(fakeNow);

		// L 下界：宽限给一个 timeout 窗口，不得在窗口内拆（现状会在跳变后首个 tick 即拆）。
		await sleep(250);
		expect(creator.state.onlineCharacters.has("session-dumb")).toBe(true);

		// 推进假时间（每次真实 50ms 推进 50ms，1× 速率）→ 每次 tick 增量
		// ≈100ms < θ=2×interval=200ms（最坏 150ms 仍有余量）⇒ 宽限不续命；
		// 重置后 timeout（500ms）内必拆。
		let advancedMs = 0;
		while (advancedMs < 1_200 && creator.state.onlineCharacters.has("session-dumb")) {
			await sleep(50);
			fakeNow += 50;
			vi.setSystemTime(fakeNow);
			advancedMs += 50;
		}
		// L 上界：不续命（≤ timeout + 真实调度余量），且不早于 timeout。
		expect(advancedMs).toBeGreaterThanOrEqual(500);
		expect(advancedMs).toBeLessThanOrEqual(1_000);
	});
});
