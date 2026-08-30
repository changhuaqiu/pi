import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../../../packages/agent/src/index.ts";
import { InMemorySessionStorage } from "../../../packages/agent/src/harness/session/memory-storage.ts";
import {
	ExecutionController,
	InMemoryExecutionJournal,
	type ExecutionStrategyIdentity,
} from "../src/execution-journal.ts";
import {
	InMemoryTaskRunJournal,
	reduceTaskRunEvents,
	TaskRunController,
} from "../src/task-run.ts";
import {
	canonicalTrajectoryJson,
	TrajectoryCompiler,
} from "../src/trajectory-compiler.ts";

const strategy: ExecutionStrategyIdentity = {
	version: "test-release",
	manifest: {
		release: "test-release",
		appVersion: "0.1.0",
		features: ["trajectory"],
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

async function createTerminalFixture() {
	const storage = new InMemorySessionStorage({
		metadata: {
			id: "session-1",
			createdAt: "2026-08-30T00:00:00.000Z",
		},
	});
	const session = new Session(storage);
	const journal = new InMemoryExecutionJournal();
	let id = 0;
	let now = Date.parse("2026-08-30T00:00:00.000Z");
	const executions = new ExecutionController({
		journal,
		createId: () => `event-${++id}`,
		now: () => new Date((now += 100)),
	});
	await executions.start({
		executionId: "execution-1",
		sessionId: "session-1",
		branchParentEntryId: null,
		strategy,
	});
	const userEntryId = await session.appendMessage({
		role: "user",
		content: "fix secret-cache-key",
		timestamp: 1,
	});
	await executions.apply("execution-1", {
		type: "link_session_entry",
		entryId: userEntryId,
		role: "user",
	});
	await executions.apply("execution-1", {
		type: "fact",
		evidence: {
			kind: "provider_request",
			sourceId: "provider-1",
			outcome: "started",
		},
	});
	await executions.apply("execution-1", {
		type: "fact",
		evidence: {
			kind: "change",
			sourceId: "change-1",
			outcome: "completed",
			subjectFingerprint: "raw-workspace-subject",
		},
	});
	const assistantEntryId = await session.appendMessage({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "private reasoning must not be captured" },
			{ type: "text", text: "implemented" },
		],
		api: "openai-completions",
		provider: "faux",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: 2,
	});
	await executions.apply("execution-1", {
		type: "link_session_entry",
		entryId: assistantEntryId,
		role: "assistant",
	});
	const execution = await executions.apply("execution-1", {
		type: "finish",
		outcome: "completed",
		lastEntryId: assistantEntryId,
	});
	return {
		execution,
		executionEvents: await executions.getEvents(execution.id),
		sessionEntries: await session.getEntries(),
		userEntryId,
		assistantEntryId,
	};
}

test("TrajectoryCompiler produces deterministic private canonical records", async () => {
	const fixture = await createTerminalFixture();
	const compiler = new TrajectoryCompiler({
		digestKey: new Uint8Array(32).fill(7),
	});
	const first = compiler.compile(fixture);
	const second = compiler.compile({
		execution: structuredClone(fixture.execution),
		executionEvents: structuredClone(fixture.executionEvents),
		sessionEntries: structuredClone(fixture.sessionEntries),
	});

	assert.deepEqual(second, first);
	assert.equal(first.status, "terminal");
	assert.equal(first.outcome, "completed");
	assert.equal(first.completeness.canonicalFacts, "complete");
	assert.ok(
		first.contentIndex.some(
			(reference) =>
				reference.sourceId === fixture.userEntryId && reference.available,
		),
	);
	assert.equal(first.artifacts[0]?.locator.value, fixture.assistantEntryId);
	const serialized = canonicalTrajectoryJson(first);
	assert.equal(serialized.includes("secret-cache-key"), false);
	assert.equal(serialized.includes("private reasoning"), false);
	assert.equal(serialized.includes("implemented"), false);
	assert.equal(serialized.includes("raw-workspace-subject"), false);
	assert.equal(serialized.includes("system-hash"), false);
});

