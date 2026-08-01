import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { JoinAttempt } from "../../src/character/join-attempt.js";
import { type CharacterCard, loadCharacterCard } from "../../src/config/character-card.js";
import { CreatorRuntime } from "../../src/creator/creator-runtime.js";

const temporaryDirectories: string[] = [];
const creatorRuntimes: CreatorRuntime[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-tavern-m7-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function startCreator(): Promise<{ creator: CreatorRuntime; character: CharacterCard }> {
	const root = await createTemporaryDirectory();
	const characterPath = join(root, "characters", "architect.md");
	const configPath = join(root, "tavern.json");
	await mkdir(join(root, "characters"), { recursive: true });
	await writeFile(characterPath, "---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt");
	const character = await loadCharacterCard(characterPath, configPath);
	const creator = await CreatorRuntime.startNew(
		{
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			characters: [character],
		},
		{},
	);
	creatorRuntimes.push(creator);
	return { creator, character };
}

afterEach(async () => {
	await Promise.all(creatorRuntimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("M7 message fetch (ISSUE-012)", () => {
	it("pulls the increment since a cursor and heals gaps (A3/A4)", async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("hello 1");
		await creator.submitUserPersonaMessage("hello 2");
		await creator.submitUserPersonaMessage("hello 3");

		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-m7-fetch", {});
		const runtime = await attempt.claimCharacter(character.characterId);

		// Increment since the cursor: only newer messages, in order.
		const pulled = await runtime.fetchMessagesSince(1);
		expect(pulled).not.toBeNull();
		expect(pulled?.messages.map((m) => (m as { sequence?: number }).sequence)).toEqual([2, 3]);
		expect(pulled?.latestSequence).toBe(3);
		expect(pulled?.totalMessages).toBe(3);

		// Gap healing: a cursor that skipped a message still returns every
		// message after it (the server filters by sequence, no window).
		const gapHealed = await runtime.fetchMessagesSince(0);
		expect(gapHealed?.messages.map((m) => (m as { sequence?: number }).sequence)).toEqual([1, 2, 3]);

		// Nothing new after the latest message.
		const empty = await runtime.fetchMessagesSince(3);
		expect(empty?.messages).toEqual([]);
	});

	it("persists the delivery cursor atomically and reloads it (A2)", async () => {
		const root = await createTemporaryDirectory();
		const characterPath = join(root, "characters", "architect.md");
		const configPath = join(root, "tavern.json");
		await mkdir(join(root, "characters"), { recursive: true });
		await writeFile(characterPath, "---\nname: Architect\ndescription: Architecture\n---\nArchitect prompt");
		const character = await loadCharacterCard(characterPath, configPath);
		const creator = await CreatorRuntime.startNew(
			{
				cwd: join(root, "project"),
				agentDir: join(root, "agent"),
				characters: [character],
			},
			{},
		);
		creatorRuntimes.push(creator);

		const cursorPath = join(root, "cursors", "group-1.json");
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-m7-cursor", {
			cursorStorePath: cursorPath,
		});
		const runtime = await attempt.claimCharacter(character.characterId);

		// No cursor yet: first join falls back to the full-history path.
		expect(runtime.loadCursor()).toBeNull();

		// After a successful delivery, the cursor persists and reloads.
		runtime.saveCursor(7);
		expect(runtime.loadCursor()).toBe(7);
		const stored = JSON.parse(await readFile(cursorPath, "utf8")) as { last_sequence?: number };
		expect(stored.last_sequence).toBe(7);
	});

	it("treats a missing or corrupt cursor store as no cursor", async () => {
		const { creator, character } = await startCreator();
		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-m7-nocursor", {
			cursorStorePath: join(await createTemporaryDirectory(), "nowhere", "cursor.json"),
		});
		const runtime = await attempt.claimCharacter(character.characterId);

		expect(runtime.loadCursor()).toBeNull();

		const { creator: creator2, character: character2 } = await startCreator();
		const corruptPath = join(await createTemporaryDirectory(), "cursors", "group-1.json");
		await mkdir(join(corruptPath, ".."), { recursive: true });
		await writeFile(corruptPath, "{ not json");
		const attempt2 = await JoinAttempt.connect(creator2.activeDescriptor, "session-m7-corrupt", {
			cursorStorePath: corruptPath,
		});
		const runtime2 = await attempt2.claimCharacter(character2.characterId);
		expect(runtime2.loadCursor()).toBeNull();
	});
});

