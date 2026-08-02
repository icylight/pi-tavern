import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 游标观测解耦（Arch 2026-08-02：测试不拼实现路径——PR #71 后写路径 =
 * cursors/<groupId>/<sessionId>.json，sessionId 由进程生成、测试不可预知；
 * 旧平铺路径仅历史遗留。统一经本 helper 读目录内全部游标文件取最大
 * last_sequence（会话无关）。
 */
export async function readAnySessionCursor(cursorDir: string, groupChatId: string): Promise<number> {
	try {
		const files = await readdir(join(cursorDir, groupChatId));
		let max = 0;
		for (const file of files) {
			if (!file.endsWith(".json")) {
				continue;
			}
			try {
				const raw = await readFile(join(cursorDir, groupChatId, file), "utf8");
				max = Math.max(max, (JSON.parse(raw) as { last_sequence: number }).last_sequence);
			} catch {
				// 个别文件损坏/半写：跳过。
			}
		}
		return max;
	} catch {
		return 0; // 目录尚未创建。
	}
}

/**
 * 密轮询等待游标到达 target（25ms 间隔 + 失败早退，Arch ③：事件驱动不可行处
 * 用密轮询替代粗轮询，不砍 #43 上界裕量——上界只作防 flake 的兜底）。
 */
export async function pollSessionCursor(
	cursorDir: string,
	groupChatId: string,
	target: number,
	deadlineMs: number,
	label: string,
): Promise<number> {
	const deadline = Date.now() + deadlineMs;
	let lastSequence = 0;
	for (;;) {
		lastSequence = await readAnySessionCursor(cursorDir, groupChatId);
		if (lastSequence >= target) {
			return lastSequence;
		}
		if (Date.now() > deadline) {
			throw new Error(`${label} did not reach seq ${target} (last: ${lastSequence})`);
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	}
}
