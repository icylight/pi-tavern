import { type ChildProcess, spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ActiveGroupChatDescriptor } from "../../src/data/discovery/active-descriptor.js";
import {
	getActiveDescriptorPath,
	getGroupChatProjectDirectory,
	readActiveDescriptor,
} from "../../src/data/discovery/active-descriptor.js";

/** Time each step may wait for a real pi process to respond. */
const STEP_TIMEOUT_MS = 30_000;

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
// #83 版本缺口补跑：默认门禁锚定 references/pi（0.82.1 子模块）；PI_TEST_SH 环境
// 覆盖用于一次性 0.83.0 验证（tmp/pi-test-083.sh，不入库）。注意 spawn cwd 是临时
// 目录，覆盖值必须解析为绝对路径。默认路径零变化。
const PI_TEST_SH = process.env.PI_TEST_SH
	? resolve(process.env.PI_TEST_SH)
	: resolve(REPO_ROOT, "references", "pi", "pi-test.sh");

export interface SpawnPiOptions {
	label: string;
	agentDir: string;
	sessionDir: string;
	cwd: string;
	/** Extra pi CLI flags (e.g. --no-tools). */
	extraArgs?: string[];
	/** Extra environment variables for the child process. */
	env?: Record<string, string>;
}

export interface RpcEvent {
	type: string;
	[key: string]: unknown;
}

/**
 * 事件流检查点（测试架构改造 v2，Arch 评审 2026-08-02）：共享 fixture 下场景间
 * 事件必然串扰（pi-process 保留全量事件、waitFor 全历史重放）——场景隔离单元
 * 升级为 checkpoint 游标。checkpoint() 快照当前事件流位置，waitForAfter 只匹配
 * 检查点之后的事件（含检查点后新到达的，先查重放、后查新到）。
 */
export interface EventCheckpoint {
	/** 检查点处已收事件数（events.length 快照）。 */
	index: number;
}

/**
 * A real pi process driven over `--mode rpc`: JSON commands on stdin, JSON
 * events (including extension_ui_request dialogs) on stdout.
 */
export class PiProcess {
	readonly child: ChildProcess;
	readonly label: string;
	private readonly events: RpcEvent[] = [];
	private readonly stderrChunks: string[] = [];
	private readonly waiters: Array<(event: RpcEvent, index: number) => void> = [];
	private buffered = "";
	private commandId = 0;

	private constructor(label: string, child: ChildProcess) {
		this.label = label;
		this.child = child;
	}

	/**
	 * Spawn a real pi (via references/pi/pi-test.sh) loading the workspace extension.
	 *
	 * #52（QA，2026-08-02）：白名单 env 替代 {...process.env, ...} 展开 + 去 --no-env——
	 * ① 堵开发机真 key/模型配置泄漏进测试进程（Dev 归因：PI_PROVIDER/PI_MODEL/
	 * DEEPSEEK_API_KEY 曾泄漏 → 每次 run 真实调用 LLM；白名单确定性零 LLM）；
	 * ② 白名单不含任何 key 变量（缺席形态，PM 定案；配对实测 ms 级）；
	 * ③ options.env 闸门（PM 安全审查补强）：仅允许 PITAVERN_*、HOME 与基础名，
	 * 其余一律丢弃——堵死未来测试传真实 key 的通道（现有测试仅用 PITAVERN_*、HOME）。
	 */
	static spawn(options: SpawnPiOptions): PiProcess {
		const gatedEnv = gateTestEnv(options.env);
		const child = spawn(
			"bash",
			[
				PI_TEST_SH,
				"--mode",
				"rpc",
				"-e",
				resolve(REPO_ROOT, "src", "index.ts"),
				"--session-dir",
				options.sessionDir,
				...(options.extraArgs ?? []),
			],
			{
				env: {
					// 白名单：仅透传基础环境 + 闸门过滤后的测试显式 env。
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					LANG: process.env.LANG,
					LC_ALL: process.env.LC_ALL,
					TMPDIR: process.env.TMPDIR,
					PITAVERN_TEST: process.env.PITAVERN_TEST, // 测试命令注册开关（tavern-test-* 仅在 PITAVERN_TEST=1 时注册）
					...(gatedEnv ?? {}),
					PI_CODING_AGENT_DIR: options.agentDir,
					TERM: "dumb",
				},
				stdio: ["pipe", "pipe", "pipe"],
				cwd: options.cwd,
			},
		);
		const process_ = new PiProcess(options.label, child);
		child.stdout?.on("data", (chunk) => process_.onStdout(chunk));
		child.stderr?.on("data", (chunk) => process_.onStderr(chunk));
		return process_;
	}

	/** Wait until the PiTavern extension is active (its TUI status was rendered). */
	async waitForTavernReady(timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
		await this.waitFor(
			(event) =>
				event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-tavern",
			timeoutMs,
		);
	}

	/** Snapshot of the event stream position (see EventCheckpoint). */
	checkpoint(): EventCheckpoint {
		return { index: this.events.length };
	}

