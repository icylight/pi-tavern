import type { Box } from "@earendil-works/pi-tui";

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_TEMPLATES, type MessageTemplateKey } from "../../../src/config/message-templates.js";
import { registerRenderers } from "../../../src/ui/renderers.js";

/**
 * #154 T3 红测：创建者 TUI 消费同一模板集（与实时注入/tavern_history 同源）。
 * 自定义 public_message 模板 → TUI 输出同变；默认模板 → 内置中文直出。
 */

interface CapturedRenderer {
	customType: string;
	renderer: (entry: unknown, options: unknown, theme: unknown) => Box;
}

function captureRenderers(getTemplates: () => Record<MessageTemplateKey, string>): CapturedRenderer[] {
	const renderers: CapturedRenderer[] = [];
	const pi = {
		registerEntryRenderer(customType: string, renderer: CapturedRenderer["renderer"]) {
			renderers.push({ customType, renderer });
		},
		registerMessageRenderer: vi.fn(),
	} as never;
	registerRenderers(pi as never, getTemplates);
	return renderers;
}

function themeMock() {
	return {
		bg: (_key: string, text: string) => text,
		fg: (_key: string, text: string) => text,
	};
}

describe("T3 (#154) creator-display 模板渲染", () => {
	it("默认模板：public_message 直出 `{sender}:\\n{content}`（双行化，Arch 裁决留痕）", () => {
		const renderers = captureRenderers(() => DEFAULT_TEMPLATES);
		const display = renderers.find((r) => r.customType === "pi-tavern.creator-display");
		if (!display) throw new Error("no creator-display renderer");

		const box = display.renderer(
			{
				data: {
					kind: "public_message",
					group_chat_id: "group-1",
					event: { sender: { type: "user_persona" }, content: "hello world" },
				},
			},
			{},
			themeMock(),
		);
		expect(box.children).toHaveLength(1);
		const text = box.children[0];
		if (!text || typeof text.render !== "function") throw new Error("expected Text child");
		expect(
			text
				.render(80)
				.map((line) => line.trimEnd())
				.join("\n"),
		).toBe("User Persona:\nhello world");
	});

	it("自定义模板：TUI 输出随模板变化（三面同变断言面之一）", () => {
		const templates = { ...DEFAULT_TEMPLATES, public_message: "[{sender}]→{content}" };
		const renderers = captureRenderers(() => templates);
		const display = renderers.find((r) => r.customType === "pi-tavern.creator-display");
		if (!display) throw new Error("no creator-display renderer");

		const box = display.renderer(
			{
				data: {
					kind: "public_message",
					group_chat_id: "group-1",
					event: { sender: { type: "character", character_id: "qa.md", name: "QA" }, content: "hi" },
				},
			},
			{},
			themeMock(),
		);
		const text = box.children[0];
		if (!text || typeof text.render !== "function") throw new Error("expected Text child");
		expect(
			text
				.render(80)
				.map((line) => line.trimEnd())
				.join("\n"),
		).toBe("[QA]→hi");
	});
});
