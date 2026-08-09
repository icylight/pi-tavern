import { describe, expect, it, vi } from "vitest";
import type { TavernConfig } from "../../src/config/load-config.js";
import type { TavernController } from "../../src/controller/tavern-controller.js";
import type { ActiveGroupChatDescriptor } from "../../src/data/discovery/active-descriptor.js";
import { type AutoJoinContext, autoJoinCharacter } from "../../src/headless.js";

/**
 * #154 阻断 3 红测：headless auto-join 与 /tavern-join 同生命周期——
 * 本地加载配置，自定义 message_templates 随 claim 达 CharacterRuntime。
 */

const descriptor: ActiveGroupChatDescriptor = {
	instanceId: "instance-1",
	groupChatId: "group-1",
	name: "Architecture",
	cwd: "/project",
	pid: 1234,
	host: "127.0.0.1",
	port: 54321,
	startedAt: "2026-07-27T00:00:00.000Z",
};

function stubContext(): AutoJoinContext {
	return {
		cwd: "/project",
		sessionManager: { getSessionId: () => "session-1" },
		ui: { notify: vi.fn() },
	} as unknown as AutoJoinContext;
}

describe("autoJoinCharacter (#154 阻断 3: 模板集加载)", () => {
	it("auto-join 加载 message_templates 并随 startJoining 透传", async () => {
		const customTemplates = {
			public_message: "[{sender}]→{content}",
			seconds_ago: "{count} sec ago",
			minutes_ago: "{count} min ago",
		};
		const startJoining = vi.fn(async () => ({
			isActive: true,
			availableCharacters: [{ character_id: "architect.md", name: "Architect", description: "Architecture" }],
			claimCharacter: vi.fn(async () => ({
				character: { name: "Architect" },
			})),
			close: vi.fn(async () => undefined),
		}));
		const controller = {
			getState: () => ({ type: "idle" }),
			startJoining,
			claimCharacter: vi.fn(async () => ({ character: { name: "Architect" } })),
			leave: vi.fn(async () => undefined),
		} as unknown as TavernController;
		const loadConfig = vi.fn(async () => ({ messageTemplates: customTemplates }) as TavernConfig);

		const result = await autoJoinCharacter({} as never, controller, stubContext(), {
			agentDir: "/agent",
			discoverGroupChats: vi.fn(async () => [descriptor]),
			character: "Architect",
			loadConfig,
		} as never);

		expect(result).toBe("Architect");
		expect(startJoining).toHaveBeenCalledWith(
			descriptor,
			"session-1",
			expect.objectContaining({ messageTemplates: customTemplates }),
		);
	});

	it("未配置 message_templates 时不传字段（消费面回落默认）", async () => {
		const startJoining = vi.fn(async () => ({
			isActive: true,
			availableCharacters: [{ character_id: "architect.md", name: "Architect", description: "Architecture" }],
			claimCharacter: vi.fn(async () => ({ character: { name: "Architect" } })),
			close: vi.fn(async () => undefined),
		}));
		const controller = {
			getState: () => ({ type: "idle" }),
			startJoining,
			claimCharacter: vi.fn(async () => ({ character: { name: "Architect" } })),
			leave: vi.fn(async () => undefined),
		} as unknown as TavernController;

		await autoJoinCharacter({} as never, controller, stubContext(), {
			agentDir: "/agent",
			discoverGroupChats: vi.fn(async () => [descriptor]),
			character: "Architect",
			loadConfig: vi.fn(async () => ({}) as TavernConfig),
		} as never);

		const call = startJoining.mock.calls[0] as [unknown, unknown, Record<string, unknown>] | undefined;
		expect(call?.[2].messageTemplates).toBeUndefined();
	});
});