	/** Wait for the next event matching a predicate; past events are replayed first. */
	waitFor(predicate: (event: RpcEvent) => boolean, timeoutMs = STEP_TIMEOUT_MS): Promise<RpcEvent> {
		return new Promise((resolveEvent, rejectEvent) => {
			// 旧语义：全历史重放（含调用前已到达的匹配事件）——waitForTavernReady
			// 等重入调用依赖此语义（ready 事件早已到达，仍须命中）。
			const existing = this.events.find(predicate);
			if (existing) {
				resolveEvent(existing);
				return;
			}
			const timer = setTimeout(
				() => rejectEvent(new Error(`[${this.label}] timeout waiting for event after ${timeoutMs}ms`)),
				timeoutMs,
			);
			const waiter = (event: RpcEvent): void => {
				if (!predicate(event)) {
					return;
				}
				clearTimeout(timer);
				const waiterIndex = this.waiters.indexOf(waiter);
				if (waiterIndex !== -1) {
					this.waiters.splice(waiterIndex, 1);
				}
				resolveEvent(event);
			};
			this.waiters.push(waiter);
		});
	}

	/**
	 * waitFor 的 checkpoint 变体：只匹配 checkpoint 之后的事件（重放从
	 * checkpoint.index 起查，新到事件按序号过滤）——共享 fixture 场景隔离用；
	 * 旧 waitFor 语义（全历史重放）由 checkpoint()=0 等价保持。
	 */
	waitForAfter(
		checkpoint: EventCheckpoint,
		predicate: (event: RpcEvent) => boolean,
		timeoutMs = STEP_TIMEOUT_MS,
	): Promise<RpcEvent> {
		return new Promise((resolveEvent, rejectEvent) => {
			const existing = this.events.slice(checkpoint.index).find(predicate);
			if (existing) {
				resolveEvent(existing);
				return;
			}
			const timer = setTimeout(
				() => rejectEvent(new Error(`[${this.label}] timeout waiting for event after ${timeoutMs}ms`)),
				timeoutMs,
			);
			const waiter = (event: RpcEvent, index: number): void => {
				// checkpoint.index 之后到达的事件从 index == checkpoint.index 起算；
				// < 的才是检查点前的旧事件（off-by-one 修正 2026-08-02）。
				if (index < checkpoint.index || !predicate(event)) {
					return;
				}
				clearTimeout(timer);
				const waiterIndex = this.waiters.indexOf(waiter);
				if (waiterIndex !== -1) {
					this.waiters.splice(waiterIndex, 1);
				}
				resolveEvent(event);
			};
			this.waiters.push(waiter);
		});
	}

	/** Send a pi slash command through the prompt channel. */
	async runCommand(command: string): Promise<void> {
		await this.send({ type: "prompt", message: command });
	}

	/** Send a raw RPC command; returns its id. */
	send(message: Record<string, unknown>): Promise<string> {
		return new Promise((resolveId, rejectId) => {
			if (!this.child.stdin?.writable) {
				rejectId(new Error(`[${this.label}] stdin is not writable`));
				return;
			}
			this.commandId += 1;
			const id = String(this.commandId);
			this.child.stdin.write(`${JSON.stringify({ id, ...message })}\n`, (error) => {
				if (error) rejectId(error);
				else resolveId(id);
			});
		});
	}

