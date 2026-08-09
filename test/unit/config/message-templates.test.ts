import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	DEFAULT_TEMPLATES,
	loadMessageTemplateFile,
	MESSAGE_TEMPLATE_KEYS,
	mergeMessageTemplates,
	renderTemplate,
	validateTemplate,
} from "../../../src/config/message-templates.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-template-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("DEFAULT_TEMPLATES", () => {
	it("covers exactly the five message template keys", () => {
		expect(MESSAGE_TEMPLATE_KEYS).toEqual([
			"public_message",
			"whisper_full",
			"whisper_placeholder",
			"seconds_ago",
			"minutes_ago",
		]);
		expect(Object.keys(DEFAULT_TEMPLATES).sort()).toEqual([...MESSAGE_TEMPLATE_KEYS].sort());
	});

	it("keeps the Arch-adjudicated default shapes (#154: public_message contains newline)", () => {
		expect(DEFAULT_TEMPLATES.public_message).toBe("{sender}:\n{content}");
		expect(DEFAULT_TEMPLATES.whisper_full).toBe("{sender} 向 {receiver} 悄悄说：{content}");
		expect(DEFAULT_TEMPLATES.whisper_placeholder).toBe("{sender} 向 {receiver} 悄悄说了一句话");
		expect(DEFAULT_TEMPLATES.seconds_ago).toBe("{count} 秒前");
		expect(DEFAULT_TEMPLATES.minutes_ago).toBe("{count} 分钟前");
	});

	it("whisper_placeholder default never references content", () => {
		expect(DEFAULT_TEMPLATES.whisper_placeholder).not.toContain("content");
	});
});

describe("validateTemplate", () => {
	it("accepts templates with all required placeholders", () => {
		expect(validateTemplate("public_message", "{sender}: {content}")).toEqual({ ok: true });
		expect(validateTemplate("public_message", "{sender}:\n{content}")).toEqual({ ok: true });
		expect(validateTemplate("whisper_full", "{sender} 向 {receiver} 悄悄说：{content}")).toEqual({ ok: true });
		expect(validateTemplate("seconds_ago", "{count} 秒前")).toEqual({ ok: true });
	});

	it("rejects templates missing a required placeholder", () => {
		expect(validateTemplate("public_message", "{sender}:")).toMatchObject({ ok: false });
		expect(validateTemplate("public_message", "{content}")).toMatchObject({ ok: false });
		expect(validateTemplate("whisper_full", "{sender} {receiver}")).toMatchObject({ ok: false });
		expect(validateTemplate("seconds_ago", "秒前")).toMatchObject({ ok: false });
	});

	it("rejects whisper_placeholder referencing content (privacy)", () => {
		expect(validateTemplate("whisper_placeholder", "{sender} 向 {receiver} 说：{content}")).toMatchObject({
			ok: false,
		});
	});

	it("rejects unknown placeholders", () => {
		expect(validateTemplate("public_message", "{sender}: {content} {when}")).toMatchObject({ ok: false });
		expect(validateTemplate("minutes_ago", "{count} 分钟前 {extra}")).toMatchObject({ ok: false });
	});

	it("rejects empty or blank templates", () => {
		expect(validateTemplate("public_message", "")).toMatchObject({ ok: false });
		expect(validateTemplate("public_message", "   ")).toMatchObject({ ok: false });
	});

	it("accepts repeated placeholders (not prohibited by contract)", () => {
		expect(validateTemplate("public_message", "{sender} {sender}: {content}")).toEqual({ ok: true });
	});
});

describe("renderTemplate", () => {
	it("replaces placeholders with provided values", () => {
		expect(renderTemplate("{sender}: {content}", { sender: "Dev", content: "hi" })).toBe("Dev: hi");
	});

	it("preserves newlines in the template", () => {
		expect(renderTemplate("{sender}:\n{content}", { sender: "Dev", content: "hi" })).toBe("Dev:\nhi");
	});

	it("replaces missing values with empty string", () => {
		expect(renderTemplate("{sender}: {content}", { sender: "Dev" })).toBe("Dev: ");
	});

	it("returns templates without placeholders unchanged", () => {
		expect(renderTemplate("plain text", { sender: "Dev" })).toBe("plain text");
	});

	it("does not recursively expand placeholder-looking values", () => {
		expect(renderTemplate("{content}", { content: "{sender}" })).toBe("{sender}");
	});
});

