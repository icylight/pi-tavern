import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { PiProcess, type RpcEvent } from "./pi-process.js";
import { createTempRoot } from "./temp-root.js";

interface Role {
	id: string;
	name: string;
}

interface Operation {
	act: "tavern-new" | "tavern-join" | "headless-auto-join" | "reload" | "tavern-resume";
	channel: "rpc-notify" | "auto-join-stderr-prefix";
	notice_count: number;
}

interface EntriesScript {
	scenario: "SD215-template-notice-entries";
	resume_anchor: string;
	roles: Role[];
	templates: { global: Record<string, string>; project: Record<string, string> };
	operations: Operation[];
}

interface BoundaryCase {
	name: string;
	global: Record<string, string> | null;
	project: Record<string, string> | null;
	notice_count: number;
}

interface BoundaryScript {
	scenario: "SD215-template-notice-boundary";
	role: Role;
	cases: BoundaryCase[];
}

async function loadScript<T>(name: string): Promise<T> {
	const errors: ParseError[] = [];
	const value: unknown = parseJsonc(
		await readFile(join(import.meta.dirname, "scripts", `${name}.jsonc`), "utf8"),
		errors,
		{ allowTrailingComma: true },
	);
	expect(errors).toEqual([]);
	return value as T;
}

// 迁移通知需明确说明自定义模板在实时/新消息面的变化，而不是任意旧 warning 或成功提示。
function isMigrationNotice(message: unknown): boolean {
	return (
		typeof message === "string" &&
		/模板|message.templates?/i.test(message) &&
		/实时|新消息|新投递|结构化|live|delivery|structured/i.test(message)
	);
}

function rpcNoticeCount(process_: PiProcess, fromIndex: number): number {
	return process_
		.dumpEvents()
		.slice(fromIndex)
		.filter(
			(event) => event.type === "extension_ui_request" && event.method === "notify" && isMigrationNotice(event.message),
		).length;
}

function headlessNoticeCount(process_: PiProcess): number {
	return process_
		.getStderr()
		.split("\n")
		.filter((line) => line.startsWith("[pi-tavern:auto-join:") && isMigrationNotice(line)).length;
}

async function configure(
	root: string,
	roles: Role[],
	global: Record<string, string> | null,
	project: Record<string, string> | null,
): Promise<{ agentDir: string; projectDir: string }> {
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	await mkdir(join(agentDir, "characters"), { recursive: true });
	await mkdir(join(projectDir, ".pi"), { recursive: true });
	for (const role of roles) {
		await writeFile(
			join(agentDir, role.id),
			`---\nname: ${role.name}\ndescription: ${role.name}\n---\n${role.name} prompt`,
		);
	}
	await writeFile(
		join(agentDir, "tavern.json"),
		JSON.stringify({
			characters: roles.map((role) => role.id),
			...(global !== null ? { message_templates: "global-templates.json" } : {}),
		}),
	);
	if (global !== null) await writeFile(join(agentDir, "global-templates.json"), JSON.stringify(global));
	if (project !== null) {
		await writeFile(
			join(projectDir, ".pi", "tavern.json"),
			JSON.stringify({ message_templates: "project-templates.json" }),
		);
		await writeFile(join(projectDir, ".pi", "project-templates.json"), JSON.stringify(project));
	}
	return { agentDir, projectDir };
}

