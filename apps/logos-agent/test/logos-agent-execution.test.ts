import assert from "node:assert/strict";
import test from "node:test";
import {
	ExecutionController,
	InMemoryExecutionJournal,
	type ExecutionStrategyIdentity,
} from "../src/execution-journal.ts";
import { HarnessLogosAgent } from "../src/logos-agent.ts";
import {
	InMemoryTaskRunJournal,
	TaskRunController,
	type TaskRunEvidenceInput,
	type TaskRunManifest,
} from "../src/task-run.ts";
import { TurnTaskLifecycle } from "../src/turn-task-lifecycle.ts";

const manifest: TaskRunManifest = {
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
};

const strategy: ExecutionStrategyIdentity = {
	version: "test-release",
	manifest,
	thinkingLevel: "high",
	streamOptionsHash: "stream-hash",
	contextPolicyHash: "context-hash",
};

async function createExecutionController(): Promise<ExecutionController> {
	let id = 0;
	const controller = new ExecutionController({
		journal: new InMemoryExecutionJournal(),
		createId: () => `execution-event-${++id}`,
		now: () => new Date("2026-08-30T00:00:00.000Z"),
	});
	await controller.start({
		executionId: "execution-1",
		sessionId: "session-1",
		branchParentEntryId: null,
		strategy,
	});
	return controller;
}

function bindRecordTaskRunEvidence(agent: HarnessLogosAgent) {
	return (
		agent as unknown as {
			recordTaskRunEvidence(
				controller: TaskRunController,
				evidence: TaskRunEvidenceInput,
				options?: { runId?: string; idempotencyKey?: string },
			): Promise<unknown>;
		}
	).recordTaskRunEvidence.bind(agent);
}

function bindPromoteActiveTurnToTask(agent: HarnessLogosAgent) {
	return (
		agent as unknown as {
			promoteActiveTurnToTask(
				controller: TaskRunController,
			): Promise<{ id: string }>;
		}
	).promoteActiveTurnToTask.bind(agent);
}

function bindReconcileExecution(agent: HarnessLogosAgent) {
	return (
		agent as unknown as {
			reconcileExecution(
				executionId: string,
				recoverInterrupted?: boolean,
			): Promise<unknown>;
		}
	).reconcileExecution.bind(agent);
}

test("Logos Agent persists pre-promotion evidence without an in-memory buffer", async () => {
	const executions = await createExecutionController();
	const agent = Object.create(HarnessLogosAgent.prototype) as HarnessLogosAgent;
	Object.assign(agent as unknown as Record<string, unknown>, {
		activeExecutionId: "execution-1",
		activeTaskRunId: undefined,
		executions,
	});
	const taskRuns = new TaskRunController({
		journal: new InMemoryTaskRunJournal(),
	});

	await bindRecordTaskRunEvidence(agent)(
		taskRuns,
		{
			kind: "provider_request",
			sourceId: "provider-1",
			outcome: "started",
		},
		{ idempotencyKey: "provider-1" },
	);

	const execution = await executions.get("execution-1");
	assert.equal(execution.runId, undefined);
	assert.equal(execution.facts.length, 1);
	assert.equal(execution.facts[0]?.evidence.sourceId, "provider-1");
	assert.equal(
		"pendingTaskRunEvidence" in
			(agent as unknown as Record<string, unknown>),
		false,
	);
});

test("TaskRun promotion links execution identity and replays durable facts", async () => {
	const executions = await createExecutionController();
	await executions.apply("execution-1", {
		type: "fact",
		evidence: {
			kind: "provider_request",
			sourceId: "provider-1",
			outcome: "started",
		},
	});
	let id = 0;
	const taskRuns = new TaskRunController({
		journal: new InMemoryTaskRunJournal(),
		createId: () => `task-event-${++id}`,
		now: () => new Date("2026-08-30T00:00:00.000Z"),
	});
	const lifecycle = new TurnTaskLifecycle();
	lifecycle.beginTurn("implement the change");
	lifecycle.observeToolCapabilities([
		{ kind: "fs.write", scope: "workspace" },
	]);
	const agent = Object.create(HarnessLogosAgent.prototype) as HarnessLogosAgent;
	Object.assign(agent as unknown as Record<string, unknown>, {
		activeExecutionId: "execution-1",
		activeTaskRunId: undefined,
		createTaskRunManifest: () => manifest,
		executions,
		taskPromotionPromise: undefined,
		turnTaskLifecycle: lifecycle,
		observability: { linkTaskRun() {} },
		session: {
			async getMetadata() {
				return { id: "session-1" };
			},
		},
		async emit() {},
	});

	const promoted = await bindPromoteActiveTurnToTask(agent)(taskRuns);
	const run = await taskRuns.get(promoted.id);
	const execution = await executions.get("execution-1");

	assert.equal(run.executionId, "execution-1");
	assert.equal(run.evidence.length, 1);
	assert.equal(run.evidence[0]?.sourceId, "provider-1");
	assert.equal(execution.runId, run.id);
});

