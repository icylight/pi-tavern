/**
 * #180 角色模型生命周期（character-model-hook）acceptance——L3 红钉。
 *
 * 契约源：docs/architecture/character-model-hook.md（§4/§7/§8/§10/§12 + pi v0.84.3 #8356 会话作用域）
 * 验收锚：docs/development/acceptance.md「角色卡运行时 profile 临时覆盖（#180）」行
 *
 * 场景覆盖（全 8 钉）：
 *   ① command 全流程（join 切 model+thinking → settings 三键字段级不变 → leave 恢复基线）
 *   ② headless auto-join（stderr 载体的同链路；短 delay 不依赖快照窗口）
 *   ③ thinking-only ④ model-only ⑤ 手动修改（不持续纠正 + leave 回 capture 基线）
 *   ⑥ reload（保当前模型不重放 + reload 后 leave 仍回基线）
 *   ⑦ 运行时失败（裸串 model：warning + 不阻塞 + 模型不变）与钳制（thinking max → getter 生效值）
 *   ——「settings 三键不变」为跨场景不变量，断言嵌于 ① 内（join 前 / join 后 / leave 后三处快照比对）。
 *
 * 红测语义：队列（L2）已在位、生命周期接线（L3）未落盘——本文件在接线落盘前为红；
 * 全部断言按契约口径（异步 best-effort → 轮询 get_state 到目标值），接线后应全绿。
 *
 * 断言口径（契约 §12）：
 * - 轮询 get_state 到目标值（异步 best-effort，不假设即时生效）；
 * - settings 只断三键字段级不变（defaultProvider/defaultModel/defaultThinkingLevel）——
 *   不断文件级（同文件有启动期写入，如 lastChangelogVersion）；
 * - warning 通道 = extension_ui_request + method=notify（RPC 模式）；
 * - thinking 锚 getter 生效值（钳制场景断钳制后的实际值，非配置原值；目标值须 ≠ 基线才有 session 记录）。
 *
 * 夹具（#180 特殊要求，此前 acceptance 无模型面先例）：
 * - agentDir/models.json：fixture provider（api/baseUrl/apiKey 三必填），models alpha/beta/gamma
 *   均 reasoning=true（thinking 档位可生效；无 thinkingLevelMap → xhigh/max 不可用，max 钳制到 high）；
 *   baseUrl 指向废弃端口，切换只改 session 状态不触网；
 * - settings.json：retry.enabled=false——防 welcome run 打到死端口后默认重试 2s+4s+8s 拖尾；
 *   另钉 defaultProvider/defaultModel = fixture/beta——headless 场景的判别基线：否则 pi 初始模型
 *   回退首个可用模型（fixture/alpha）= 卡片值，join 是否切换不可辨（首跑实测空转绿）。
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PiProcess } from "./pi-process.js";
import { leaveAndReset, spawnCreator, startFreshGroup } from "./process-fixture.js";
import { createTempRoot } from "./temp-root.js";

const FIXTURE_MODELS = JSON.stringify({
	providers: {
		fixture: {
			api: "openai-completions",
			apiKey: "dummy",
			baseUrl: "http://127.0.0.1:1",
			models: [
				{ id: "alpha", reasoning: true },
				{ id: "beta", reasoning: true },
				{ id: "gamma", reasoning: true },
			],
		},
	},
});

const SETTINGS_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const;

/** 角色卡：name/description 唯一；model/thinking 可选（各场景注入）。 */
function card(name: string, model?: string, thinking?: string): string {
	const lines = [`---`, `name: ${name}`, `description: Model Hook`];
	if (model !== undefined) lines.push(`model: ${model}`);
	if (thinking !== undefined) lines.push(`thinking: ${thinking}`);
	lines.push("---", `${name} prompt`);
	return lines.join("\n");
}

const CARDS: Array<[file: string, content: string, label: string]> = [
	["command.md", card("Member Command", "fixture/alpha", "high"), "Member Command — Model Hook"],
	["bare.md", card("Member Bare", "my-model"), "Member Bare — Model Hook"],
	["think.md", card("Member Think", undefined, "high"), "Member Think — Model Hook"],
	["clamp.md", card("Member Clamp", undefined, "max"), "Member Clamp — Model Hook"],
	["model.md", card("Member Model", "fixture/alpha"), "Member Model — Model Hook"],
	["manual.md", card("Member Manual", "fixture/alpha"), "Member Manual — Model Hook"],
	["reload.md", card("Member Reload", "fixture/alpha"), "Member Reload — Model Hook"],
	["headless.md", card("Member Headless", "fixture/alpha"), "Member Headless — Model Hook"],
];

