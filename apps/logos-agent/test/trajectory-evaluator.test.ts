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
	TrajectoryCompiler,
	type CanonicalTrajectoryRecordV1,
} from "../src/trajectory-compiler.ts";
import {
	TrajectoryEvaluator,
	type RubricCriterion,
} from "../src/trajectory-evaluator.ts";
import { createTrajectoryRegressionCaseFromFailure } from "../src/task-eval.ts";
import {
	InMemoryTaskRunJournal,
	TaskRunController,
	type TaskRunState,
} from "../src/task-run.ts";

const digestKey = new Uint8Array(32).fill(11);

const strategy: ExecutionStrategyIdentity = {
	version: "test-release",
	manifest: {
		release: "test-release",
		appVersion: "0.1.0",
		features: ["trajectory-evaluator"],
		model: { api: "faux", provider: "faux", id: "test-model" },
		systemPromptHash: "system-hash",
		toolsHash: "tools-hash",
		policyHash: "policy-hash",
		workspaceHash: "workspace-hash",
	},
	thinkingLevel: "high",
	streamOptionsHash: "stream-hash",
	contextPolicyHash: "context-hash",
};

function binaryCriterion(
	overrides: Partial<RubricCriterion> &
		Pick<RubricCriterion, "id" | "dimension" | "evidencePredicate">,
): RubricCriterion {
	return {
		id: overrides.id,
		name: overrides.id,
		description: `Evaluate ${overrides.id}`,
		dimension: overrides.dimension,
		scope: "task_specific",
		required: true,
		decisionRole: "gate",
		evaluatorKind: "deterministic",
		scoring: "binary",
		scoreDomain: [0, 1],
		anchors: [
			{ score: 0, description: "criterion failed" },
			{ score: 1, description: "criterion passed" },
		],
		evidencePredicate: overrides.evidencePredicate,
		...overrides,
	};
}

const criteria: readonly RubricCriterion[] = [
	binaryCriterion({
		id: "completed",
		dimension: "completion",
		evidencePredicate: {
			kind: "execution_completed",
			allowedOutcomes: ["completed"],
		},
	}),
	binaryCriterion({
		id: "current-subject-verified",
		dimension: "verification",
		evidencePredicate: { kind: "current_subject_verified" },
	}),
	binaryCriterion({
		id: "verification-observed",
		dimension: "semantic_correctness",
		evidencePredicate: {
			kind: "step_observed",
			stepKind: "verification",
			outcomes: ["passed"],
			requireCurrentSubject: true,
		},
	}),
];

async function compileTrajectory(options: {
	missingTaskRun?: boolean;
	addLateChange?: boolean;
	withTaskRun?: boolean;
	executionOutcome?: "completed" | "failed";
	verificationOutcome?: "passed" | "failed";
} = {}): Promise<CanonicalTrajectoryRecordV1> {
	const storage = new InMemorySessionStorage({
		metadata: {
			id: "session-1",
			createdAt: "2026-08-30T00:00:00.000Z",
		},
	});
	const session = new Session(storage);
	const journal = new InMemoryExecutionJournal();
	let id = 0;
	let now = Date.parse("2026-08-30T00:00:01.000Z");
	const executions = new ExecutionController({
		journal,
		createId: () => `execution-event-${++id}`,
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
		content: "Fix cache accounting",
		timestamp: 1,
	});
	await executions.apply("execution-1", {
		type: "link_session_entry",
		entryId: userEntryId,
		role: "user",
	});
	let taskRun: TaskRunState | undefined;
	let taskRuns: TaskRunController | undefined;
	if (options.withTaskRun) {
		taskRuns = new TaskRunController({
			journal: new InMemoryTaskRunJournal(),
			now: () => new Date((now += 100)),
		});
		taskRun = await taskRuns.start({
			executionId: "execution-1",
			sessionId: "session-1",
			goal: "Fix cache accounting",
			manifest: strategy.manifest,
		});
		await executions.apply("execution-1", {
			type: "link_task_run",
			runId: taskRun.id,
		});
	}
	await executions.apply("execution-1", {
		type: "fact",
		evidence: {
			kind: "change",
			sourceId: "change-1",
			outcome: "completed",
			subjectFingerprint: "workspace-after-change",
		},
	});
	await executions.apply("execution-1", {
		type: "fact",
		evidence: {
			kind: "verification",
			sourceId: "verification-1",
			outcome: options.verificationOutcome ?? "passed",
			subjectFingerprint: "workspace-after-change",
		},
	});
	if (options.addLateChange) {
		await executions.apply("execution-1", {
			type: "fact",
			evidence: {
				kind: "change",
				sourceId: "change-2",
				outcome: "completed",
				subjectFingerprint: "workspace-after-late-change",
			},
		});
	}
	const assistantEntryId = await session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Implemented and verified" }],
		api: "openai-completions",
		provider: "faux",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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
		outcome: options.executionOutcome ?? "completed",
		lastEntryId: assistantEntryId,
	});
	if (taskRuns !== undefined && taskRun !== undefined) {
		taskRun = await taskRuns.apply(taskRun.id, {
			type: "finish",
			conclusion: "success",
		});
	}
	const entries = await session.getEntries();
	return new TrajectoryCompiler({ digestKey }).compile({
		execution: options.missingTaskRun
			? { ...execution, runId: "missing-run" }
			: execution,
		executionEvents: await executions.getEvents(execution.id),
		sessionEntries: entries,
		...(taskRun === undefined ? {} : { taskRun }),
		...(taskRuns === undefined || taskRun === undefined
			? {}
			: { taskRunEvents: await taskRuns.getEvents(taskRun.id) }),
	});
}

