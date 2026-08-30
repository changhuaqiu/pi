import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../../../packages/agent/src/index.ts";
import { InMemorySessionStorage } from "../../../packages/agent/src/harness/session/memory-storage.ts";
import {
	ExecutionController,
	ExecutionJournalError,
	InMemoryExecutionJournal,
	type ExecutionControllerOptions,
	type ExecutionStrategyIdentity,
} from "../src/execution-journal.ts";
import {
	EXECUTION_EVENT_CUSTOM_TYPE,
	SessionExecutionJournal,
} from "../src/session-execution-journal.ts";

const strategy: ExecutionStrategyIdentity = {
	version: "test-release",
	manifest: {
		release: "test-release",
		appVersion: "0.1.0",
		features: ["execution-journal"],
		model: {
			api: "faux",
			provider: "faux",
			id: "test-model",
		},
		systemPromptHash: "system-hash",
		toolsHash: "tools-hash",
		policyHash: "policy-hash",
		workspaceHash: "workspace-hash",
	},
	thinkingLevel: "high",
	streamOptionsHash: "stream-hash",
	contextPolicyHash: "context-hash",
};

function createController(
	journal = new InMemoryExecutionJournal(),
): { controller: ExecutionController; journal: InMemoryExecutionJournal } {
	let id = 0;
	let now = Date.parse("2026-08-30T00:00:00.000Z");
	const options: ExecutionControllerOptions = {
		journal,
		createId: () => `event-${++id}`,
		now: () => new Date((now += 100)),
	};
	return { controller: new ExecutionController(options), journal };
}

test("ExecutionJournal persists prompt-level facts before TaskRun promotion", async () => {
	const { controller } = createController();
	const execution = await controller.start({
		executionId: "execution-1",
		sessionId: "session-1",
		branchParentEntryId: "branch-parent",
		strategy,
	});
	await controller.apply(execution.id, {
		type: "link_session_entry",
		entryId: "user-entry",
		role: "user",
	});
	await controller.apply(
		execution.id,
		{
			type: "fact",
			evidence: {
				kind: "provider_request",
				sourceId: "provider-1",
				outcome: "started",
			},
		},
		{ idempotencyKey: "provider-1" },
	);
	await controller.apply(
		execution.id,
		{
			type: "fact",
			evidence: {
				kind: "provider_request",
				sourceId: "provider-1",
				outcome: "started",
			},
		},
		{ idempotencyKey: "provider-1" },
	);

	const beforePromotion = await controller.get(execution.id);
	assert.equal(beforePromotion.status, "active");
	assert.equal(beforePromotion.runId, undefined);
	assert.equal(beforePromotion.facts.length, 1);
	assert.equal(beforePromotion.entryLinks[0]?.entryId, "user-entry");

	await controller.apply(execution.id, {
		type: "link_task_run",
		runId: "run-1",
	});
	const finished = await controller.apply(execution.id, {
		type: "finish",
		outcome: "completed",
		lastEntryId: "assistant-entry",
	});

	assert.equal(finished.status, "terminal");
	assert.equal(finished.runId, "run-1");
	assert.equal(finished.outcome, "completed");
	assert.equal(finished.lastEntryId, "assistant-entry");
	await assert.rejects(
		controller.apply(execution.id, {
			type: "link_session_entry",
			entryId: "late-entry",
			role: "assistant",
		}),
		(error: unknown) =>
			error instanceof ExecutionJournalError &&
			error.code === "invalid_transition",
	);
});

test("ExecutionJournal state and idempotency survive controller recreation", async () => {
	const first = createController();
	await first.controller.start({
		executionId: "execution-1",
		sessionId: "session-1",
		branchParentEntryId: null,
		strategy,
		idempotencyKey: "start-1",
	});
	await first.controller.apply(
		"execution-1",
		{
			type: "fact",
			evidence: {
				kind: "tool_decision",
				sourceId: "tool-1",
				outcome: "allowed",
			},
		},
		{ idempotencyKey: "fact-1" },
	);

	const second = createController(first.journal);
	const same = await second.controller.start({
		executionId: "execution-1",
		sessionId: "session-1",
		branchParentEntryId: null,
		strategy,
		idempotencyKey: "start-1",
	});
	const duplicate = await second.controller.apply(
		"execution-1",
		{
			type: "fact",
			evidence: {
				kind: "tool_decision",
				sourceId: "tool-1",
				outcome: "allowed",
			},
		},
		{ idempotencyKey: "fact-1" },
	);

	assert.equal(same.id, "execution-1");
	assert.equal(duplicate.facts.length, 1);
	assert.equal(duplicate.sequence, 2);
});

test("ExecutionJournal rejects an idempotency key reused with different facts", async () => {
	const { controller } = createController();
	await controller.start({
		executionId: "execution-1",
		sessionId: "session-1",
		branchParentEntryId: null,
		strategy,
	});
	await controller.apply(
		"execution-1",
		{
			type: "fact",
			evidence: {
				kind: "tool_decision",
				sourceId: "tool-1",
				outcome: "allowed",
			},
		},
		{ idempotencyKey: "fact-1" },
	);

	await assert.rejects(
		controller.apply(
			"execution-1",
			{
				type: "fact",
				evidence: {
					kind: "tool_decision",
					sourceId: "tool-1",
					outcome: "blocked",
				},
			},
			{ idempotencyKey: "fact-1" },
		),
		(error: unknown) =>
			error instanceof ExecutionJournalError && error.code === "invalid_event",
	);
});

test("Session Execution journal persists outside model context", async () => {
	const storage = new InMemorySessionStorage({
		metadata: {
			id: "session-1",
			createdAt: "2026-08-30T00:00:00.000Z",
		},
	});
	const session = new Session(storage);
	const journal = new SessionExecutionJournal(session);
	let id = 0;
	const controller = new ExecutionController({
		journal,
		createId: () => `session-event-${++id}`,
		now: () => new Date("2026-08-30T00:00:00.000Z"),
	});

	await controller.start({
		executionId: "execution-1",
		sessionId: "session-1",
		branchParentEntryId: null,
		strategy,
	});

	assert.ok(
		(await session.getEntries()).some(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === EXECUTION_EVENT_CUSTOM_TYPE,
		),
	);
	assert.deepEqual((await session.buildContext()).messages, []);
	assert.equal((await controller.get("execution-1")).status, "active");
});