test("startup reconciliation links a TaskRun created before an execution link and replays facts", async () => {
	const executionJournal = new InMemoryExecutionJournal();
	let executionEventId = 0;
	const firstExecutions = new ExecutionController({
		journal: executionJournal,
		createId: () => `execution-event-${++executionEventId}`,
		now: () => new Date("2026-08-30T00:00:00.000Z"),
	});
	await firstExecutions.start({
		executionId: "execution-1",
		sessionId: "session-1",
		branchParentEntryId: null,
		strategy,
	});
	await firstExecutions.apply("execution-1", {
		type: "fact",
		evidence: {
			kind: "provider_request",
			sourceId: "provider-1",
			outcome: "started",
		},
	});
	const taskRunJournal = new InMemoryTaskRunJournal();
	let taskEventId = 0;
	const firstTaskRuns = new TaskRunController({
		journal: taskRunJournal,
		createId: () => `task-event-${++taskEventId}`,
		now: () => new Date("2026-08-30T00:00:00.000Z"),
	});
	const run = await firstTaskRuns.start({
		executionId: "execution-1",
		sessionId: "session-1",
		goal: "Recover promotion",
		manifest,
	});
	const recreatedExecutions = new ExecutionController({
		journal: executionJournal,
	});
	const recreatedTaskRuns = new TaskRunController({ journal: taskRunJournal });
	const agent = Object.create(HarnessLogosAgent.prototype) as HarnessLogosAgent;
	Object.assign(agent as unknown as Record<string, unknown>, {
		executions: recreatedExecutions,
		taskRuns: recreatedTaskRuns,
	});

	await bindReconcileExecution(agent)("execution-1");

	assert.equal((await recreatedExecutions.get("execution-1")).runId, run.id);
	assert.equal((await recreatedTaskRuns.get(run.id)).evidence.length, 1);
});

test("startup reconciliation repairs a durable link whose fact replay was interrupted", async () => {
	const executionJournal = new InMemoryExecutionJournal();
	const executions = new ExecutionController({ journal: executionJournal });
	await executions.start({
		executionId: "execution-1",
		sessionId: "session-1",
		branchParentEntryId: null,
		strategy,
	});
	const factState = await executions.apply("execution-1", {
		type: "fact",
		evidence: {
			kind: "verification",
			sourceId: "verification-1",
			outcome: "passed",
			subjectFingerprint: "workspace-hash",
		},
	});
	const taskRunJournal = new InMemoryTaskRunJournal();
	const taskRuns = new TaskRunController({ journal: taskRunJournal });
	const run = await taskRuns.start({
		executionId: "execution-1",
		sessionId: "session-1",
		goal: "Recover fact replay",
		manifest,
	});
	await executions.apply("execution-1", {
		type: "link_task_run",
		runId: run.id,
	});
	const agent = Object.create(HarnessLogosAgent.prototype) as HarnessLogosAgent;
	Object.assign(agent as unknown as Record<string, unknown>, {
		executions: new ExecutionController({ journal: executionJournal }),
		taskRuns: new TaskRunController({ journal: taskRunJournal }),
	});

	await bindReconcileExecution(agent)("execution-1");
	await bindReconcileExecution(agent)("execution-1");

	const repaired = await taskRuns.get(run.id);
	assert.equal(repaired.evidence.length, 1);
	assert.equal(repaired.evidence[0]?.sourceId, "verification-1");
	assert.equal(factState.facts.length, 1);
});

test("startup reconciliation aborts execution and TaskRun left active by a crashed process", async () => {
	const executionJournal = new InMemoryExecutionJournal();
	const executions = new ExecutionController({ journal: executionJournal });
	await executions.start({
		executionId: "execution-1",
		sessionId: "session-1",
		branchParentEntryId: null,
		strategy,
	});
	const taskRunJournal = new InMemoryTaskRunJournal();
	const taskRuns = new TaskRunController({ journal: taskRunJournal });
	const run = await taskRuns.start({
		executionId: "execution-1",
		sessionId: "session-1",
		goal: "Recover a crashed task",
		manifest,
	});
	const agent = Object.create(HarnessLogosAgent.prototype) as HarnessLogosAgent;
	Object.assign(agent as unknown as Record<string, unknown>, {
		executions: new ExecutionController({ journal: executionJournal }),
		taskRuns: new TaskRunController({ journal: taskRunJournal }),
	});

	await bindReconcileExecution(agent)("execution-1", true);

	const recoveredExecution = await executions.get("execution-1");
	const recoveredRun = await taskRuns.get(run.id);
	assert.equal(recoveredExecution.status, "terminal");
	assert.equal(recoveredExecution.outcome, "aborted");
	assert.equal(recoveredExecution.lastEntryId, null);
	assert.equal(recoveredRun.status, "terminal");
	assert.equal(recoveredRun.conclusion, "aborted");
	assert.match(recoveredRun.completionReason ?? "", /previous process ended/);
});