function createEvaluator(): TrajectoryEvaluator {
	const timestamps = [
		new Date("2026-08-30T00:00:00.000Z"),
		new Date("2026-08-30T00:02:00.000Z"),
		new Date("2026-08-30T00:02:00.100Z"),
	];
	return new TrajectoryEvaluator({
		digestKey,
		createId: () => "evaluation-1",
		now: () => timestamps.shift() ?? new Date("2026-08-30T00:03:00.000Z"),
	});
}

test("TrajectoryEvaluator returns evidence-backed completion without conflating correctness or verification", async () => {
	const evaluator = createEvaluator();
	const rubric = evaluator.freeze({
		version: "rubric-v1",
		goal: "Fix cache accounting",
		generatedBy: "human",
		generatorVersion: "test-v1",
		criteria: [criteria[0]!],
	});
	const trajectory = await compileTrajectory();
	const report = evaluator.evaluate(rubric, trajectory);
	const evidenceIds = new Set(
		trajectory.evidenceIndex.map((evidence) => evidence.id),
	);

	assert.equal(report.status, "completed");
	assert.equal(report.hardDecision, "pass");
	assert.equal(report.dimensions.completed.result, "pass");
	assert.equal(report.dimensions.semanticallyCorrect.result, "unknown");
	assert.equal(report.dimensions.verified.result, "unknown");
	assert.ok(
		report.criteria.every(
			(evaluation) =>
				evaluation.result === "pass" &&
				evaluation.evidenceRefs.length > 0 &&
				evaluation.evidenceRefs.every((reference) => evidenceIds.has(reference)),
		),
	);
});

test("TrajectoryEvaluator keeps current-subject verification unknown without complete mutation coverage", async () => {
	const evaluator = createEvaluator();
	const rubric = evaluator.freeze({
		version: "rubric-v1",
		goal: "Fix cache accounting",
		generatedBy: "human",
		generatorVersion: "test-v1",
		criteria: [criteria[1]!],
	});
	const report = evaluator.evaluate(rubric, await compileTrajectory());

	assert.equal(report.status, "partial");
	assert.equal(report.hardDecision, "unknown");
	assert.equal(report.criteria[0]?.result, "unknown");
	assert.equal(report.dimensions.verified.result, "unknown");
	assert.match(
		report.criteria[0]?.explanation ?? "",
		/mutation coverage is incomplete/,
	);
});

test("TrajectoryEvaluator propagates incomplete evidence as unknown", async () => {
	const evaluator = createEvaluator();
	const rubric = evaluator.freeze({
		version: "rubric-v1",
		goal: "Fix cache accounting",
		generatedBy: "deterministic",
		generatorVersion: "test-v1",
		criteria: [
			binaryCriterion({
				id: "approval-observed",
				dimension: "safety",
				evidencePredicate: {
					kind: "step_observed",
					stepKind: "approval",
				},
			}),
		],
	});
	const report = evaluator.evaluate(
		rubric,
		await compileTrajectory({ missingTaskRun: true }),
	);

	assert.equal(report.status, "partial");
	assert.equal(report.hardDecision, "unknown");
	assert.equal(report.criteria[0]?.result, "unknown");
	assert.equal(report.diagnostics[0]?.code, "hard_gate_unknown");
});

test("TrajectoryEvaluator does not let unknown criteria override a hard failure", async () => {
	const evaluator = createEvaluator();
	const rubric = evaluator.freeze({
		version: "rubric-v1",
		goal: "Fix cache accounting",
		generatedBy: "human",
		generatorVersion: "test-v1",
		criteria: [
			binaryCriterion({
				id: "missing-approval",
				dimension: "safety",
				evidencePredicate: {
					kind: "step_observed",
					stepKind: "approval",
				},
			}),
			binaryCriterion({
				id: "absence-without-coverage",
				dimension: "safety",
				evidencePredicate: {
					kind: "capability_absent",
					capability: "network",
					forbiddenStepKinds: ["tool_result"],
				},
			}),
		],
	});
	const report = evaluator.evaluate(rubric, await compileTrajectory());

	assert.deepEqual(
		report.criteria.map((evaluation) => evaluation.result),
		["fail", "unknown"],
	);
	assert.equal(report.hardDecision, "fail");
	const regression = createTrajectoryRegressionCaseFromFailure({
		report,
		rubric,
		category: "edit",
		goal: "Fix cache accounting",
		workspaceFixture: "fixtures/cache-failure",
		budget: { maxToolCalls: 4 },
	});
	assert.deepEqual(regression.sourceFailure.failedCriterionIds, [
		"missing-approval",
	]);
	assert.equal(regression.rubric.rubricDigest, rubric.rubricDigest);
});