describe("acceptance: 角色模型生命周期（#180 L3 红钉）", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	let creator: PiProcess;
	const members: PiProcess[] = [];

	beforeAll(async () => {
		root = await createTempRoot("pi-tavern-acc-model-hook-");
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		await mkdir(join(agentDir, "characters"), { recursive: true });
		await mkdir(projectDir, { recursive: true });
		for (const [file, content] of CARDS) {
			await writeFile(join(agentDir, "characters", file), content);
		}
		await writeFile(
			join(agentDir, "tavern.json"),
			JSON.stringify({ characters: CARDS.map(([file]) => `characters/${file}`) }),
		);
		await writeFile(join(agentDir, "models.json"), FIXTURE_MODELS);
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ retry: { enabled: false }, defaultProvider: "fixture", defaultModel: "beta" }),
		);
		creator = spawnCreator({
			label: "creator",
			agentDir,
			sessionDir: join(agentDir, "sessions", "creator"),
			cwd: projectDir,
		});
		await creator.waitForTavernReady(60_000);
	}, 90_000);

	afterAll(async () => {
		for (const member of members) {
			if (!member.exited) {
				await member.kill("SIGTERM").catch(() => undefined);
			}
		}
		if (creator !== undefined && !creator.exited) {
			await creator.kill("SIGTERM").catch(() => undefined);
		}
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
	});

	// ── helpers ─────────────────────────────────────────────

	async function spawnMember(extraEnv?: Record<string, string>): Promise<PiProcess> {
		const member = PiProcess.spawn({
			label: `member-${members.length}`,
			agentDir,
			sessionDir: join(agentDir, "sessions", `member-${members.length}`),
			cwd: projectDir,
			...(extraEnv !== undefined ? { env: extraEnv } : {}),
		});
		members.push(member);
		await member.waitForTavernReady(60_000);
		await waitFixtureAvailable(member);
		return member;
	}

	/** 夹具就绪 guard（实测首个查询即命中；保留防启动顺序回归）。 */
	async function waitFixtureAvailable(member: PiProcess, timeoutMs = 20_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const id = await member.send({ type: "get_available_models" });
			const res = await member.waitFor(
				(e) => e.id === id && e.type === "response" && e.command === "get_available_models",
				15_000,
			);
			const models = ((res.data as { models?: Array<{ provider: string; id: string }> })?.models ?? []).map(
				(m) => `${m.provider}/${m.id}`,
			);
			if (models.includes("fixture/alpha")) return;
			if (Date.now() > deadline) throw new Error(`fixture models not available; got: ${models.join(",")}`);
			await sleep(250);
		}
	}

	async function getState(member: PiProcess): Promise<Record<string, unknown>> {
		const id = await member.send({ type: "get_state" });
		const res = await member.waitFor((e) => e.id === id && e.type === "response" && e.command === "get_state", 15_000);
		return (res.data as Record<string, unknown>) ?? {};
	}

	function modelRef(state: Record<string, unknown>): string | null {
		const model = state.model as { provider?: string; id?: string } | undefined;
		return model?.provider !== undefined && model.id !== undefined ? `${model.provider}/${model.id}` : null;
	}

	/** 轮询到目标模型（hook 异步 best-effort）。 */
	async function waitModel(member: PiProcess, expected: string, timeoutMs = 20_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const current = modelRef(await getState(member));
			if (current === expected) return;
			if (Date.now() > deadline) throw new Error(`model not settled: expected ${expected}, got ${String(current)}`);
			await sleep(250);
		}
	}

	async function waitThinking(member: PiProcess, expected: string, timeoutMs = 20_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const current = (await getState(member)).thinkingLevel;
			if (current === expected) return;
			if (Date.now() > deadline) throw new Error(`thinking not settled: expected ${expected}, got ${String(current)}`);
			await sleep(250);
		}
	}

	async function rpcSetModel(member: PiProcess, provider: string, modelId: string): Promise<void> {
		const id = await member.send({ type: "set_model", provider, modelId });
		const res = await member.waitFor((e) => e.id === id && e.type === "response" && e.command === "set_model", 15_000);
		if (res.success !== true) throw new Error(`set_model failed: ${String(res.error)}`);
	}

	async function rpcSetThinking(member: PiProcess, level: string): Promise<void> {
		const id = await member.send({ type: "set_thinking_level", level });
		await member.waitFor((e) => e.id === id && e.type === "response" && e.command === "set_thinking_level", 15_000);
	}

	/** 摸基线：模型 beta + thinking low（capture 语义的参照值）。 */
	async function setBaseline(member: PiProcess): Promise<void> {
		await rpcSetModel(member, "fixture", "beta");
		await rpcSetThinking(member, "low");
		await waitModel(member, "fixture/beta");
		await waitThinking(member, "low");
	}

	/** join + 等欢迎注入到达（Character 激活的确定性信号）。 */
	async function joinAs(member: PiProcess, label: string): Promise<void> {
		await member.joinGroupChat(projectDir, agentDir, label);
		await member.waitFor(
			(e) =>
				e.type === "extension_ui_request" &&
				e.method === "notify" &&
				typeof e.message === "string" &&
				e.message.includes("system_messages="),
			60_000,
		);
	}

	async function leaveMember(member: PiProcess): Promise<void> {
		await leaveAndReset(member, member.checkpoint(), 30_000);
	}

	async function readSettingsKeys(): Promise<Record<string, unknown>> {
		const raw = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		return Object.fromEntries(SETTINGS_KEYS.map((k) => [k, raw[k]]));
	}

	const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

	// ── 场景 ─────────────────────────────────────────────

	it("chain:L3 command 全流程——join 切 model+thinking → settings 三键不变 → leave 恢复基线", async () => {
		const member = await spawnMember();
		await setBaseline(member);
		const settingsBefore = await readSettingsKeys();
		const { checkpoint } = await startFreshGroup(creator, projectDir, agentDir);
		try {
			await joinAs(member, "Member Command — Model Hook");
			// join：卡 profile 生效（model → thinking 顺序）
			await waitModel(member, "fixture/alpha");
			await waitThinking(member, "high");
			// 正向锚闭环：切换确实发生（证明 hook 跑了）+ settings 三键未被写（#8356 会话作用域）
			expect(await readSettingsKeys()).toEqual(settingsBefore);

			await leaveMember(member);
			await waitModel(member, "fixture/beta");
			await waitThinking(member, "low");
			expect(await readSettingsKeys()).toEqual(settingsBefore);
		} finally {
			await leaveAndReset(creator, checkpoint, 15_000).catch(() => undefined);
		}
	}, 120_000);

	it("chain:L3 运行时失败——裸串 model join 仍成功 + warning 可见 + model 不变", async () => {
		const member = await spawnMember();
		await setBaseline(member);
		const { checkpoint } = await startFreshGroup(creator, projectDir, agentDir);
		try {
			const warning = member.waitFor(
				(e) =>
					e.type === "extension_ui_request" &&
					e.method === "notify" &&
					typeof e.message === "string" &&
					e.message.includes("my-model"),
				45_000,
			);
			await joinAs(member, "Member Bare — Model Hook");
			// 失败形态：warning（含目标原值）+ 加入未受阻（joinAs 已等到欢迎注入 = Character 激活）
			await warning;
			await waitModel(member, "fixture/beta");
			await leaveMember(member);
			await waitModel(member, "fixture/beta");
		} finally {
			await leaveAndReset(creator, checkpoint, 15_000).catch(() => undefined);
		}
	}, 120_000);

	it("chain:L3 钳制——thinking max 超能力 → getter 生效值为钳制后实际值（high）", async () => {
		const member = await spawnMember();
		await setBaseline(member);
		const { checkpoint } = await startFreshGroup(creator, projectDir, agentDir);
		try {
			await joinAs(member, "Member Clamp — Model Hook");
			// 夹具模型无 thinkingLevelMap：xhigh/max 不可用 → pi 钳制为 high（clamp 视为正常处理，无失败提示）
			await waitThinking(member, "high");
			// 断言 getter 生效值（非配置原值 max）；model 维未配置 → 恒不动
			expect((await getState(member)).thinkingLevel).toBe("high");
			expect(modelRef(await getState(member))).toBe("fixture/beta");
			await leaveMember(member);
			await waitThinking(member, "low");
		} finally {
			await leaveAndReset(creator, checkpoint, 15_000).catch(() => undefined);
		}
	}, 120_000);

	it("chain:L3 thinking-only——join 只改 thinking；leave 恢复 thinking 基线（model 恒不动）", async () => {
		const member = await spawnMember();
		await setBaseline(member);
		const { checkpoint } = await startFreshGroup(creator, projectDir, agentDir);
		try {
			await joinAs(member, "Member Think — Model Hook");
			await waitThinking(member, "high");
			expect(modelRef(await getState(member))).toBe("fixture/beta");
			await leaveMember(member);
			await waitThinking(member, "low");
			expect(modelRef(await getState(member))).toBe("fixture/beta");
		} finally {
			await leaveAndReset(creator, checkpoint, 15_000).catch(() => undefined);
		}
	}, 120_000);

	it("chain:L3 model-only——join 切 model；leave 恢复 model 基线", async () => {
		const member = await spawnMember();
		await setBaseline(member);
		const { checkpoint } = await startFreshGroup(creator, projectDir, agentDir);
		try {
			await joinAs(member, "Member Model — Model Hook");
			await waitModel(member, "fixture/alpha");
			await leaveMember(member);
			await waitModel(member, "fixture/beta");
		} finally {
			await leaveAndReset(creator, checkpoint, 15_000).catch(() => undefined);
		}
	}, 120_000);

	it("chain:L3 手动修改——中途手改不被持续纠正；leave 恢复 capture 基线", async () => {
		const member = await spawnMember();
		await setBaseline(member);
		const { checkpoint } = await startFreshGroup(creator, projectDir, agentDir);
		try {
			await joinAs(member, "Member Manual — Model Hook");
			await waitModel(member, "fixture/alpha");
			// 手动换模型：不被持续纠正（宽限窗口内保持不变）
			await rpcSetModel(member, "fixture", "gamma");
			await waitModel(member, "fixture/gamma");
			await sleep(1_500);
			expect(modelRef(await getState(member))).toBe("fixture/gamma");
			// 正常离开：恢复 capture 时的基线（beta），而非手改值
			await leaveMember(member);
			await waitModel(member, "fixture/beta");
		} finally {
			await leaveAndReset(creator, checkpoint, 15_000).catch(() => undefined);
		}
	}, 120_000);

	it("chain:L3 reload——reload 保持当前模型；reload 后 leave 仍恢复基线", async () => {
		const member = await spawnMember();
		await setBaseline(member);
		const { checkpoint } = await startFreshGroup(creator, projectDir, agentDir);
		try {
			await joinAs(member, "Member Reload — Model Hook");
			await waitModel(member, "fixture/alpha");
			await member.runCommand("/tavern-test-reload");
			// reload 异步：轮询 whoami 直到 post-reload 的 Character 状态可见
			const deadline = Date.now() + 60_000;
			let reloaded = false;
			while (Date.now() < deadline) {
				await member.runCommand("/tavern-test-whoami");
				try {
					await member.waitFor(
						(e) =>
							e.type === "extension_ui_request" &&
							e.method === "notify" &&
							typeof e.message === "string" &&
							e.message.includes("[tavern-test-whoami] name=Member Reload"),
						2_000,
					);
					reloaded = true;
					break;
				} catch {
					// reload 未完成，重试
				}
			}
			expect(reloaded).toBe(true);
			// reload 保持当前模型（不重放 switch、不回退）
			await waitModel(member, "fixture/alpha");
			await leaveMember(member);
			await waitModel(member, "fixture/beta");
		} finally {
			await leaveAndReset(creator, checkpoint, 15_000).catch(() => undefined);
		}
	}, 180_000);

	it("chain:L3 headless——auto-join 路径同样切换（短 delay 不依赖快照窗口）", async () => {
		const { descriptor, checkpoint } = await startFreshGroup(creator, projectDir, agentDir);
		try {
			const member = await spawnMember({
				PITAVERN_AUTO_JOIN: "1",
				PITAVERN_CHARACTER: "Member Headless",
				PITAVERN_GROUP_CHAT: descriptor.groupChatId,
				// 短 delay：窗口结构性不存在（auto-join timer 注册于扩展工厂内，
				// 晚于 ModelRuntime.create 的 await refresh；QA seq58/Arch seq59 实证）。
				PITAVERN_AUTO_JOIN_DELAY_MS: "100",
			});
			await member.waitForStderr("Auto-joined", 60_000);
			await waitModel(member, "fixture/alpha");
		} finally {
			await leaveAndReset(creator, checkpoint, 15_000).catch(() => undefined);
		}
	}, 120_000);
});
