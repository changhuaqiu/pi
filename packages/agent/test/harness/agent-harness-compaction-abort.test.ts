import { randomUUID } from "node:crypto";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import { createAssistantMessage, createUserMessage } from "./session-test-utils.ts";

describe("AgentHarness compaction abort", () => {
	it("streams accumulated compaction text before committing", async () => {
		const models = createModels();
		const registration = fauxProvider({ provider: `compact-progress-${randomUUID()}` });
		models.setProvider(registration.provider);
		registration.setResponses([fauxAssistantMessage("## Goal\nStreamed summary")]);
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(createUserMessage("one"));
		await session.appendMessage(createAssistantMessage("two"));
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const updates: string[] = [];
		let committedDuringUpdate = false;
		harness.subscribe(async (event) => {
			if (event.type !== "compaction_update") return;
			updates.push(event.text);
			committedDuringUpdate ||= (await session.getEntries()).some((entry) => entry.type === "compaction");
		});

		await harness.compact();

		expect(updates.length).toBeGreaterThan(1);
		expect(updates.at(-1)).toContain("Streamed summary");
		expect(committedDuringUpdate).toBe(false);
		expect((await session.getEntries()).some((entry) => entry.type === "compaction")).toBe(true);
	});

	it("rejects an already-aborted compaction without mutating the session", async () => {
		const models = createModels();
		const registration = fauxProvider({ provider: `compact-abort-${randomUUID()}` });
		models.setProvider(registration.provider);
		registration.setResponses([fauxAssistantMessage("## Goal\nUnused summary")]);
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(createUserMessage("one"));
		await session.appendMessage(createAssistantMessage("two"));
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const controller = new AbortController();
		controller.abort();

		await expect(harness.compact(undefined, { signal: controller.signal })).rejects.toThrow("Compaction aborted");

		expect((await session.getEntries()).some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("aborts during streamed summary generation without committing", async () => {
		const models = createModels();
		const registration = fauxProvider({ provider: `compact-stream-abort-${randomUUID()}` });
		models.setProvider(registration.provider);
		registration.setResponses([fauxAssistantMessage("## Goal\nCancel this streamed summary")]);
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(createUserMessage("one"));
		await session.appendMessage(createAssistantMessage("two"));
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const controller = new AbortController();
		harness.subscribe((event) => {
			if (event.type === "compaction_update" && event.phase === "summarizing" && event.text) {
				controller.abort();
			}
		});

		await expect(harness.compact(undefined, { signal: controller.signal })).rejects.toThrow(
			/Summarization aborted|Compaction aborted/,
		);

		expect((await session.getEntries()).some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("treats committing as the non-cancellable Session commit point", async () => {
		const models = createModels();
		const registration = fauxProvider({ provider: `compact-commit-${randomUUID()}` });
		models.setProvider(registration.provider);
		registration.setResponses([fauxAssistantMessage("## Goal\nCommit this summary")]);
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(createUserMessage("one"));
		await session.appendMessage(createAssistantMessage("two"));
		const harness = new AgentHarness({
			models,
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const controller = new AbortController();
		harness.subscribe((event) => {
			if (event.type === "compaction_update" && event.phase === "committing") {
				controller.abort();
			}
		});

		await expect(harness.compact(undefined, { signal: controller.signal })).resolves.toMatchObject({
			summary: expect.stringContaining("Commit this summary"),
		});
		expect((await session.getEntries()).some((entry) => entry.type === "compaction")).toBe(true);
	});
});
