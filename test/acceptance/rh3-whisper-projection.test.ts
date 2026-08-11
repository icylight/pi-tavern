import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { afterAll, describe, expect, it } from "vitest";

import { PiProcess, waitForDescriptor } from "./pi-process.js";
import { type BufferedWsClient, connectCharacter } from "./ws-helper.js";

/**
 * RH3-whisper 首部剧本（剧本驱动 e2e MVP v0，一用例一剧本）。
 * 剧本：test/acceptance/scripts/rh3-whisper-projection.jsonc
 *
 * 场景：Alice 公开消息打底 → whisper Carol「悄悄话R1」→ 创建者完整正文 /
 * 接收者实时正文 / 旁观者占位（无正文）→ 重启 resume 后创建者仍见完整正文。
 *
 * 断言（#152 RH3 补验 + WH8 恢复 + WH4 投影 + WH6 非唤醒）：
 * - 创建者实时投影 whisper_message 含完整正文；
 * - 接收者 Carol 实时收到正文（whisper_message 帧）；
 * - 旁观者仅 whisper_placeholder 且无正文；
 * - 重启恢复后创建者投影仍含完整正文（RH3 验收点，AI 评审第三轮阻断）。
 *
 * 红测语义：旧实现（bc5fd5e 前无 whisper 投影/占位广播）下创建者投影
 * 无 whisper 分支、旁观者无占位帧 → 断言必红。
 */

interface ScriptStep {
	act: "persona" | "speak" | "whisper";
	sender: string;
	recipient?: string;
	content: string;
	sequence?: number;
	expect: Array<{
		observer: string;
		kind?: string;
		frame?: string;
		content_contains?: string;
		content_absent?: boolean;
		sequence?: number;
	}>;
}

interface Script {
	scenario: string;
	roles: Record<string, string>;
	steps: ScriptStep[];
	recovery?: {
		restart: boolean;
		expect: Array<{ observer: string; kind?: string; content_contains?: string; sequence?: number }>;
	};
}

