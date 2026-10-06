import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import {
	type ActiveGroupChatDescriptor,
	getGroupChatCursorDirectory,
} from "../../src/data/discovery/active-descriptor.js";
import { PiProcess, type RpcEvent } from "./pi-process.js";
import { createTempRoot } from "./temp-root.js";
import { connectCharacter } from "./ws-helper.js";

interface Role {
	id: string;
	name: string;
}

interface Scene {
	creator: PiProcess;
	agentDir: string;
	projectDir: string;
	descriptor: ActiveGroupChatDescriptor;
	startCharacter: (role: Role, mode?: "headless" | "manual") => Promise<PiProcess>;
	close: () => Promise<void>;
}

interface Step {
	act: string;
	content?: string;
	from?: string;
	to?: string;
	expect?: Record<string, string | string[]> | string;
}

interface WhisperScript {
	scenario: "SD215-whisper-views";
	roles: Role[];
	secret_marker: string;
	steps: Step[];
}

interface RejoinScript {
	scenario: "SD215-manual-rejoin";
	role: Role;
	steps: Step[];
}

interface PartitionScript {
	scenario: "SD215-partitions";
	roles: Role[];
	board_note: string;
	public_message: string;
	expected: { board_heading: string; system_heading: string; public_method: string };
}

async function script<T>(name: string): Promise<T> {
	const errors: ParseError[] = [];
	const parsed: unknown = parseJsonc(
		await readFile(join(import.meta.dirname, "scripts", `${name}.jsonc`), "utf8"),
		errors,
		{ allowTrailingComma: true },
	);
	expect(errors).toEqual([]);
	return parsed as T;
}

function step(steps: Step[], index: number, act: string): Step {
	const value = steps[index];
	if (!value || value.act !== act) throw new Error(`剧本步骤 ${index} 预期 ${act}`);
	return value;
}

function text(value: string | undefined): string {
	if (value === undefined) throw new Error("剧本缺少消息正文");
	return value;
}

