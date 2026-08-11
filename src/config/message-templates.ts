import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
	WARNING_MESSAGE_TEMPLATE_FILE_PREFIX,
	WARNING_MESSAGE_TEMPLATE_KEY_PREFIX,
	WARNING_MESSAGE_TEMPLATE_LAYER_PREFIX,
} from "../shared/messages.js";

/**
 * ：可配置群聊消息文案——共享纯函数模块（config 域）。
 *
 * 契约（docs/development/acceptance.md T1-T4）：
 * - 五类 key：public_message / whisper_full / whisper_placeholder / seconds_ago / minutes_ago。
 * - 占位符规则：必留占位缺失、禁止占位出现（whisper_placeholder 禁 content）、
 *   未知占位出现 → 单项无效，逐项回退低层并 warning，不阻断群聊启动。
 * - 合并优先级：项目配置 > 全局配置 > 内置中文（逐 key）。
 * - 渲染期不二次校验（校验在合并期完成）。
 * - whisper 两 key 随 （Character 间私信）重新引入（WH9；
 *   「未实现功能不暴露文案」暂移除，本模块契约注释保留了定稿规则表）。
 */

export const MESSAGE_TEMPLATE_KEYS = [
	"public_message",
	"whisper_full",
	"whisper_placeholder",
	"seconds_ago",
	"minutes_ago",
] as const;

export type MessageTemplateKey = (typeof MESSAGE_TEMPLATE_KEYS)[number];

/**
 * ：内置中文默认值（合并链最底档）。
 * public_message 含换行：实时注入面
 * `sender（when）:\ncontent` 与现状逐字一致（双测试锚绿）；history/TUI
 * 面双行化可接受（无格式钉死，留痕 T3）。
 */
export const DEFAULT_TEMPLATES: Record<MessageTemplateKey, string> = {
	public_message: "{sender}:\n{content}",
	//  WH9：私信投影文案（需求基线原文：「A 向 B 悄悄说：正文」/「A 向 B 悄悄说了一句话」）。
	whisper_full: "{sender} 向 {receiver} 悄悄说：{content}",
	whisper_placeholder: "{sender} 向 {receiver} 悄悄说了一句话",
	seconds_ago: "{count} 秒前",
	minutes_ago: "{count} 分钟前",
};

interface TemplateRule {
	/** 必留占位符（缺失判无效）。 */
	required: string[];
	/** 合法占位符全集（未知与禁止均不在集合内，出现判无效）。 */
	allowed: string[];
}

const TEMPLATE_RULES: Record<MessageTemplateKey, TemplateRule> = {
	public_message: { required: ["sender", "content"], allowed: ["sender", "content"] },
	//  WH9：定稿规则表（契约注释留痕）——full 必留三占位；placeholder 禁 content。
	whisper_full: { required: ["sender", "receiver", "content"], allowed: ["sender", "receiver", "content"] },
	whisper_placeholder: { required: ["sender", "receiver"], allowed: ["sender", "receiver"] },
	seconds_ago: { required: ["count"], allowed: ["count"] },
	minutes_ago: { required: ["count"], allowed: ["count"] },
};

const PLACEHOLDER_PATTERN = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

export type TemplateValidation = { ok: true } | { ok: false; reason: string };

/**
 *  T4：单项校验——必留缺失 / 禁止与未知占位出现 / 空串均判无效。
 * 渲染期不做二次校验（合并期已过滤，契约定稿）。
 */
export function validateTemplate(key: MessageTemplateKey, template: string): TemplateValidation {
	const rule = TEMPLATE_RULES[key];
	if (rule === undefined) {
		return { ok: false, reason: `unknown template key: ${key}` };
	}
	if (template.trim() === "") {
		return { ok: false, reason: "template is empty" };
	}
	const placeholders = [...template.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1] ?? "");
	const unknown = placeholders.find((name) => !rule.allowed.includes(name));
	if (unknown !== undefined) {
		return { ok: false, reason: `placeholder {${unknown}} is not allowed for ${key}` };
	}
	const missing = rule.required.find((name) => !placeholders.includes(name));
	if (missing !== undefined) {
		return { ok: false, reason: `required placeholder {${missing}} is missing for ${key}` };
	}
	return { ok: true };
}