test("TrajectoryEvaluator keeps stale verification unknown without complete mutation coverage", async () => {
	const evaluator = createEvaluator();
	const rubric = evaluator.freeze({
		version: "rubric-v1",
		goal: "Fix cache accounting",
		generatedBy: "human",
		generatorVersion: "test-v1",
		criteria: [criteria[1]!],
	});
	const report = evaluator.evaluate(
		rubric,
		await compileTrajectory({ addLateChange: true }),
	);

	assert.equal(report.dimensions.verified.result, "unknown");
	assert.equal(report.criteria[0]?.result, "unknown");
	assert.equal(report.hardDecision, "unknown");
});

test("TrajectoryEvaluator keeps failed verification unknown when the current subject is not closed", async () => {
	const evaluator = createEvaluator();
	const rubric = evaluator.freeze({
		version: "rubric-v1",
		goal: "Fix cache accounting",
		generatedBy: "human",
		generatorVersion: "test-v1",
		criteria: [criteria[1]!],
	});
	const report = evaluator.evaluate(
		rubric,
		await compileTrajectory({ verificationOutcome: "failed" }),
	);

	assert.equal(report.dimensions.verified.result, "unknown");
	assert.equal(report.criteria[0]?.result, "unknown");
	assert.equal(report.hardDecision, "unknown");
});

test("TrajectoryEvaluator grades canonical TaskRun metrics against a frozen budget", async () => {
	const evaluator = createEvaluator();
	const rubric = evaluator.freeze({
		version: "rubric-v1",
		goal: "Fix cache accounting",
		generatedBy: "deterministic",
		generatorVersion: "test-v1",
		criteria: [
			binaryCriterion({
				id: "budget",
				dimension: "efficiency",
				evidencePredicate: {
					kind: "budget_within",
					budget: { maxDurationMs: 1_000, maxToolCalls: 1 },
				},
			}),
		],
	});
	const report = evaluator.evaluate(
		rubric,
		await compileTrajectory({ withTaskRun: true }),
	);

	assert.equal(report.criteria[0]?.result, "pass");
	assert.ok((report.criteria[0]?.evidenceRefs.length ?? 0) > 0);
	assert.equal(report.hardDecision, "pass");
});

test("TrajectoryEvaluator distinguishes an expected failed outcome from successful completion", async () => {
	const evaluator = createEvaluator();
	const rubric = evaluator.freeze({
		version: "failure-rubric-v1",
		goal: "Fix cache accounting",
		generatedBy: "deterministic",
		generatorVersion: "test-v1",
		criteria: [
			binaryCriterion({
				id: "expected-failure",
				dimension: "completion",
				evidencePredicate: {
					kind: "execution_completed",
					allowedOutcomes: ["failed"],
				},
			}),
		],
	});
	const report = evaluator.evaluate(
		rubric,
		await compileTrajectory({ executionOutcome: "failed" }),
	);

	assert.equal(report.criteria[0]?.result, "pass");
	assert.equal(report.hardDecision, "pass");
	assert.equal(report.dimensions.completed.result, "fail");
});

test("TrajectoryEvaluator rejects tampered rubrics and trajectories", async () => {
	const evaluator = createEvaluator();
	const rubric = evaluator.freeze({
		version: "rubric-v1",
		goal: "Fix cache accounting",
		generatedBy: "human",
		generatorVersion: "test-v1",
		criteria,
	});
	const trajectory = await compileTrajectory();

	assert.throws(
		() =>
			evaluator.evaluate(
				{ ...rubric, version: "tampered" },
				trajectory,
			),
		/Rubric envelope is invalid/,
	);
	assert.throws(
		() =>
			evaluator.evaluate(rubric, {
				...trajectory,
				outcome: "failed",
			}),
		/Canonical trajectory digest is invalid/,
	);
	assert.throws(
		() =>
			evaluator.evaluate(rubric, {
				...trajectory,
				compilerVersion: "unsupported-v0",
			}),
		/Canonical trajectory version or digest scheme is unsupported/,
	);
	const otherDomainEvaluator = new TrajectoryEvaluator({
		digestKey: new Uint8Array(32).fill(12),
	});
	assert.throws(
		() => otherDomainEvaluator.evaluate(rubric, trajectory),
		/Rubric envelope is invalid|projection domains do not match/,
	);
	const lateEvaluator = new TrajectoryEvaluator({
		digestKey,
		now: () => new Date("2026-08-31T00:00:00.000Z"),
	});
	const lateRubric = lateEvaluator.freeze({
		version: "late-rubric",
		goal: "Fix cache accounting",
		generatedBy: "human",
		generatorVersion: "test-v1",
		criteria,
	});
	assert.throws(
		() => lateEvaluator.evaluate(lateRubric, trajectory),
		/must be frozen before/,
	);
});
