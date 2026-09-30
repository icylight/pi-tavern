/**
 * #215：从群聊注入 content 的「新消息」段解析结构化消息元素。
 *
 * 只依赖冻结契约「可解析的 JSON 消息元素数组」：定位 `新消息：` 分区后，
 * 从首个 `[` 起做字符串/反斜杠转义感知的顶层扫描，取到匹配 `]` 为止再
 * `JSON.parse`。不依赖缩进排版、不依赖后继分区（`当前状态`/操作指引均可能缺省）。
 */
export interface MessageElement {
	jsonrpc: string;
	method: string;
	params: Record<string, unknown>;
}

export function parseMessageElements(content: string): MessageElement[] {
	const start = content.indexOf("新消息：\n");
	if (start < 0) throw new Error("content 缺少新消息分区");
	const rest = content.slice(start + "新消息：\n".length).trimStart();
	if (!rest.startsWith("[")) throw new Error("新消息分区不是 JSON 数组");
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < rest.length; i += 1) {
		const char = rest[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "[") depth += 1;
		else if (char === "]" && --depth === 0) {
			const value: unknown = JSON.parse(rest.slice(0, i + 1));
			if (!Array.isArray(value)) throw new Error("新消息分区不是 JSON 数组");
			return value as MessageElement[];
		}
	}
	throw new Error("新消息分区缺少完整的数组边界");
}