/**
 * ：模板渲染——仅替换 {placeholder}；缺失值替换为空串；
 * 值不做递归展开。校验在合并期完成，渲染期零校验（契约定稿）。
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
	return template.replace(PLACEHOLDER_PATTERN, (_match, name: string) => vars[name] ?? "");
}

/**
 *  T1：三层逐 key 合并（项目 > 全局 > 内置）。
 * 层内未知 key / 无效单项 → 该 key 回退低层并记 warning；层为 null/空 = 无贡献。
 * 纯函数（fs 分离在 loadMessageTemplateFile），可独立测试。
 */
export function mergeMessageTemplates(
	projectTemplates: Record<string, string> | null | undefined,
	globalTemplates: Record<string, string> | null | undefined,
): { templates: Record<MessageTemplateKey, string>; warnings: string[] } {
	const warnings: string[] = [];
	const result: Record<MessageTemplateKey, string> = { ...DEFAULT_TEMPLATES };

	const applyLayer = (layer: Record<string, string> | null | undefined, label: string): void => {
		if (layer === null || layer === undefined) {
			return;
		}
		for (const [key, value] of Object.entries(layer)) {
			if (!MESSAGE_TEMPLATE_KEYS.includes(key as MessageTemplateKey)) {
				warnings.push(`${WARNING_MESSAGE_TEMPLATE_KEY_PREFIX}${key} is not a known message template key (${label})`);
				continue;
			}
			const templateKey = key as MessageTemplateKey;
			const validation = validateTemplate(templateKey, value);
			if (!validation.ok) {
				warnings.push(
					`${WARNING_MESSAGE_TEMPLATE_LAYER_PREFIX}${label} ${templateKey}: ${validation.reason}; falling back`,
				);
				continue;
			}
			result[templateKey] = value;
		}
	};

	applyLayer(globalTemplates, "global");
	applyLayer(projectTemplates, "project");
	return { templates: result, warnings };
}

/**
 *  T2：读取模板文件（路径相对声明它的配置文件目录解析）。
 * 未声明 → null 无 warning；文件缺失 / 解析失败 / 顶层非对象 → warning + null
 * （该层整体回退）；顶层对象内非 string 值 → 该 key 丢弃 + warning（逐项回退精神）。
 */
export async function loadMessageTemplateFile(
	configDir: string | undefined,
	declaredPath: string | undefined,
): Promise<{ templates: Record<string, string> | null; warnings: string[] }> {
	if (declaredPath === undefined) {
		return { templates: null, warnings: [] };
	}
	const resolvedPath = isAbsolute(declaredPath) ? declaredPath : resolve(configDir ?? process.cwd(), declaredPath);

	let contents: string;
	try {
		contents = await readFile(resolvedPath, "utf8");
	} catch {
		return {
			templates: null,
			warnings: [`${WARNING_MESSAGE_TEMPLATE_FILE_PREFIX}${resolvedPath} is unreadable; falling back`],
		};
	}

	let value: unknown;
	try {
		value = JSON.parse(contents);
	} catch {
		return {
			templates: null,
			warnings: [`${WARNING_MESSAGE_TEMPLATE_FILE_PREFIX}${resolvedPath} is not valid JSON; falling back`],
		};
	}

	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {
			templates: null,
			warnings: [
				`${WARNING_MESSAGE_TEMPLATE_FILE_PREFIX}${resolvedPath} top-level value must be an object; falling back`,
			],
		};
	}

	const warnings: string[] = [];
	const templates: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") {
			warnings.push(`${WARNING_MESSAGE_TEMPLATE_KEY_PREFIX}${key} is not a string; ignored`);
			continue;
		}
		templates[key] = entry;
	}
	return { templates, warnings };
}