test("TrajectoryCompiler reports missing linked entries instead of inventing evidence", async () => {
	const fixture = await createTerminalFixture();
	const compiler = new TrajectoryCompiler({
		digestKey: new Uint8Array(32).fill(7),
	});
	const trajectory = compiler.compile({
		execution: fixture.execution,
		executionEvents: fixture.executionEvents,
		sessionEntries: fixture.sessionEntries.filter(
			(entry) => entry.id !== fixture.userEntryId,
		),
	});

	assert.equal(trajectory.completeness.canonicalFacts, "partial");
	assert.ok(
		trajectory.completeness.missingSources.includes(
			`session_entry:${fixture.userEntryId}`,
		),
	);
	assert.equal(
		trajectory.contentIndex.find(
			(reference) => reference.sourceId === fixture.userEntryId,
		)?.available,
		false,
	);
	assert.equal(
		trajectory.contentIndex.find(
			(reference) => reference.id === trajectory.task.originalGoalRef,
		)?.available,
		false,
	);
});

test("TrajectoryCompiler uses digest-key domains that cannot be correlated", async () => {
	const fixture = await createTerminalFixture();
	const first = new TrajectoryCompiler({
		digestKey: new Uint8Array(32).fill(1),
	}).compile(fixture);
	const second = new TrajectoryCompiler({
		digestKey: new Uint8Array(32).fill(2),
	}).compile(fixture);

	assert.notEqual(first.projectionDomainId, second.projectionDomainId);
	assert.notEqual(first.sourceSnapshotDigest, second.sourceSnapshotDigest);
	assert.notEqual(first.trajectoryDigest, second.trajectoryDigest);
	assert.notEqual(first.contentIndex[0]?.id, second.contentIndex[0]?.id);
	assert.notEqual(first.strategy.systemPromptHash, second.strategy.systemPromptHash);
	assert.notEqual(first.strategy.toolsHash, second.strategy.toolsHash);
	assert.notEqual(first.strategy.policyHash, second.strategy.policyHash);
	assert.notEqual(first.strategy.contextPolicyHash, second.strategy.contextPolicyHash);
	assert.notEqual(first.strategy.streamOptionsHash, second.strategy.streamOptionsHash);
	assert.notEqual(
		first.steps.find((step) => step.subjectFingerprint)?.subjectFingerprint,
		second.steps.find((step) => step.subjectFingerprint)?.subjectFingerprint,
	);
});

test("TrajectoryCompiler marks active executions as partial", async () => {
	const fixture = await createTerminalFixture();
	const { outcome: _outcome, completedAt: _completedAt, ...withoutTerminal } =
		fixture.execution;
	const compiler = new TrajectoryCompiler({
		digestKey: new Uint8Array(32).fill(7),
	});
	const trajectory = compiler.compile({
		execution: { ...withoutTerminal, status: "active" },
		executionEvents: fixture.executionEvents.filter(
			(event) => event.type !== "finished",
		),
		sessionEntries: fixture.sessionEntries,
	});

	assert.equal(trajectory.completeness.canonicalFacts, "partial");
	assert.ok(
		trajectory.completeness.missingSources.includes("execution_finished"),
	);
});