async function waitForCommandNotice(
	process_: PiProcess,
	checkpoint: { index: number },
	prefix: string,
): Promise<RpcEvent> {
	return process_.waitForAfter(
		checkpoint,
		(event) =>
			event.type === "extension_ui_request" &&
			event.method === "notify" &&
			typeof event.message === "string" &&
			event.message.startsWith(prefix),
		60_000,
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
	const choice = ((dialog.options as string[] | undefined) ?? []).find((option) => !option.startsWith("Delete"));
	if (choice === undefined) throw new Error("没有可恢复的群聊会话");
	creator.respond(String(dialog.id), { value: choice });
	await waitForCommandNotice(creator, checkpoint, "Resumed group chat ");
}

describe("acceptance: SD215 模板迁移提示的真实入口", () => {
	it(
		"chain:template-notice：新建/加入/headless/reload/恢复各次有效配置恰一条（sd215-template-notice-entries.jsonc）",
		{ timeout: 240_000 },
		async () => {
			const scenario = await loadScript<EntriesScript>("sd215-template-notice-entries");
			expect(scenario.scenario).toBe("SD215-template-notice-entries");
			expect(scenario.operations.map((operation) => operation.act)).toEqual([
				"tavern-new",
				"tavern-join",
				"headless-auto-join",
				"reload",
				"tavern-resume",
			]);
			const [alphaRole, betaRole] = scenario.roles;
			if (!alphaRole || !betaRole) throw new Error("剧本缺少交互/headless 两名角色");
			const root = await createTempRoot("pi-tavern-acc-sd215-notice-entries-");
			const processes: PiProcess[] = [];
			try {
				const { agentDir, projectDir } = await configure(
					root,
					scenario.roles,
					scenario.templates.global,
					scenario.templates.project,
				);
				const creator = PiProcess.spawn({
					label: "notice-creator",
					agentDir,
					sessionDir: join(root, "sessions", "creator"),
					cwd: projectDir,
				});
				processes.push(creator);
				await creator.waitForTavernReady();
				const newCheckpoint = creator.checkpoint();
				const descriptor = await creator.startGroupChat(projectDir, agentDir);
				await waitForCommandNotice(creator, newCheckpoint, "Created group chat ");
				const counts: number[] = [rpcNoticeCount(creator, newCheckpoint.index)];

				const alpha = PiProcess.spawn({
					label: "notice-alpha",
					agentDir,
					sessionDir: join(root, "sessions", "alpha"),
					cwd: projectDir,
				});
				processes.push(alpha);
				await alpha.waitForTavernReady();
				const joinCheckpoint = alpha.checkpoint();
				await alpha.joinGroupChat(projectDir, agentDir, `${alphaRole.name} — ${alphaRole.name}`);
				await alpha.waitForAfter(
					joinCheckpoint,
					(event) => event.type === "response" && event.command === "prompt",
					60_000,
				);
				counts.push(rpcNoticeCount(alpha, joinCheckpoint.index));

				const beta = PiProcess.spawn({
					label: "notice-beta",
					agentDir,
					sessionDir: join(root, "sessions", "beta"),
					cwd: projectDir,
					env: {
						PITAVERN_AUTO_JOIN: "1",
						PITAVERN_CHARACTER: betaRole.id,
						PITAVERN_GROUP_CHAT: descriptor.groupChatId,
						PITAVERN_AUTO_JOIN_DELAY_MS: "100",
					},
				});
				processes.push(beta);
				await beta.waitForStderr("Auto-joined", 60_000);
				counts.push(headlessNoticeCount(beta));

				const reloadCheckpoint = alpha.checkpoint();
				await alpha.runCommand("/tavern-test-reload");
				await alpha.waitForAfter(
					reloadCheckpoint,
					(event) => event.type === "response" && event.command === "prompt",
					60_000,
				);
				// 等 reload 新扩展接管并输出 UI 事件；不能用 console.warn 代替 notify。
				await alpha.waitForAfter(
					reloadCheckpoint,
					(event) =>
						event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-tavern",
					60_000,
				);
				counts.push(rpcNoticeCount(alpha, reloadCheckpoint.index));

				const publishedCheckpoint = creator.checkpoint();
				await creator.runCommand(`/tavern-test-message ${scenario.resume_anchor}`);
				await waitForCommandNotice(creator, publishedCheckpoint, "User Persona message published");
				const closeCheckpoint = creator.checkpoint();
				await creator.runCommand("/tavern-leave");
				await waitForCommandNotice(creator, closeCheckpoint, "Group chat closed");
				const resumeCheckpoint = creator.checkpoint();
				await resume(creator);
				counts.push(rpcNoticeCount(creator, resumeCheckpoint.index));
				expect(counts).toEqual(scenario.operations.map((operation) => operation.notice_count));
			} finally {
				await Promise.all(processes.map((process_) => process_.kill("SIGTERM").catch(() => undefined)));
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it(
		"chain:template-notice-boundary：无配置/仅非法为零，项目非法回退有效全局为一（sd215-template-notice-boundary.jsonc）",
		{ timeout: 240_000 },
		async () => {
			const scenario = await loadScript<BoundaryScript>("sd215-template-notice-boundary");
			expect(scenario.scenario).toBe("SD215-template-notice-boundary");
			const actual: number[] = [];
			for (const testcase of scenario.cases) {
				const root = await createTempRoot(`pi-tavern-acc-sd215-${testcase.name}-`);
				let creator: PiProcess | undefined;
				try {
					const { agentDir, projectDir } = await configure(root, [scenario.role], testcase.global, testcase.project);
					creator = PiProcess.spawn({
						label: testcase.name,
						agentDir,
						sessionDir: join(root, "sessions", "creator"),
						cwd: projectDir,
					});
					await creator.waitForTavernReady();
					const checkpoint = creator.checkpoint();
					await creator.startGroupChat(projectDir, agentDir);
					await waitForCommandNotice(creator, checkpoint, "Created group chat ");
					actual.push(rpcNoticeCount(creator, checkpoint.index));
				} finally {
					await creator?.kill("SIGTERM").catch(() => undefined);
					await rm(root, { recursive: true, force: true });
				}
			}
			expect(actual).toEqual(scenario.cases.map((testcase) => testcase.notice_count));
		},
	);
});
