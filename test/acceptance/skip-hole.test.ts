import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PiProcess, waitForDescriptor } from "./pi-process.js";
import { createTempRoot } from "./temp-root.js";

/**
 * acceptance A1（#201）：投递完整性不变量——场景末「会话注入 seq 集 ∩ 外部消息集
 * = 群日志外部消息集」（无洞）。
 *
 * 口径（acceptance.md「消费水位推进（#201）」行）：窗口剔除 join 预置水位前、
 * 自身消息、whisper/board 帧——本场景以自证标记（内容含 `a1-`）只取本场景发布的
 * 外部 User Persona 消息，剔除由构造成立（join 前无标记消息、无自身发言、无 whisper/board）。
 *
 * 观察通道：
 * - 注入集 = pi RPC `get_messages` → `customType=pi-tavern.group-chat-input` 批的
 *   `details.events[].params.sequence`（真实会话内注入，非通知代理）；
 * - 外部集 = 群聊日志 jsonl（`<agentDir>/tavern/.../chats/*.jsonl`）中
 *   `pi-tavern.public-message` 且内容含标记的 `details.sequence`。
 *
 * 性质：不变量护栏（修前修后均绿；真实 pi 无法确定性触发清队丢弃——红面由
 * integration `skip-hole.test.ts` R2/R7 承担）。场景含忙态窗口以覆盖混合投递条件。
 */

describe("acceptance: #201 投递完整性不变量（A1）", () => {
	const roots: string[] = [];
	const processes: PiProcess[] = [];

	afterAll(async () => {
		for (const process_ of processes) {
			await process_.kill("SIGTERM").catch(() => undefined);
		}
		await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
	});

	async function startFixture(): Promise<{
		creator: PiProcess;
		character: PiProcess;
		agentDir: string;
		projectDir: string;
	}> {
		const root = await createTempRoot("pi-tavern-acc-a1-");
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
		// 等 join 命令完成（prompt 响应落定），避免尾部活动阻塞后续命令处理。
		const settleCheckpoint = character.checkpoint();
		await character.waitForAfter(settleCheckpoint, (e) => e.type === "response" && e.command === "prompt", 10_000);
		return { creator, character, agentDir, projectDir };
	}

	/** 发布群聊消息并等待发布确认（prompt 队列阻塞时重试）。 */
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
						typeof e.message === "string" &&
						e.message.includes("User Persona message published"),
					10_000,
				);
				return;
			} catch {
				// 重试：prompt 队列可能被尾部 run 占用。
			}
		}
		throw new Error("消息发布未确认（creator prompt 队列阻塞？）");
	}

	/** 忙态钩子（零 LLM 环境）：使忙态投递路径可确定性构造。 */
	async function runBusy(character: PiProcess, ms: number): Promise<void> {
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const checkpoint = character.checkpoint();
			await character.runCommand(`/tavern-test-busy ${ms}`);
			try {
				await character.waitForAfter(
					checkpoint,
					(e) =>
						e.type === "extension_ui_request" &&
						e.method === "notify" &&
						typeof e.message === "string" &&
						e.message.includes(`[tavern-test-busy] busy=${ms}ms`),
					10_000,
				);
				return;
			} catch {
				// 重试：尾部 run 可能占用 prompt 队列。
			}
		}
		throw new Error(`busy hook 未在 30s 内生效（prompt 队列被阻塞？）`);
	}

	/** 会话内已注入的 sequence 集（get_messages → custom_message.details.events）。 */
	async function readInjectedSequences(character: PiProcess): Promise<Set<number>> {
		const id = await character.send({ type: "get_messages" });
		const response = await character.waitFor(
			(e) => e.id === id && e.type === "response" && e.command === "get_messages",
			10_000,
		);
		const messages = (response.data as { messages?: Array<Record<string, unknown>> })?.messages ?? [];
		const sequences = new Set<number>();
		for (const message of messages) {
			if (message.customType !== "pi-tavern.group-chat-input") continue;
			const details = message.details as { events?: Array<{ params?: { sequence?: unknown } }> } | undefined;
			for (const event of details?.events ?? []) {
				const sequence = event.params?.sequence;
				if (typeof sequence === "number") sequences.add(sequence);
			}
		}
		return sequences;
	}

	/** 群聊日志中本场景标记外部消息的 sequence 集（内容含 `a1-`）。 */
	async function readExternalMarkerSequences(agentDir: string): Promise<Map<number, string>> {
		const chatsDirs: string[] = [];
		const tavernRoot = join(agentDir, "tavern");
		for (const entry of await readdir(tavernRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const chatsDir = join(tavernRoot, entry.name, "chats");
			try {
				if ((await readdir(chatsDir)).length > 0) chatsDirs.push(chatsDir);
			} catch {
				// 非群聊目录无 chats 子目录。
			}
		}
		const found = new Map<number, string>();
		for (const dir of chatsDirs) {
			for (const file of await readdir(dir)) {
				if (!file.endsWith(".jsonl")) continue;
				const raw = await readFile(join(dir, file), "utf8");
				for (const line of raw.split("\n")) {
					if (line.trim() === "") continue;
					let entry: Record<string, unknown>;
					try {
						entry = JSON.parse(line) as Record<string, unknown>;
					} catch {
						continue;
					}
					if (entry.type !== "custom_message" || entry.customType !== "pi-tavern.public-message") continue;
					const details = entry.details as { sequence?: unknown; content?: unknown } | undefined;
					const content = String(details?.content ?? entry.content ?? "");
					const sequence = details?.sequence;
					if (typeof sequence === "number" && content.includes("a1-")) {
						found.set(sequence, content.trim());
					}
				}
			}
		}
		return found;
	}

	it("A1：忙闲混合窗口后，群日志外部消息 seq 全部进入会话注入（无洞）", { timeout: 120_000 }, async () => {
		const { creator, character, agentDir } = await startFixture();

		// 外部消息混合闲态与忙态窗口。
		await publishMessage(creator, "a1-idle-1");
		await Promise.all([runBusy(character, 3_000), publishMessage(creator, "a1-busy-2")]);
		await publishMessage(creator, "a1-busy-3");
		await publishMessage(creator, "a1-idle-4");

		const external = await readExternalMarkerSequences(agentDir);
		expect(external.size).toBeGreaterThanOrEqual(4);
		const externalSequences = [...external.keys()];

		// 等待全部外部消息进入会话注入（真实 pi 投递异步）；超时后由断言给出缺失清单。
		const deadline = Date.now() + 30_000;
		let injected = new Set<number>();
		for (;;) {
			injected = await readInjectedSequences(character);
			if (externalSequences.every((sequence) => injected.has(sequence))) break;
			if (Date.now() > deadline) break;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}

		const missing = externalSequences.filter((sequence) => !injected.has(sequence));
		expect(
			missing,
			`缺失注入 seq=[${missing.join(",")}]（对应内容：${missing.map((s) => external.get(s)).join(" | ")}）`,
		).toEqual([]);
	});
});
