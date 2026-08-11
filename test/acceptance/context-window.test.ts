import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { PiProcess, waitForDescriptor } from "./pi-process.js";

/**
 *  红钉（acceptance 进程级）：拉取附加上下文窗口（方案 A，零协议变更）。
 *
 * 验收锚点：acceptance.md WL-A/B。
 *
 * - WL-A：增量拉取注入含「游标自身最近已投递 seq（起点退 N 返回集）+ 未读全量」，
 *   升序无缺失无重复（服务端 > 排他语义：窗口 = 起点退 N 后返回集含游标自身）；
 * - WL-B：窗口滑移——游标推进后旧窗口消息移出（最近已投递重复出现属预期设计，
 *   更早窗口不再注入）；游标存储值不被窗口污染（integration 层直锚 loadCursor）。
 *
 * 场景：角色 join（游标预置 = 进入水位）→ 消费 cw-a（游标推进）→ 发布 cw-b
 * → 下一次注入批次应含 cw-a（窗口重复）+ cw-b（未读）；再发布 cw-c → 注入批次
 * 含 cw-b（窗口滑移）+ cw-c，cw-a 移出。
 */
describe("acceptance: 上下文窗口注入（WL-A/WL-B）", () => {
	let index = 0;
	const roots: string[] = [];
	const processes: PiProcess[] = [];

	afterAll(async () => {
		for (const process_ of processes) {
			await process_.kill("SIGTERM");
		}
		await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
	});

	async function startCreator(): Promise<{ creator: PiProcess; agentDir: string; projectDir: string }> {
		const root = await mkdtemp(join(tmpdir(), `pi-tavern-acc-cw-${index}-`));
		index += 1;
		roots.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await mkdir(projectDir, { recursive: true });
		await writeFile(join(agentDir, "characters", "dev.md"), "---\nname: Dev\ndescription: Developer\n---\nDev prompt");
		await writeFile(join(agentDir, "tavern.json"), JSON.stringify({ characters: ["characters/dev.md"] }));

		const creator = PiProcess.spawn({
			label: "creator",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator"),
			cwd: projectDir,
		});
		processes.push(creator);
		await creator.waitForTavernReady();
		await creator.runCommand("/tavern-new");
		await waitForDescriptor(agentDir, projectDir);
		return { creator, agentDir, projectDir };
	}

	async function startCharacter(agentDir: string, projectDir: string): Promise<PiProcess> {
		const character = PiProcess.spawn({
			label: "character",
			agentDir,
			sessionDir: join(agentDir, "sessions", "character"),
			cwd: projectDir,
		});
		processes.push(character);
		await character.waitForTavernReady();
		await character.runCommand("/tavern-join");
		const descriptor = await waitForDescriptor(agentDir, projectDir);
		const firstSelect = await character.waitFor((e) => e.type === "extension_ui_request" && e.method === "select");
		if (firstSelect.title === "Choose a group chat") {
			const options = (firstSelect.options as unknown as string[]) ?? [];
			const chosen = options.find((o) => o.includes(descriptor.groupChatId)) ?? options[0];
			character.respond(String(firstSelect.id), { value: chosen });
		}
		const characterSelect = await character.waitFor(
			(e) => e.type === "extension_ui_request" && e.method === "select" && e.title === "Choose a Character",
		);
		const options = (characterSelect.options as unknown as string[]) ?? [];
		character.respond(String(characterSelect.id), { value: options[0] });
		const settleCheckpoint = character.checkpoint();
		await character.waitForAfter(settleCheckpoint, (e) => e.type === "response" && e.command === "prompt", 10_000);
		return character;
	}

	async function publishMessage(creator: PiProcess, text: string): Promise<void> {
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const checkpoint = creator.checkpoint();
			await creator.runCommand(`/tavern-test-message ${text}`);
			try {
				await creator.waitForAfter(
					checkpoint,
					(e) =>
						e.type === "extension_ui_request" &&
						e.method === "notify" &&
						e.message === "User Persona message published",
					10_000,
				);
				return;
			} catch {
				if (attempt === 3) {
					throw new Error(`publishMessage failed after 3 attempts: ${text}`);
				}
			}
		}
	}

	async function waitForInjectWithLatestSeq(character: PiProcess, latestSeq: number): Promise<void> {
		const checkpoint = character.checkpoint();
		await character.waitForAfter(
			checkpoint,
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				typeof e.message === "string" &&
				e.message.includes("[tavern-inject]") &&
				e.message.includes(`latest_seq=${latestSeq}`),
			15_000,
		);
	}

	/** 最近一次注入批次的 public_message 正文（按 custom message 批次取末批）。 */
	async function latestInjectedContents(character: PiProcess): Promise<string[]> {
		const id = await character.send({ type: "get_messages" });
		const response = await character.waitFor(
			(e) => e.id === id && e.type === "response" && e.command === "get_messages",
			10_000,
		);
		const messages = ((response.data as { messages?: Array<Record<string, unknown>> })?.messages ?? []).filter(
			(message) => message.customType === "pi-tavern.group-chat-input",
		);
		const last = messages[messages.length - 1];
		const details = last?.details as { events?: Array<{ method?: string; params?: { content?: string } }> } | undefined;
		return (details?.events ?? [])
			.filter((event) => event.method === "public_message" && typeof event.params?.content === "string")
			.map((event) => event.params?.content ?? "");
	}

	it("WL-A/WL-B: 增量注入含游标自身最近已读 + 未读全量；窗口滑移旧消息移出", async () => {
		const { creator, agentDir, projectDir } = await startCreator();
		// 进入前水位背景（join 游标预置 = 进入时刻 latest_sequence，不注入历史）。
		await publishMessage(creator, "cw-1");
		await publishMessage(creator, "cw-2");

		const character = await startCharacter(agentDir, projectDir);
		// 消费第一条：cw-a 成为「游标自身最近已投递」。
		await publishMessage(creator, "cw-a");
		await waitForInjectWithLatestSeq(character, 3);

		// WL-A：下一次增量拉取窗口=1 → 注入 [cw-a（seq3 游标自身）+ cw-b（seq4 未读）]。
		await publishMessage(creator, "cw-b");
		await waitForInjectWithLatestSeq(character, 4);
		const batchB = await latestInjectedContents(character);
		expect(batchB).toContain("cw-a");
		expect(batchB).toContain("cw-b");

		// WL-B：游标推进到 4 后窗口滑移——[cw-b（最近已投递重复，预期设计）+ cw-c]，
		// cw-a 移出（不再注入）。
		await publishMessage(creator, "cw-c");
		await waitForInjectWithLatestSeq(character, 5);
		const batchC = await latestInjectedContents(character);
		expect(batchC).toContain("cw-b");
		expect(batchC).toContain("cw-c");
		expect(batchC).not.toContain("cw-a");
	});
});
