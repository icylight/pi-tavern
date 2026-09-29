/**
 * 创建临时根目录（macOS 路径规范化，#189）。
 *
 * macOS 上 `tmpdir()` 返回 `/var/...`（符号链接），而 pi 进程内
 * `process.cwd()` 会被规范化为 `/private/var/...`——两侧 `getProjectKey`
 * 计算结果不一致 → 描述符/游标/白板路径永远对不上、等待超时。
 * 在创建点 realpath 后，所有派生路径（agentDir / projectDir / 各目录查询）
 * 与子进程 `process.cwd()` 同源。Linux 上 realpath 为 no-op。
 */
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `mkdtemp(tmpdir()/prefix)` + realpath 规范化，返回物理路径。 */
export async function createTempRoot(prefix: string): Promise<string> {
	return realpath(await mkdtemp(join(tmpdir(), prefix)));
}