test("TrajectoryCompiler includes TaskRun-only evidence and raw event changes", async () => {
	const fixture = await createTerminalFixture();
	const journal = new InMemoryTaskRunJournal();
	let id = 0;
	const taskRuns = new TaskRunController({
		journal,
		createId: () => `task-event-${++id}`,
		now: () => new Date(`2026-08-30T00:00:0${id}.000Z`),
	});
	const run = await taskRuns.start({
		executionId: fixture.execution.id,
		sessionId: fixture.execution.sessionId,
		goal: "Compile TaskRun evidence",
		manifest: strategy.manifest,
	});
	const linkedExecution = {
		...fixture.execution,
		runId: run.id,
	};
	const startedEvents = await taskRuns.getEvents(run.id);
	await taskRuns.apply(run.id, {
		type: "evidence",
		evidence: {
			kind: "verification",
			sourceId: "task-run-only-verification",
			outcome: "passed",
			subjectFingerprint: "task-run-subject",
		},
	});
	const allEvents = await taskRuns.getEvents(run.id);
	const compiler = new TrajectoryCompiler({
		digestKey: new Uint8Array(32).fill(7),
	});
	const before = compiler.compile({
		execution: linkedExecution,
		executionEvents: fixture.executionEvents,
		sessionEntries: fixture.sessionEntries,
		taskRun: reduceTaskRunEvents(startedEvents),
		taskRunEvents: startedEvents,
	});
	const after = compiler.compile({
		execution: linkedExecution,
		executionEvents: fixture.executionEvents,
		sessionEntries: fixture.sessionEntries,
		taskRun: reduceTaskRunEvents(allEvents),
		taskRunEvents: allEvents,
	});

	assert.notEqual(after.sourceSnapshotDigest, before.sourceSnapshotDigest);
	assert.notEqual(after.trajectoryDigest, before.trajectoryDigest);
	assert.ok(
		after.evidenceIndex.some(
			(evidence) =>
				evidence.source === "task_run_event" &&
				evidence.sourceId === allEvents[1]?.id,
		),
	);
	assert.ok(
		after.steps.some((step) => step.kind === "verification"),
	);
});

test("TrajectoryCompiler deduplicates mirrored execution facts and reports conflicts", async () => {
	const fixture = await createTerminalFixture();
	const providerFact = fixture.execution.facts.find(
		(fact) => fact.evidence.kind === "provider_request",
	);
	assert.ok(providerFact);
	const journal = new InMemoryTaskRunJournal();
	let id = 0;
	const taskRuns = new TaskRunController({
		journal,
		createId: () => `mirror-event-${++id}`,
		now: () => new Date(`2026-08-30T00:01:0${id}.000Z`),
	});
	const run = await taskRuns.start({
		executionId: fixture.execution.id,
		sessionId: fixture.execution.sessionId,
		goal: "Mirror execution evidence",
		manifest: strategy.manifest,
	});
	const { id: _id, recordedAt: _recordedAt, ...evidence } =
		providerFact.evidence;
	await taskRuns.apply(
		run.id,
		{ type: "evidence", evidence },
		{ idempotencyKey: `execution-fact:${providerFact.eventId}` },
	);
	const events = await taskRuns.getEvents(run.id);
	const linkedExecution = { ...fixture.execution, runId: run.id };
	const compiler = new TrajectoryCompiler({
		digestKey: new Uint8Array(32).fill(7),
	});
	const trajectory = compiler.compile({
		execution: linkedExecution,
		executionEvents: fixture.executionEvents,
		sessionEntries: fixture.sessionEntries,
		taskRun: reduceTaskRunEvents(events),
		taskRunEvents: events,
	});
	const mirroredEvent = events.find(
		(event) => event.type === "evidence_recorded",
	);
	assert.ok(mirroredEvent?.type === "evidence_recorded");

	assert.equal(
		trajectory.steps.filter((step) => step.kind === "model_request").length,
		1,
	);
	assert.equal(
		trajectory.evidenceIndex.some(
			(reference) => reference.sourceId === mirroredEvent.id,
		),
		false,
	);

	const conflictingEvent = {
		...mirroredEvent,
		evidence: { ...mirroredEvent.evidence, outcome: "completed" as const },
	};
	const conflict = compiler.compile({
		execution: linkedExecution,
		executionEvents: fixture.executionEvents,
		sessionEntries: fixture.sessionEntries,
		taskRun: reduceTaskRunEvents([events[0]!, conflictingEvent]),
		taskRunEvents: [events[0]!, conflictingEvent],
	});
	assert.equal(conflict.completeness.canonicalFacts, "partial");
	assert.ok(
		conflict.completeness.missingSources.includes(
			`source_conflict:task_run_event:${mirroredEvent.id}`,
		),
	);
});

