import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PiProcess } from "./pi-process.js";
import { createTempRoot } from "./temp-root.js";
import { type BufferedWsClient, connectCharacter } from "./ws-helper.js";

/**
 * #183 acceptance：whisper 目标发现（注册名解析 + 在线成员工具）e2e。
 *
 * 口径（acceptance.md「whisper 目标发现（#183）」）：① 按名投递全文
 * ② 精确 id 零回归 ③ 未命中附在线清单；另验 `tavern_members` 内容面。
 *
 * 夹具：A = 真实 pi 角色（PITAVERN_AUTO_JOIN，跑 /tavern-test-members、
 * /tavern-test-whisper 缝）；B = ws-helper 在线角色（收 whisper_message 帧）。
 * 缝为 PITAVERN_TEST=1 专用、与工具同执行核心（commands.ts）。
 *
 * 前置：persona 消息在 A join 前发布——whisper 需活跃轮次，且 A 的 join
 * 水位已过该消息（无常住未读，避免未读先读门闸拦下 whisper）。
 *
 * 缝出参（单行，换行转义为字面 \n）：
 * - `[tavern-test-members] count=N; 注册名|character_id|self=T/F|streaming=T/F|hand=T/F; …`
 * - `[tavern-test-whisper] ok=T/F sequence=N text=<工具面文案单行化>`
 */

const processes: PiProcess[] = [];
const roots: string[] = [];

afterAll(async () => {
	for (const process_ of processes) {
		await process_.kill("SIGTERM").catch(() => undefined);
	}
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

interface Scene {
	characterA: PiProcess;
	clientB: BufferedWsClient;
}

async function startScene(): Promise<Scene> {
	const root = await createTempRoot("pi-tavern-acc-wtd-");
	roots.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	await mkdir(join(agentDir, "characters"), { recursive: true });
	await mkdir(projectDir, { recursive: true });
	// 卡名含中文与常规名；id 形态 = 相对 tavern.json 的卡路径。
	await writeFile(join(agentDir, "characters", "alpha.md"), "---\nname: 阿尔法\ndescription: Alpha\n---\nAlpha prompt");
	await writeFile(join(agentDir, "characters", "beta.md"), "---\nname: Beta\ndescription: Beta\n---\nBeta prompt");
	await writeFile(
		join(agentDir, "tavern.json"),
		JSON.stringify({ characters: ["characters/alpha.md", "characters/beta.md"] }),
	);

	const creator = PiProcess.spawn({
		label: "creator",
		agentDir,
		sessionDir: join(agentDir, "sessions", "creator"),
		cwd: projectDir,
	});
	processes.push(creator);
	const descriptor = await creator.startGroupChat(projectDir, agentDir);
	// 轮次打底（join 前发布 → A 的 join 水位已过，不留未读）。
	await creator.runCommand("/tavern-test-message #183 acceptance 开场");

	const characterA = PiProcess.spawn({
		label: "alpha",
		agentDir,
		sessionDir: join(agentDir, "sessions", "alpha"),
		cwd: projectDir,
		env: {
			PITAVERN_AUTO_JOIN: "1",
			PITAVERN_CHARACTER: "characters/alpha.md",
			PITAVERN_GROUP_CHAT: descriptor.groupChatId,
			PITAVERN_AUTO_JOIN_DELAY_MS: "100",
		},
	});
	processes.push(characterA);
	await characterA.waitForStderr("Auto-joined", 60_000);

	const clientB = await connectCharacter(descriptor, "sess-beta", "characters/beta.md");
	return { characterA, clientB };
}

/** 跑一条 test 缝命令，捕获对应 notify（单行出参）。 */
async function runSeam(process_: PiProcess, command: string, marker: string): Promise<string> {
	const checkpoint = process_.checkpoint();
	await process_.runCommand(command);
	const event = await process_.waitForAfter(
		checkpoint,
		(e) =>
			e.type === "extension_ui_request" &&
			e.method === "notify" &&
			typeof e.message === "string" &&
			e.message.includes(marker),
		30_000,
	);
	return String(event.message);
}

function whisperArgs(target: string, content: string): string {
	return JSON.stringify({ target, content });
}

function receivedWhisper(client: BufferedWsClient, needle: string): Promise<unknown> {
	return client.waitFor((m) => {
		if (m.method !== "whisper_message") return false;
		const params = (m.params ?? {}) as Record<string, unknown>;
		return typeof params.content === "string" && params.content.includes(needle);
	}, 30_000);
}

describe("acceptance: #183 whisper 目标发现（按名解析 + members）", () => {
	it("members 内容面 + 按名投递全文 + 精确 id 零回归 + 未命中附清单", { timeout: 180_000 }, async () => {
		const { characterA, clientB } = await startScene();

		// ① members：在线表含双方注册名与 character_id；self 标区分自身（自己置首）
		const membersText = await runSeam(characterA, "/tavern-test-members", "[tavern-test-members]");
		expect(membersText).toContain("count=2");
		expect(membersText).toContain("阿尔法");
		expect(membersText).toContain("characters/alpha.md");
		expect(membersText).toContain("self=T");
		expect(membersText).toContain("Beta");
		expect(membersText).toContain("characters/beta.md");
		expect(membersText).toContain("self=F");

		// ② 按注册名私信 → 投递成功（ok=T + sequence），B 实时收到全文
		const byNameText = await runSeam(
			characterA,
			`/tavern-test-whisper ${whisperArgs("Beta", "按名私信-验收")}`,
			"[tavern-test-whisper]",
		);
		expect(byNameText).toContain("ok=T");
		expect(byNameText).toMatch(/sequence=\d+/);
		expect(await receivedWhisper(clientB, "按名私信-验收")).toBeTruthy();

		// ③ 精确 character_id 传法零回归
		const byIdText = await runSeam(
			characterA,
			`/tavern-test-whisper ${whisperArgs("characters/beta.md", "精确id-验收")}`,
			"[tavern-test-whisper]",
		);
		expect(byIdText).toContain("ok=T");
		expect(await receivedWhisper(clientB, "精确id-验收")).toBeTruthy();

		// ④ 未命中：拒绝 + 附在线清单（不裸透 -32110 英文原文）
		const missingText = await runSeam(
			characterA,
			`/tavern-test-whisper ${whisperArgs("不存在的人", "不该投递")}`,
			"[tavern-test-whisper]",
		);
		expect(missingText).toContain("ok=F");
		expect(missingText).toContain("不在当前在线成员中");
		expect(missingText).toContain("Beta");
		expect(missingText).not.toContain("Whisper target character is not online");
	});
});
