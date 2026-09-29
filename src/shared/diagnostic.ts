/**
 * #202 诊断面统一出口（默认关、生产零影响）。
 *
 * 开关：`PITAVERN_DIAG=1`（每次调用读 env——测试可在用例内开关；未设时只做
 * 一次属性比较并 return，不构造字段对象、不写 sink）。sink 由组合根绑定
 * （同 `setTestNotify` 口径：index.ts 绑 `ctx.ui.notify`）；未绑时回落
 * stderr（stderr 不入 RPC JSONL 协议流）。
 *
 * 行格式：`[tavern-diag] <tag> k=v …`（值做单行化与长度截断，避免多行污染）。
 * 钉位与判别矩阵见 `docs/development/diagnostics.md`。
 */

/** 诊断行前缀（与 #196 注入面的 `[tavern-inject]` 并列，互不干扰）。 */
export const DIAG_PREFIX = "[tavern-diag]";

const DIAG_ENV_VAR = "PITAVERN_DIAG";
/** 单值渲染长度上限（帧体不落诊断面——只落判据字段）。 */
const MAX_VALUE_CHARS = 120;

let sink: ((line: string) => void) | undefined;

/** 组合根（或测试）绑定诊断输出通道；传 undefined 解绑（回落 stderr）。 */
export function setDiagnosticSink(next: ((line: string) => void) | undefined): void {
	sink = next;
}

/** 开关状态（每调用读取，供热路径先行判断以避免构造字段对象）。 */
export function diagEnabled(): boolean {
	return process.env[DIAG_ENV_VAR] === "1";
}

export function diag(tag: string, fields: Record<string, unknown>): void {
	if (!diagEnabled()) {
		return;
	}
	const parts: string[] = [];
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		parts.push(`${key}=${renderValue(value)}`);
	}
	const line = `${DIAG_PREFIX} ${tag}${parts.length > 0 ? ` ${parts.join(" ")}` : ""}`;
	if (sink !== undefined) {
		sink(line);
		return;
	}
	process.stderr.write(`${line}\n`);
}

function renderValue(value: unknown): string {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	const text = typeof value === "string" ? value : JSON.stringify(value);
	const single = (text ?? String(value)).replace(/\s+/g, " ");
	return single.length > MAX_VALUE_CHARS ? `${single.slice(0, MAX_VALUE_CHARS)}…` : single;
}
