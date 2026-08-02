import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../../../packages/agent/src/index.ts";
import { InMemorySessionStorage } from "../../../packages/agent/src/harness/session/memory-storage.ts";
import {
	SessionTaskRunJournal,
	TASK_RUN_EVENT_CUSTOM_TYPE,
} from "../src/session-task-run-journal.ts";
import {
	InMemoryTaskRunJournal,
	TaskRunController,
	TaskRunError,
	type TaskRunControllerOptions,
	type TaskRunManifest,
} from "../src/task-run.ts";

const manifest: TaskRunManifest = {
	release: "test-release",
	appVersion: "0.1.0",
	features: ["task-run"],
	model: {
		api: "faux",
		provider: "faux",
		id: "test-model",
	},
	systemPromptHash: "system-hash",
	toolsHash: "tools-hash",
	policyHash: "policy-hash",
	workspaceHash: "workspace-hash",
	budget: {
		maxDurationMs: 60_000,
		maxProviderRequests: 10,
		maxToolCalls: 20,
	},
};

function createController(
	journal = new InMemoryTaskRunJournal(),
	startMs = Date.parse("2026-07-30T00:00:00.000Z"),
): { controller: TaskRunController; journal: InMemoryTaskRunJournal } {
	let id = 0;
	let nowMs = startMs;
	const options: TaskRunControllerOptions = {
		journal,
		createId: () => `id-${++id}`,
		now: () => new Date((nowMs += 100)),
	};
	return { controller: new TaskRunController(options), journal };
}

test("TaskRun records a verified execution from immutable evidence", async () => {
	const { controller } = createController();
	const started = await controller.start({
		sessionId: "session-1",
		goal: "Fix cache accounting",
		manifest,
	});
	assert.equal(started.status, "active");
	assert.equal(started.phase, "discover");

	await controller.apply(started.id, { type: "phase", phase: "execute" });
	await controller.apply(started.id, {
		type: "evidence",
		evidence: {
			kind: "provider_request",
			sourceId: "provider-1",
			outcome: "completed",
		},
	});
	await controller.apply(started.id, {
		type: "evidence",
		evidence: {
			kind: "tool_decision",
			sourceId: "tool-1",
			outcome: "allowed",
		},
	});
	await controller.apply(started.id, {
		type: "evidence",
		evidence: {
			kind: "change",
			sourceId: "change-1",
			outcome: "completed",
			subjectFingerprint: "workspace-after-change",
		},
	});
	await controller.apply(started.id, { type: "phase", phase: "verify" });
	await controller.apply(started.id, {
		type: "evidence",
		evidence: {
			kind: "verification",
			sourceId: "verification-1",
			outcome: "passed",
			subjectFingerprint: "workspace-after-change",
		},
	});
	const finished = await controller.apply(started.id, {
		type: "finish",
		conclusion: "success",
	});

	assert.equal(finished.status, "terminal");
	assert.equal(finished.conclusion, "success");
	assert.equal(finished.assurance, "verified");
	assert.deepEqual(finished.metrics, {
		providerRequests: 1,
		toolCalls: 1,
		approvals: 0,
		changes: 1,
		verifications: 1,
		networkQueries: 0,
		durationMs: 700,
	});
});

test("a later change invalidates earlier verification", async () => {
	const { controller } = createController();
	const run = await controller.start({
		sessionId: "session-1",
		goal: "Update implementation",
		manifest,
	});
	await controller.apply(run.id, {
		type: "evidence",
		evidence: {
			kind: "change",
			sourceId: "change-1",
			outcome: "completed",
			subjectFingerprint: "subject-1",
		},
	});
	await controller.apply(run.id, {
		type: "evidence",
		evidence: {
			kind: "verification",
			sourceId: "verification-1",
			outcome: "passed",
			subjectFingerprint: "subject-1",
		},
	});
	await controller.apply(run.id, {
		type: "evidence",
		evidence: {
			kind: "change",
			sourceId: "change-2",
			outcome: "completed",
			subjectFingerprint: "subject-2",
		},
	});
	const finished = await controller.apply(run.id, {
		type: "finish",
		conclusion: "success",
	});

	assert.equal(finished.assurance, "partial");
	assert.equal(finished.currentSubjectFingerprint, "subject-2");
	assert.equal(finished.lastVerifiedSubjectFingerprint, "subject-1");
});