describe("ISSUE-013 B: speak staleness client side", () => {
	it("B1: a stale speak is rejected with the missing range; quota untouched", async () => {
		const { creator, character } = await startCreator();
		// Latest sequence is 2; the character has seen nothing yet.
		await creator.submitUserPersonaMessage("one");
		await creator.submitUserPersonaMessage("two");

		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-b1", {});
		const runtime = await attempt.claimCharacter(character.characterId);

		const result = await runtime.speak("stale reply");
		expect(result.published).toBe(false);
		expect(result.reason).toBe("stale");
		expect(result.missingFrom).toBe(1);
		expect(result.missingTo).toBe(2);
		expect(result.autoRecover).toBe(true);
		// B4: the rejected speak consumed no quota and raised no hand.
		expect(creator.state.round?.usedMessages).toBe(0);
		expect(creator.state.onlineCharacters.get("session-b1")?.handRaised).toBe(false);
	});

	it("B6: consecutive speaks publish — own echo does not self-reject", async () => {
		const root = await createTemporaryDirectory();
		const cursorPath = join(root, "cursors", "group.json");
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("one"); // seq 1, round created

		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-b6", {
			cursorStorePath: cursorPath,
		});
		const runtime = await attempt.claimCharacter(character.characterId);
		// Simulate the delivery pipeline having delivered seq 1 (join history).
		runtime.saveCursor(1);

		const first = await runtime.speak("one");
		expect(first.published).toBe(true);
		expect(first.sequence).toBe(2);

		// Without B6 the seen sequence would still be 1 and this second speak
		// would be judged stale against the character's own message.
		const second = await runtime.speak("two");
		expect(second.published).toBe(true);
		expect(second.sequence).toBe(3);
	});

	it("B5: auto-recovery budget exhausts after two stale speaks in the same round", async () => {
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("one");
		await creator.submitUserPersonaMessage("two");

		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-b5", {});
		const runtime = await attempt.claimCharacter(character.characterId);

		const first = await runtime.speak("r1");
		expect(first.autoRecover).toBe(true);
		const second = await runtime.speak("r2");
		expect(second.autoRecover).toBe(true);
		// Budget exhausted: the third refusal must not auto-pull.
		const third = await runtime.speak("r3");
		expect(third.autoRecover).toBe(false);
		expect(third.reason).toBe("stale");
	});

	it("B5: budget resets when the round snapshot changes", async () => {
		const root = await createTemporaryDirectory();
		const cursorPath = join(root, "cursors", "group.json");
		const { creator, character } = await startCreator();
		await creator.submitUserPersonaMessage("one"); // seq 1

		const attempt = await JoinAttempt.connect(creator.activeDescriptor, "session-b5r", {
			cursorStorePath: cursorPath,
		});
		const runtime = await attempt.claimCharacter(character.characterId);
		runtime.saveCursor(1);

		// Two stale speaks in round state 10:0.
		await creator.submitUserPersonaMessage("two"); // latest 2 > seen 1
		expect((await runtime.speak("r1")).autoRecover).toBe(true);
		expect((await runtime.speak("r2")).autoRecover).toBe(true);

		// A published speak changes the round snapshot (10:0 → 10:1).
		runtime.saveCursor(2);
		const published = await runtime.speak("fresh");
		expect(published.published).toBe(true);

		// Stale again: the budget reset with the round snapshot.
		await creator.submitUserPersonaMessage("three"); // latest 4 > seen 3
		const afterReset = await runtime.speak("r3");
		expect(afterReset.autoRecover).toBe(true);
	});
});