describe("acceptance: RH3-whisper-projection（#152 剧本驱动首部剧本）", () => {
	let root: string | undefined;
	const processes: PiProcess[] = [];

	afterAll(async () => {
		for (const process_ of processes) {
			await process_.kill("SIGTERM").catch(() => undefined);
		}
		if (root) {
			await rm(root, { recursive: true, force: true }).catch(() => undefined);
		}
	});

	function startCreator(agentDir: string, sessionDir: string, projectDir: string): PiProcess {
		const process_ = PiProcess.spawn({ label: "creator", agentDir, sessionDir, cwd: projectDir });
		processes.push(process_);
		return process_;
	}

	function requireRole(script: Script, key: string): string {
		const role = script.roles[key];
		if (role === undefined) {
			throw new Error(`script role missing: ${key}`);
		}
		return role;
	}

	async function resumeGroupChat(creator: PiProcess): Promise<void> {
		await creator.runCommand("/tavern-resume");
		const select = await creator.waitFor((e) => e.type === "extension_ui_request" && e.method === "select", 60_000);
		const options = (select.options as unknown as string[]) ?? [];
		const chosen = options.find((o) => !o.startsWith("Delete")) ?? options[0];
		if (chosen === undefined) {
			throw new Error("[creator] no resumable session options available");
		}
		creator.respond(String(select.id), { value: chosen });
		await creator.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				typeof e.message === "string" &&
				e.message.startsWith("Resumed group chat"),
			60_000,
		);
	}

	it("RH3-whisper：创建者完整正文 / 接收者实时 / 旁观者占位 / 重启恢复（剧本 rh3-whisper-projection.jsonc）", async () => {
		root = await mkdtemp(join(tmpdir(), "pi-tavern-acc-rh3w-"));
		const agentDir = join(root, "agent");
		const sessionDir = join(agentDir, "sessions", "creator");
		const projectDir = join(root, "project");
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await mkdir(projectDir, { recursive: true });
		for (const [name, description] of [
			["dev.md", "Developer"],
			["qa.md", "QA"],
			["arch.md", "Architect"],
		] as const) {
			await writeFile(
				join(agentDir, "characters", name),
				`---\nname: ${description}\ndescription: ${description}\n---\n${description} prompt`,
			);
		}
		await writeFile(
			join(agentDir, "tavern.json"),
			JSON.stringify({ characters: ["characters/dev.md", "characters/qa.md", "characters/arch.md"] }),
		);

		// 剧本加载（.jsonc：strip comments 后即标准 JSON）。
		const script = parseJsonc(
			await import("node:fs/promises").then((fs) =>
				fs.readFile(join(__dirname, "scripts", "rh3-whisper-projection.jsonc"), "utf8"),
			),
			[],
			{ allowTrailingComma: true },
		) as Script;
		expect(script.scenario).toBe("RH3-whisper-projection");

		// 阶段一：创建者建群 + 三角色 WS 连接（真实协议链）。
		const creator = startCreator(agentDir, sessionDir, projectDir);
		await creator.waitForTavernReady();
		await creator.startGroupChat(projectDir, agentDir);
		const descriptor = await waitForDescriptor(agentDir, projectDir);
		const alice = await connectCharacter(descriptor, "sess-alice", requireRole(script, "alice"));
		const carol = await connectCharacter(descriptor, "sess-carol", requireRole(script, "carol"));
		const bystander = await connectCharacter(descriptor, "sess-bystander", requireRole(script, "bystander"));

		const checkpoint = creator.checkpoint();

		// 阶段二：按剧本执行 steps（speak 打底 + whisper 三观察者）。
		for (const step of script.steps) {
			if (step.act === "persona") {
				// 开场：User Persona 消息开启讨论轮次（无 WS 方法，走创建者测试命令）。
				await creator.runCommand(`/tavern-test-message ${step.content}`);
			} else if (step.act === "speak") {
				const response = await alice.sendAndWait("speak", { content: step.content });
				if (step.sequence !== undefined) {
					// 真读真断言：响应序号必须与剧本一致（防剧本序号假绿）。
					const result = response.result as { sequence?: number } | undefined;
					expect(result?.sequence).toBe(step.sequence);
				}
			} else if (step.act === "whisper" && step.recipient) {
				const response = await alice.sendAndWait("whisper", {
					character_id: requireRole(script, step.recipient),
					content: step.content,
				});
				if (step.sequence !== undefined) {
					const result = response.result as { sequence?: number } | undefined;
					expect(result?.sequence).toBe(step.sequence);
				}
			}

			for (const expected of step.expect) {
				if (expected.observer === "creator" && expected.kind) {
					// 创建者：creator-display 投影事件（实时，checkpoint 后）。
					const event = await creator.waitForAfter(
						checkpoint,
						(e) => {
							if (e.type !== "entry_appended") return false;
							const entry = (
								e as {
									entry?: {
										customType?: string;
										data?: { kind?: string; event?: { content?: string; sequence?: number } };
									};
								}
							).entry;
							return (
								entry?.customType === "pi-tavern.creator-display" &&
								entry.data?.kind === expected.kind &&
								(expected.sequence === undefined || entry.data?.event?.sequence === expected.sequence) &&
								(expected.content_contains === undefined ||
									(entry.data?.event?.content ?? "").includes(expected.content_contains))
							);
						},
						30_000,
					);
					expect(event).toBeTruthy();
				} else if (expected.frame) {
					// Character 观察者：WS 帧流断言。
					const client: BufferedWsClient = expected.observer === "carol" ? carol : bystander;
					const frame = await client.waitFor((m) => {
						const method = m.method as string | undefined;
						if (method !== expected.frame) return false;
						const params = (m.params ?? {}) as Record<string, unknown>;
						if (expected.sequence !== undefined && params.sequence !== expected.sequence) return false;
						if (expected.content_absent) {
							// WH4/WH6 契约：占位帧无正文——content 字段必须不存在（而非
							// 内容为空/不含某字面量——防泄露帧假绿，第五轮 AI 评审阻断）。
							return !("content" in params) && !Object.hasOwn(params, "content");
						}
						if (expected.content_contains !== undefined) {
							return ((params.content as string | undefined) ?? "").includes(expected.content_contains);
						}
						return true;
					}, 30_000);
					expect(frame).toBeTruthy();
				}
			}
		}

		// 阶段三：重启恢复（RH3 验收点）——kill 创建者 → 重启 → resume →
		// 创建者投影仍含完整正文（whisper_message kind + 正文）。
		await creator.kill("SIGTERM");
		const resumed = startCreator(agentDir, sessionDir, projectDir);
		await resumed.waitForTavernReady();
		await resumeGroupChat(resumed);

		const recoveryExpect = script.recovery?.expect?.[0];
		expect(recoveryExpect?.kind).toBe("whisper_message");
		const recoverySequence = recoveryExpect?.sequence;
		const projected = resumed
			.dumpEvents()
			.filter((e) => e.type === "entry_appended")
			.map(
				(e) =>
					(
						e as {
							entry?: {
								customType?: string;
								data?: { kind?: string; event?: { content?: string; sequence?: number } };
							};
						}
					).entry,
			)
			.filter((entry) => entry?.customType === "pi-tavern.creator-display" && entry.data?.kind === "whisper_message");
		expect(projected.length).toBeGreaterThan(0);
		expect(
			projected.some(
				(entry) =>
					(entry?.data?.event?.content ?? "").includes("悄悄话R1") &&
					(recoverySequence === undefined || entry?.data?.event?.sequence === recoverySequence),
			),
		).toBe(true);
	}, 120_000);
});