test("a later failed verification invalidates an earlier pass", async () => {
	const { controller } = createController();
	const run = await controller.start({
		sessionId: "session-1",
		goal: "Verify the workspace",
		manifest,
	});
	await controller.apply(run.id, {
		type: "evidence",
		evidence: {
			kind: "verification",
			sourceId: "verification-pass",
			outcome: "passed",
			subjectFingerprint: manifest.workspaceHash,
		},
	});
	await controller.apply(run.id, {
		type: "evidence",
		evidence: {
			kind: "verification",
			sourceId: "verification-fail",
			outcome: "failed",
			subjectFingerprint: manifest.workspaceHash,
		},
	});
	const finished = await controller.apply(run.id, {
		type: "finish",
		conclusion: "success",
	});

	assert.equal(finished.assurance, "unverified");
});

test("TaskRun attributes successful network queries", async () => {
	const { controller } = createController();
	const run = await controller.start({
		sessionId: "session-1",
		goal: "Find current release information",
		manifest,
	});
	const updated = await controller.apply(run.id, {
		type: "evidence",
		evidence: {
			kind: "network_search",
			sourceId: "web-search-1",
			outcome: "completed",
			metadata: { provider: "bing", resultCount: 5 },
		},
	});

	assert.equal(updated.metrics.networkQueries, 1);
	assert.equal(updated.evidence[0]?.kind, "network_search");
});

test("TaskRun enforces waiting and terminal transition invariants", async () => {
	const { controller } = createController();
	const run = await controller.start({
		sessionId: "session-1",
		goal: "Apply an approved edit",
		manifest,
	});
	const waiting = await controller.apply(run.id, {
		type: "wait",
		reason: "approval",
	});
	assert.equal(waiting.status, "waiting");

	await assert.rejects(
		controller.apply(run.id, { type: "phase", phase: "execute" }),
		(error: unknown) =>
			error instanceof TaskRunError && error.code === "invalid_transition",
	);
	await controller.apply(run.id, { type: "resume" });
	await controller.apply(run.id, {
		type: "evidence",
		evidence: {
			kind: "approval",
			sourceId: "approval-1",
			outcome: "started",
		},
	});
	await controller.apply(run.id, {
		type: "evidence",
		evidence: {
			kind: "approval",
			sourceId: "approval-1",
			outcome: "approved",
		},
	});
	const finished = await controller.apply(run.id, {
		type: "finish",
		conclusion: "aborted",
		reason: "cancelled by user",
	});
	assert.equal(finished.metrics.approvals, 1);
	assert.equal(finished.completionReason, "cancelled by user");
	await assert.rejects(
		controller.apply(run.id, { type: "phase", phase: "deliver" }),
		(error: unknown) =>
			error instanceof TaskRunError && error.code === "invalid_transition",
	);
});

test("TaskRun idempotency survives controller recreation", async () => {
	const first = createController();
	const run = await first.controller.start({
		sessionId: "session-1",
		goal: "Inspect the workspace",
		manifest,
		idempotencyKey: "start-1",
	});
	await first.controller.apply(
		run.id,
		{
			type: "evidence",
			evidence: {
				kind: "provider_request",
				sourceId: "request-1",
				outcome: "completed",
			},
		},
		{ idempotencyKey: "request-1" },
	);

	const second = createController(first.journal, Date.parse("2026-07-30T01:00:00.000Z"));
	const duplicateRun = await second.controller.start({
		sessionId: "session-1",
		goal: "Inspect the workspace",
		manifest,
		idempotencyKey: "start-1",
	});
	const duplicateEvidence = await second.controller.apply(
		run.id,
		{
			type: "evidence",
			evidence: {
				kind: "provider_request",
				sourceId: "request-1",
				outcome: "completed",
			},
		},
		{ idempotencyKey: "request-1" },
	);

	assert.equal(duplicateRun.id, run.id);
	assert.equal(duplicateEvidence.metrics.providerRequests, 1);
	assert.equal(duplicateEvidence.sequence, 2);
});

test("Session TaskRun journal persists events outside model context", async () => {
	const storage = new InMemorySessionStorage({
		metadata: {
			id: "session-1",
			createdAt: "2026-07-30T00:00:00.000Z",
		},
	});
	const session = new Session(storage);
	const journal = new SessionTaskRunJournal(session);
	let id = 0;
	const controller = new TaskRunController({
		journal,
		createId: () => `session-id-${++id}`,
		now: () => new Date("2026-07-30T00:00:00.000Z"),
	});

	const run = await controller.start({
		sessionId: "session-1",
		goal: "Persist task evidence",
		manifest,
	});
	await controller.apply(run.id, {
		type: "finish",
		conclusion: "success",
	});

	const entries = await session.getEntries();
	assert.ok(
		entries.some(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === TASK_RUN_EVENT_CUSTOM_TYPE,
		),
	);
	assert.deepEqual((await session.buildContext()).messages, []);
	assert.equal((await controller.get(run.id)).status, "terminal");
});