async function createScene(name: string, roles: Role[]): Promise<Scene> {
	const root = await createTempRoot(`pi-tavern-acc-${name}-`);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const processes: PiProcess[] = [];
	try {
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await mkdir(projectDir, { recursive: true });
		for (const role of roles) {
			await writeFile(
				join(agentDir, role.id),
				`---\nname: ${role.name}\ndescription: ${role.name}\n---\n${role.name} prompt`,
			);
		}
		await writeFile(join(agentDir, "tavern.json"), JSON.stringify({ characters: roles.map((role) => role.id) }));
		const creator = PiProcess.spawn({
			label: `${name}-creator`,
			agentDir,
			sessionDir: join(root, "sessions", "creator"),
			cwd: projectDir,
		});
		processes.push(creator);
		const descriptor = await creator.startGroupChat(projectDir, agentDir);
		return {
			creator,
			agentDir,
			projectDir,
			descriptor,
			startCharacter: async (role, mode = "headless") => {
				const process_ = PiProcess.spawn({
					label: `${name}-${role.name}`,
					agentDir,
					sessionDir: join(root, "sessions", role.name),
					cwd: projectDir,
					...(mode === "headless"
						? {
								env: {
									PITAVERN_AUTO_JOIN: "1",
									PITAVERN_CHARACTER: role.id,
									PITAVERN_GROUP_CHAT: descriptor.groupChatId,
									PITAVERN_AUTO_JOIN_DELAY_MS: "100",
								},
							}
						: {}),
				});
				processes.push(process_);
				if (mode === "headless") {
					await process_.waitForStderr("Auto-joined", 60_000);
				} else {
					await process_.joinGroupChat(projectDir, agentDir, `${role.name} — ${role.name}`);
				}
				await process_.waitFor((event) => groupInputContent(event)?.includes("系统消息：") === true, 60_000);
				return process_;
			},
			close: async () => {
				await Promise.all(processes.map((process_) => process_.kill("SIGTERM").catch(() => undefined)));
				await rm(root, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await Promise.all(processes.map((process_) => process_.kill("SIGTERM").catch(() => undefined)));
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

function groupInputContent(event: RpcEvent): string | undefined {
	if (event.type !== "message_start") return undefined;
	const message = event.message as { customType?: unknown; content?: unknown } | undefined;
	return message?.customType === "pi-tavern.group-chat-input" && typeof message.content === "string"
		? message.content
		: undefined;
}

async function piSessionId(process_: PiProcess): Promise<string> {
	const id = await process_.send({ type: "get_state" });
	const response = await process_.waitFor(
		(event) => event.type === "response" && event.command === "get_state" && event.id === id,
		10_000,
	);
	const sessionId = (response.data as { sessionId?: unknown } | undefined)?.sessionId;
	if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("真实 pi 会话缺少 sessionId");
	return sessionId;
}

async function consumedInputSince(
	process_: PiProcess,
	checkpoint: { index: number },
	marker: string,
	stage: string,
): Promise<string> {
	let event: RpcEvent;
	try {
		event = await process_.waitForAfter(
			checkpoint,
			(candidate) => groupInputContent(candidate)?.includes(marker) === true,
			60_000,
		);
	} catch (error) {
		const consumedCount = process_
			.dumpEvents()
			.slice(checkpoint.index)
			.filter((candidate) => groupInputContent(candidate) !== undefined).length;
		throw new Error(`[${process_.label}] ${stage}: 等待已消费 content 失败（检查点后输入 ${consumedCount} 批）`, {
			cause: error,
		});
	}
	const content = groupInputContent(event);
	if (content === undefined) throw new Error("不是已消费的 PiTavern 输入");
	// message_start 是消费确认点；get_messages 进一步核对同条真实 pi 会话记录。
	const id = await process_.send({ type: "get_messages" });
	const response = await process_.waitFor(
		(candidate) => candidate.type === "response" && candidate.command === "get_messages" && candidate.id === id,
		10_000,
	);
	const messages =
		(response.data as { messages?: Array<{ customType?: unknown; content?: unknown }> } | undefined)?.messages ?? [];
	expect(
		messages.some((message) => message.customType === "pi-tavern.group-chat-input" && message.content === content),
	).toBe(true);
	return content;
}

function parseMessages(content: string): Array<{ jsonrpc: string; method: string; params: Record<string, unknown> }> {
	const start = content.indexOf("新消息：\n");
	if (start < 0) throw new Error("已消费 content 缺少独立的新消息分区");
	const remaining = content.slice(start + "新消息：\n".length).trimStart();
	if (!remaining.startsWith("[")) throw new Error("已消费的新消息不是 JSON 数组");
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < remaining.length; i += 1) {
		const char = remaining[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "[") depth += 1;
		else if (char === "]" && --depth === 0) {
			const value: unknown = JSON.parse(remaining.slice(0, i + 1));
			if (!Array.isArray(value)) throw new Error("已消费的新消息不是 JSON 数组");
			return value as Array<{ jsonrpc: string; method: string; params: Record<string, unknown> }>;
		}
	}
	throw new Error("已消费的新消息缺少完整的 JSON 数组边界");
}

async function publish(creator: PiProcess, content: string): Promise<void> {
	const checkpoint = creator.checkpoint();
	await creator.runCommand(`/tavern-test-message ${content}`);
	await creator.waitForAfter(
		checkpoint,
		(event) =>
			event.type === "extension_ui_request" &&
			event.method === "notify" &&
			event.message === "User Persona message published",
		30_000,
	);
}

async function resume(creator: PiProcess): Promise<void> {
	const checkpoint = creator.checkpoint();
	await creator.runCommand("/tavern-resume");
	const dialog = await creator.waitForAfter(
		checkpoint,
		(event) =>
			(event.type === "extension_ui_request" && event.method === "select") ||
			(event.type === "extension_ui_request" &&
				event.method === "notify" &&
				String(event.message).includes("No resumable group chat")),
		30_000,
	);
	if (dialog.method !== "select") throw new Error(`resume 没有选择项：${String(dialog.message)}`);
	const options = (dialog.options as string[] | undefined) ?? [];
	const choice = options.find((option) => !option.startsWith("Delete"));
	if (!choice) throw new Error("未出现可恢复的群聊会话");
	creator.respond(String(dialog.id), { value: choice });
	await creator.waitForAfter(
		checkpoint,
		(event) =>
			event.type === "extension_ui_request" &&
			event.method === "notify" &&
			String(event.message).startsWith("Resumed group chat "),
		60_000,
	);
}

describe("acceptance: SD215 真实 pi 已消费的新消息", () => {
	it(
		"chain:whisper-views：三视角正文/占位与含转义密文不泄露（sd215-whisper-views.jsonc）",
		{ timeout: 240_000 },
		async () => {
			const scenario = await script<WhisperScript>("sd215-whisper-views");
			expect(scenario.scenario).toBe("SD215-whisper-views");
			expect(scenario.steps.map((item) => item.act)).toEqual(["persona", "whisper", "persona"]);
			const [aliceRole, bobRole, carolRole] = scenario.roles;
			if (!aliceRole || !bobRole || !carolRole) throw new Error("剧本缺少三名角色");
			const scene = await createScene("sd215-views", scenario.roles);
			try {
				await publish(scene.creator, text(step(scenario.steps, 0, "persona").content));
				const [alice, bob, carol] = await Promise.all([
					scene.startCharacter(aliceRole),
					scene.startCharacter(bobRole),
					scene.startCharacter(carolRole),
				]);
				const aliceCheckpoint = alice.checkpoint();
				const bobCheckpoint = bob.checkpoint();
				const carolCheckpoint = carol.checkpoint();
				const privateStep = step(scenario.steps, 1, "whisper");
				expect([privateStep.from, privateStep.to]).toEqual([aliceRole.name, bobRole.name]);
				const secret = text(privateStep.content);
				expect(secret.startsWith(scenario.secret_marker)).toBe(true);
				const compactProbe = JSON.stringify([
					{ jsonrpc: "2.0", method: "whisper_message", params: { content: secret } },
				]);
				expect(parseMessages(`新消息：\n${compactProbe}\n\n请根据这些群聊变化继续当前工作。`)[0]?.params.content).toBe(
					secret,
				);
				const sentCheckpoint = alice.checkpoint();
				await alice.runCommand(`/tavern-test-whisper ${JSON.stringify({ target: bobRole.id, content: secret })}`);
				const sent = await alice.waitForAfter(
					sentCheckpoint,
					(event) =>
						event.type === "extension_ui_request" &&
						event.method === "notify" &&
						String(event.message).startsWith("[tavern-test-whisper]"),
					30_000,
				);
				expect(String(sent.message)).toContain("ok=T");
				const sequence = Number(String(sent.message).match(/sequence=(\d+)/)?.[1]);
				expect(Number.isSafeInteger(sequence)).toBe(true);

				const received = await consumedInputSince(bob, bobCheckpoint, scenario.secret_marker, "私信接收者");
				const full = parseMessages(received).find((entry) => entry.params.sequence === sequence);
				expect(full?.method).toBe((privateStep.expect as Record<string, string>).recipient);
				expect(full?.params.content).toBe(secret);
				expect(Object.keys(full ?? {}).sort()).toEqual(["jsonrpc", "method", "params"]);
				expect(Object.keys(full?.params ?? {}).sort()).toEqual([
					"content",
					"event_id",
					"recipient",
					"round",
					"sender",
					"sequence",
					"timestamp",
				]);
				// 没有 public/group_chat_update 时，旁观者的实时占位只记水位，不唤醒。
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_200));
				const newInputs = carol
					.dumpEvents()
					.slice(carolCheckpoint.index)
					.map(groupInputContent)
					.filter((value) => value !== undefined);
				expect(newInputs).toEqual([]);
				expect(
					alice
						.dumpEvents()
						.slice(aliceCheckpoint.index)
						.map(groupInputContent)
						.filter((value) => value?.includes(scenario.secret_marker)),
				).toEqual([]);

				const wake = text(step(scenario.steps, 2, "persona").content);
				await publish(scene.creator, wake);
				const bystanderInput = await consumedInputSince(carol, carolCheckpoint, wake, "旁观者补拉");
				const bystanderMessages = parseMessages(bystanderInput);
				const placeholder = bystanderMessages.find((entry) => entry.params.sequence === sequence);
				expect(placeholder?.method).toBe((privateStep.expect as Record<string, string>).bystander_after_pull);
				const absentKeys = (privateStep.expect as { absent_keys?: string[] } | undefined)?.absent_keys;
				if (!absentKeys) throw new Error("剧本缺少旁观者无正文键断言");
				for (const key of absentKeys) {
					expect(placeholder?.params).not.toHaveProperty(key);
				}
				expect(bystanderMessages.map((entry) => entry.params.sequence)).toEqual(
					[...bystanderMessages.map((entry) => entry.params.sequence)].sort((a, b) => Number(a) - Number(b)),
				);
				expect(
					bystanderMessages.some((entry) => entry.method === "public_message" && entry.params.content === wake),
				).toBe(true);
				expect(
					carol
						.dumpEvents()
						.slice(carolCheckpoint.index)
						.map(groupInputContent)
						.every((value) => !value?.includes(scenario.secret_marker)),
				).toBe(true);
				expect(bystanderInput).not.toContain(scenario.secret_marker);
			} finally {
				await scene.close();
			}
		},
	);

	it(
		"chain:manual-rejoin：真实断线后同 Session 补齐断线窗口（sd215-manual-rejoin.jsonc）",
		{ timeout: 240_000 },
		async () => {
			const scenario = await script<RejoinScript>("sd215-manual-rejoin");
			expect(scenario.scenario).toBe("SD215-manual-rejoin");
			expect(scenario.steps.map((item) => item.act)).toEqual([
				"persona",
				"persona",
				"creator_leave",
				"creator_resume",
				"persona",
				"character_join",
			]);
			const scene = await createScene("sd215-rejoin", [scenario.role]);
			try {
				await publish(scene.creator, text(step(scenario.steps, 0, "persona").content));
				const watcher = await scene.startCharacter(scenario.role, "manual");
				const firstSessionId = await piSessionId(watcher);
				const beforeCheckpoint = watcher.checkpoint();
				const before = text(step(scenario.steps, 1, "persona").content);
				await publish(scene.creator, before);
				await consumedInputSince(watcher, beforeCheckpoint, before, "断线前公开消息");
				const cursorDir = join(
					getGroupChatCursorDirectory(scene.agentDir, scene.projectDir),
					scene.descriptor.groupChatId,
				);
				const cursorFile = `${firstSessionId}.json`;
				expect((await readFile(join(cursorDir, cursorFile), "utf8")).length).toBeGreaterThan(0);
				expect(await readdir(cursorDir)).toEqual([cursorFile]);

				step(scenario.steps, 2, "creator_leave");
				const closeCheckpoint = scene.creator.checkpoint();
				await scene.creator.runCommand("/tavern-leave");
				await scene.creator.waitForAfter(
					closeCheckpoint,
					(event) =>
						event.type === "extension_ui_request" && event.method === "notify" && event.message === "Group chat closed",
					30_000,
				);
				// 角色没有执行 /tavern-leave。创建者关闭真实 WS 后，Controller 必须回 idle。
				let disconnected = false;
				for (let attempt = 0; attempt < 10 && !disconnected; attempt += 1) {
					const idleCheckpoint = watcher.checkpoint();
					await watcher.runCommand("/tavern-test-whoami");
					const state = await watcher.waitForAfter(
						idleCheckpoint,
						(event) =>
							event.type === "extension_ui_request" &&
							event.method === "notify" &&
							(event.message === "Not in character state" || String(event.message).startsWith("[tavern-test-whoami]")),
						10_000,
					);
					disconnected = state.message === "Not in character state";
					if (!disconnected) await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
				}
				expect(disconnected).toBe(true);

				step(scenario.steps, 3, "creator_resume");
				await resume(scene.creator);
				const missed = text(step(scenario.steps, 4, "persona").content);
				await publish(scene.creator, missed);
				step(scenario.steps, 5, "character_join");
				const rejoinCheckpoint = watcher.checkpoint();
				await watcher.joinGroupChat(scene.projectDir, scene.agentDir, `${scenario.role.name} — ${scenario.role.name}`);
				const welcome = await consumedInputSince(watcher, rejoinCheckpoint, "系统消息：", "重入新欢迎");
				expect(await piSessionId(watcher)).toBe(firstSessionId);
				expect(await readdir(cursorDir)).toEqual([cursorFile]);
				expect(welcome).toContain("系统消息："); // 新 join 发新欢迎；不要求与补拉合批。
				const recovered = await consumedInputSince(watcher, rejoinCheckpoint, missed, "重入断线窗口补拉");
				const messages = parseMessages(recovered);
				expect(messages.some((entry) => entry.method === "public_message" && entry.params.content === missed)).toBe(
					true,
				);
			} finally {
				await scene.close();
			}
		},
	);

	it(
		"chain:partition：欢迎与白板独立分区，公开消息仍为 JSON 元素（sd215-partitions.jsonc）",
		{ timeout: 180_000 },
		async () => {
			const scenario = await script<PartitionScript>("sd215-partitions");
			expect(scenario.scenario).toBe("SD215-partitions");
			const [observerRole, writerRole] = scenario.roles;
			if (!observerRole || !writerRole) throw new Error("剧本缺少观察者/白板写入者");
			const scene = await createScene("sd215-partition", scenario.roles);
			let writer: Awaited<ReturnType<typeof connectCharacter>> | undefined;
			try {
				const observer = await scene.startCharacter(observerRole);
				const welcome = observer
					.dumpEvents()
					.map(groupInputContent)
					.find((content) => content?.includes("系统消息："));
				expect(welcome).toContain(scenario.expected.system_heading);
				expect(welcome).toContain("你的当前角色：");
				expect(welcome).toContain("来源：群聊");
				expect(welcome).not.toContain("新消息：");

				writer = await connectCharacter(scene.descriptor, "sd215-board-writer", writerRole.id);
				const boardCheckpoint = observer.checkpoint();
				const written = await writer.sendAndWait("board_write", {
					action: "set",
					note: { content: scenario.board_note },
				});
				expect((written.result as { changed?: boolean } | undefined)?.changed).toBe(true);
				const board = await consumedInputSince(observer, boardCheckpoint, scenario.board_note, "白板独立通知");
				expect(board).toContain(scenario.expected.board_heading);
				expect(board).not.toContain("新消息：");

				const publicCheckpoint = observer.checkpoint();
				await publish(scene.creator, scenario.public_message);
				const publicInput = await consumedInputSince(
					observer,
					publicCheckpoint,
					scenario.public_message,
					"公开消息结构化",
				);
				const elements = parseMessages(publicInput);
				expect(
					elements.some(
						(element) =>
							element.method === scenario.expected.public_method && element.params.content === scenario.public_message,
					),
				).toBe(true);
				expect(
					elements.some((element) => element.method === "board_update" || element.method === "system_message"),
				).toBe(false);
			} finally {
				writer?.terminate();
				await scene.close();
			}
		},
	);
});