test("TrajectoryCompiler reports conflicting duplicate Session entry ids", async () => {
	const fixture = await createTerminalFixture();
	const userEntry = fixture.sessionEntries.find(
		(entry) => entry.id === fixture.userEntryId,
	);
	assert.ok(userEntry?.type === "message" && userEntry.message.role === "user");
	const conflictingEntry = structuredClone(userEntry);
	conflictingEntry.message.content = "different content";
	const compiler = new TrajectoryCompiler({
		digestKey: new Uint8Array(32).fill(7),
	});
	const trajectory = compiler.compile({
		execution: fixture.execution,
		executionEvents: fixture.executionEvents,
		sessionEntries: [...fixture.sessionEntries, conflictingEntry],
	});

	assert.equal(trajectory.completeness.canonicalFacts, "partial");
	assert.ok(
		trajectory.completeness.missingSources.includes(
			`source_conflict:session_entry:${fixture.userEntryId}`,
		),
	);
});

test("TrajectoryCompiler keeps a completed trajectory stable when unrelated Session entries are appended", async () => {
	const fixture = await createTerminalFixture();
	const compiler = new TrajectoryCompiler({
		digestKey: new Uint8Array(32).fill(7),
	});
	const before = compiler.compile(fixture);
	const unrelatedEntry = structuredClone(fixture.sessionEntries[0]!);
	unrelatedEntry.id = "unrelated-entry";
	unrelatedEntry.parentId = null;
	const after = compiler.compile({
		...fixture,
		sessionEntries: [...fixture.sessionEntries, unrelatedEntry],
	});

	assert.equal(after.sourceSnapshotDigest, before.sourceSnapshotDigest);
	assert.equal(after.trajectoryDigest, before.trajectoryDigest);
});

test("TrajectoryCompiler rejects explicitly linked messages outside the execution branch", async () => {
	const fixture = await createTerminalFixture();
	const originalUserEntry = fixture.sessionEntries.find(
		(entry) => entry.id === fixture.userEntryId,
	);
	assert.ok(originalUserEntry?.type === "message");
	const siblingEntry = structuredClone(originalUserEntry);
	siblingEntry.id = "sibling-user-entry";
	siblingEntry.parentId = fixture.execution.branchParentEntryId;
	const execution = {
		...fixture.execution,
		entryLinks: fixture.execution.entryLinks.map((link) =>
			link.entryId === fixture.userEntryId
				? { ...link, entryId: siblingEntry.id }
				: link,
		),
	};
	const compiler = new TrajectoryCompiler({
		digestKey: new Uint8Array(32).fill(7),
	});
	const trajectory = compiler.compile({
		execution,
		executionEvents: fixture.executionEvents,
		sessionEntries: [...fixture.sessionEntries, siblingEntry],
	});

	assert.equal(trajectory.completeness.canonicalFacts, "partial");
	assert.ok(
		trajectory.completeness.missingSources.includes(
			`session_entry:${siblingEntry.id}`,
		),
	);
});

test("TrajectoryCompiler canonical ordering ignores diagnostic timestamps", async () => {
	const fixture = await createTerminalFixture();
	const changedExecution = {
		...fixture.execution,
		entryLinks: fixture.execution.entryLinks.map((link, index) => ({
			...link,
			timestamp:
				index === 0
					? "2099-01-01T00:00:00.000Z"
					: "1900-01-01T00:00:00.000Z",
		})),
		facts: fixture.execution.facts.map((fact, index) => ({
			...fact,
			evidence: {
				...fact.evidence,
				recordedAt:
					index === 0
						? "2099-01-01T00:00:00.000Z"
						: "1900-01-01T00:00:00.000Z",
			},
		})),
	};
	const compiler = new TrajectoryCompiler({
		digestKey: new Uint8Array(32).fill(7),
	});
	const baseline = compiler.compile(fixture);
	const changed = compiler.compile({
		execution: changedExecution,
		executionEvents: fixture.executionEvents,
		sessionEntries: fixture.sessionEntries,
	});

	assert.deepEqual(changed.steps, baseline.steps);
});

test("canonical trajectory JSON normalizes key order, Unicode, and line endings", () => {
	assert.equal(
		canonicalTrajectoryJson({ z: "e\u0301\r\n", a: 1 }),
		canonicalTrajectoryJson({ a: 1, z: "é\n" }),
	);
});