	/** Answer an extension_ui_request dialog. */
	respond(id: string, response: Record<string, unknown>): void {
		this.child.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id, ...response })}\n`);
	}

	/** Terminate the process and wait for it to exit. */
	async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) {
			return;
		}
		this.child.kill(signal);
		await new Promise<void>((resolveExit) => {
			const timer = setTimeout(() => {
				this.child.kill("SIGKILL");
				resolveExit();
			}, 5000);
			this.child.once("exit", () => {
				clearTimeout(timer);
				resolveExit();
			});
		});
	}

	/** True when the process has already exited. */
	get exited(): boolean {
		return this.child.exitCode !== null || this.child.signalCode !== null;
	}

	/**
	 * Run /tavern-new and wait until the active descriptor is published.
	 * Returns the descriptor.
	 */
	async startGroupChat(cwd: string, agentDir: string): Promise<ActiveGroupChatDescriptor> {
		await this.waitForTavernReady();
		await this.runCommand("/tavern-new");
		return waitForDescriptor(agentDir, cwd);
	}

	/**
	 * Run /tavern-join and complete the join flow, answering select dialogs
	 * automatically (single candidates are auto-selected by the extension).
	 * Returns the descriptor of the joined group chat.
	 */
	async joinGroupChat(cwd: string, agentDir: string, characterLabel?: string): Promise<ActiveGroupChatDescriptor> {
		await this.waitForTavernReady();
		await this.runCommand("/tavern-join");
		const descriptor = await waitForDescriptor(agentDir, cwd);
		const firstSelect = await this.waitFor((e) => e.type === "extension_ui_request" && e.method === "select");
		if (firstSelect.title === "Choose a group chat") {
			// The select returns the option label, not the group chat id; when
			// several group chats exist, match the label that contains the
			// descriptor's id (label format: "<name> (<groupChatId>)").
			const options = (firstSelect.options as unknown as string[]) ?? [];
			const chosen = options.find((o) => o.includes(descriptor.groupChatId)) ?? options[0];
			this.respond(String(firstSelect.id), { value: chosen });
		}
		const characterSelect = await this.waitFor(
			(e) => e.type === "extension_ui_request" && e.method === "select" && e.title === "Choose a Character",
		);
		const options = (characterSelect.options as unknown as string[]) ?? [];
		const chosen = characterLabel ?? options[0];
		if (chosen === undefined) {
			throw new Error(`[${this.label}] no character options available`);
		}
		this.respond(String(characterSelect.id), { value: chosen });
		return descriptor;
	}

	private onStdout(chunk: Buffer): void {
		this.buffered += chunk.toString();
		for (;;) {
			const nl = this.buffered.indexOf("\n");
			if (nl === -1) {
				break;
			}
			const line = this.buffered.slice(0, nl);
			this.buffered = this.buffered.slice(nl + 1);
			if (!line.trim()) {
				continue;
			}
			let event: RpcEvent;
			try {
				event = JSON.parse(line) as RpcEvent;
			} catch {
				// Non-JSON boot chatter (e.g. "Running without API keys...").
				continue;
			}
			this.events.push(event);
			for (const waiter of [...this.waiters]) {
				waiter(event, this.events.length - 1);
			}
		}
	}

	/** Number of parsed stdout events (diagnostics). */
	countEvents(): number {
		return this.events.length;
	}

	/** Parsed stdout events (diagnostics). */
	dumpEvents(): RpcEvent[] {
		return [...this.events];
	}

	/** Accumulated stderr text (diagnostics + headless auto-join notices). */
	getStderr(): string {
		return this.stderrChunks.join("");
	}

	/** Wait until stderr contains the given substring (polling, best effort). */
	async waitForStderr(substring: string, timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (this.getStderr().includes(substring)) {
				return;
			}
			if (Date.now() > deadline) {
				throw new Error(
					`[${this.label}] timeout waiting for stderr text: ${substring}; got: ${this.getStderr().slice(-800)}`,
				);
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 200));
		}
	}

	/** CPU share over a sampling window (utime+stime delta / wall clock). */
	async sampleCpuPercent(sampleMs = 3_000): Promise<number> {
		const pid = this.child.pid;
		if (pid === undefined) {
			throw new Error("process has no pid");
		}
		const readTicks = async (): Promise<number> => {
			try {
				const stat = await readFile(`/proc/${pid}/stat`, "utf8");
				// utime (14) + stime (15), in clock ticks (usually 100/s).
				const fields = stat.split(" ");
				return Number(fields[13]) + Number(fields[14]);
			} catch {
				return -1;
			}
		};
		const before = await readTicks();
		await new Promise((resolveWait) => setTimeout(resolveWait, sampleMs));
		const after = await readTicks();
		if (before < 0 || after < 0) {
			throw new Error(`cannot read /proc/${pid}/stat`);
		}
		const hertz = 100; // CLK_TCK on Linux
		return (after - before) / (sampleMs / 1000) / hertz;
	}

	private onStderr(chunk: Buffer): void {
		this.stderrChunks.push(chunk.toString());
		// Keep stderr available for diagnostics; acceptance failures print it.
		process.stderr.write(`[${this.label}] ${chunk.toString()}`);
	}
}

/**
 * options.env 闸门（PM 安全审查补强，2026-08-02）：仅放行 PITAVERN_*、
 * HOME 与基础环境名，其余键一律丢弃——堵死测试显式传真实凭据的通道。
 */
function gateTestEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
	if (env === undefined) {
		return undefined;
	}
	const allowed = (key: string): boolean =>
		key.startsWith("PITAVERN_") ||
		key === "HOME" ||
		key === "PATH" ||
		key === "TERM" ||
		key === "LANG" ||
		key === "LC_ALL" ||
		key === "TMPDIR";
	const gated = Object.fromEntries(Object.entries(env).filter(([key]) => allowed(key)));
	return Object.keys(gated).length > 0 ? gated : undefined;
}

/** Poll until the active descriptor for a project appears on disk. */
export async function waitForDescriptor(
	agentDir: string,
	cwd: string,
	timeoutMs = STEP_TIMEOUT_MS,
): Promise<ActiveGroupChatDescriptor> {
	const activeDir = resolve(getGroupChatProjectDirectory(agentDir, cwd), "active");
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const files = await readdir(activeDir).catch(() => []);
		if (files.length > 0) {
			const descriptor = await readActiveDescriptor(resolve(activeDir, files[0] ?? ""));
			if (descriptor) {
				return descriptor;
			}
		}
		if (Date.now() > deadline) {
			throw new Error(`no active descriptor appeared under ${activeDir}`);
		}
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
	}
}

export { getActiveDescriptorPath };