describe("mergeMessageTemplates", () => {
	it("prefers project over global over built-in per key", () => {
		const { templates, warnings } = mergeMessageTemplates(
			{ public_message: "P: {sender} {content}" },
			{ public_message: "G: {sender} {content}", seconds_ago: "G {count}s" },
		);
		expect(templates.public_message).toBe("P: {sender} {content}");
		expect(templates.seconds_ago).toBe("G {count}s");
		expect(templates.minutes_ago).toBe(DEFAULT_TEMPLATES.minutes_ago);
		expect(warnings).toEqual([]);
	});

	it("supports partial overrides", () => {
		const { templates } = mergeMessageTemplates({ minutes_ago: "{count} 分钟" }, undefined);
		expect(templates.minutes_ago).toBe("{count} 分钟");
		expect(templates.public_message).toBe(DEFAULT_TEMPLATES.public_message);
	});

	it("falls back per key with a warning when a layer entry is invalid", () => {
		const { templates, warnings } = mergeMessageTemplates(
			{ whisper_placeholder: "{sender} 向 {receiver} 说：{content}" },
			undefined,
		);
		expect(templates.whisper_placeholder).toBe(DEFAULT_TEMPLATES.whisper_placeholder);
		expect(warnings.some((warning) => warning.includes("whisper_placeholder"))).toBe(true);
	});

	it("ignores unknown keys with a warning", () => {
		const { templates, warnings } = mergeMessageTemplates({ unknown_key: "x" }, undefined);
		expect(templates.public_message).toBe(DEFAULT_TEMPLATES.public_message);
		expect(warnings.some((warning) => warning.includes("unknown_key"))).toBe(true);
	});

	it("falls back to built-in entirely when all layers are absent or invalid", () => {
		const { templates } = mergeMessageTemplates(undefined, undefined);
		expect(templates).toEqual(DEFAULT_TEMPLATES);
	});
});

describe("loadMessageTemplateFile", () => {
	it("returns null without warning when the config declares no templates", async () => {
		const { templates, warnings } = await loadMessageTemplateFile(undefined, undefined);
		expect(templates).toBeNull();
		expect(warnings).toEqual([]);
	});

	it("warns and returns null when the declared file is missing", async () => {
		const root = await createTemporaryDirectory();
		const { templates, warnings } = await loadMessageTemplateFile(join(root, "config"), "missing.json");
		expect(templates).toBeNull();
		expect(warnings.some((warning) => warning.includes("missing.json"))).toBe(true);
	});

	it("warns and returns null when the file is not valid JSON", async () => {
		const root = await createTemporaryDirectory();
		const path = "templates.json";
		await writeFile(join(root, path), "{not json", "utf8");
		const { templates, warnings } = await loadMessageTemplateFile(root, path);
		expect(templates).toBeNull();
		expect(warnings.length).toBeGreaterThan(0);
	});

	it("warns and returns null when the top-level value is not an object", async () => {
		const root = await createTemporaryDirectory();
		const path = "templates.json";
		await writeFile(join(root, path), "[1,2]", "utf8");
		const { templates, warnings } = await loadMessageTemplateFile(root, path);
		expect(templates).toBeNull();
		expect(warnings.length).toBeGreaterThan(0);
	});

	it("resolves the declared path relative to the config directory", async () => {
		const root = await createTemporaryDirectory();
		const configDir = join(root, "config");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			join(configDir, "templates.json"),
			JSON.stringify({ public_message: "C: {sender} {content}" }),
			"utf8",
		);
		const { templates, warnings } = await loadMessageTemplateFile(configDir, "templates.json");
		expect(templates).toEqual({ public_message: "C: {sender} {content}" });
		expect(warnings).toEqual([]);
	});

	it("drops non-string values per key with a warning", async () => {
		const root = await createTemporaryDirectory();
		const path = "templates.json";
		await writeFile(join(root, path), JSON.stringify({ public_message: 42 }), "utf8");
		const { templates, warnings } = await loadMessageTemplateFile(root, path);
		expect(templates).toEqual({});
		expect(warnings.length).toBeGreaterThan(0);
	});
});
