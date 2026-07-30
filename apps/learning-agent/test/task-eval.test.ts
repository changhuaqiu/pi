import assert from "node:assert/strict";
import test from "node:test";
import {
	compareTaskEvalReports,
	runTaskEvalSuite,
	type TaskEvalCase,
	type TaskEvalReport,
	type TaskEvalSuite,
} from "../src/task-eval.ts";
import type { TaskRunState } from "../src/task-run.ts";

const evalCase: TaskEvalCase = {
	id: "edit-cache",
	category: "edit",
	goal: "Fix cache accounting",
	workspaceFixture: "fixtures/cache",
	baseRevision: "base-commit",
	budget: {
		maxDurationMs: 1_000,
		maxProviderRequests: 4,
		maxToolCalls: 8,
	},
	expect: {
		conclusion: "success",
		minimumAssurance: "verified",
		requiredEvidence: ["change", "verification"],
		forbiddenEvidence: ["policy_violation"],
	},
};

const suite: TaskEvalSuite = {
	id: "learning-agent-regression",
	cases: [evalCase],
};

function taskRun(overrides: Partial<TaskRunState> = {}): TaskRunState {
	return {
		id: "run-1",
		sessionId: "session-1",
		goal: evalCase.goal,
		status: "terminal",
		phase: "verify",
		conclusion: "success",
		assurance: "verified",
		manifest: {
			release: "candidate",
			appVersion: "0.1.0",
			features: ["task-run"],
			model: { api: "faux", provider: "faux", id: "model" },
			systemPromptHash: "system",
			toolsHash: "tools",
			policyHash: "policy",
			workspaceHash: "workspace",
		},
		evidence: [
			{
				id: "evidence-change",
				kind: "change",
				sourceId: "change-1",
				outcome: "completed",
				subjectFingerprint: "subject",
				recordedAt: "2026-07-30T00:00:00.000Z",
			},
			{
				id: "evidence-verification",
				kind: "verification",
				sourceId: "verification-1",
				outcome: "passed",
				subjectFingerprint: "subject",
				recordedAt: "2026-07-30T00:00:01.000Z",
			},
		],
		currentSubjectFingerprint: "subject",
		lastVerifiedSubjectFingerprint: "subject",
		sequence: 4,
		startedAt: "2026-07-30T00:00:00.000Z",
		updatedAt: "2026-07-30T00:00:01.000Z",
		completedAt: "2026-07-30T00:00:01.000Z",
		metrics: {
			providerRequests: 2,
			toolCalls: 3,
			approvals: 1,
			changes: 1,
			verifications: 1,
			durationMs: 1_000,
		},
		...overrides,
	};
}

test("task eval grades correctness, verification, safety, and efficiency", async () => {
	const timestamps = [
		new Date("2026-07-30T00:00:00.000Z"),
		new Date("2026-07-30T00:00:02.000Z"),
	];
	const report = await runTaskEvalSuite(
		suite,
		async () => taskRun(),
		{ now: () => timestamps.shift() ?? new Date(0) },
	);

	assert.equal(report.summary.passRate, 100);
	assert.equal(report.summary.verifiedRate, 100);
	assert.equal(report.summary.averageProviderRequests, 2);
	assert.equal(report.results[0]?.passed, true);
	assert.ok(report.results[0]?.grades.every((grade) => grade.passed));
});

test("policy violations and budget overruns fail even when tests passed", async () => {
	const violatingRun = taskRun({
		evidence: [
			...taskRun().evidence,
			{
				id: "evidence-policy",
				kind: "policy_violation",
				sourceId: "policy-1",
				outcome: "blocked",
				recordedAt: "2026-07-30T00:00:01.000Z",
			},
		],
		metrics: {
			...taskRun().metrics,
			toolCalls: 9,
		},
	});
	const report = await runTaskEvalSuite(suite, async () => violatingRun);

	assert.equal(report.results[0]?.passed, false);
	assert.deepEqual(
		report.results[0]?.grades
			.filter((grade) => !grade.passed)
			.map((grade) => grade.kind),
		["safety", "efficiency"],
	);
});

test("task eval reports executor failures without aborting the suite", async () => {
	const twoCaseSuite: TaskEvalSuite = {
		id: "two-cases",
		cases: [
			evalCase,
			{ ...evalCase, id: "debug-cache", category: "debug" },
		],
	};
	const report = await runTaskEvalSuite(twoCaseSuite, async (candidate) => {
		if (candidate.id === "edit-cache") throw new Error("fixture failed");
		return taskRun({ id: "run-2" });
	});

	assert.equal(report.summary.caseCount, 2);
	assert.equal(report.summary.passed, 1);
	assert.equal(report.results[0]?.error, "fixture failed");
	assert.equal(report.results[1]?.passed, true);
});

test("task eval rejects ambiguous evidence rules and invalid budgets", async () => {
	await assert.rejects(
		runTaskEvalSuite(
			{
				id: "invalid",
				cases: [{ ...evalCase, budget: { maxToolCalls: 0 } }],
			},
			async () => taskRun(),
		),
		/maxToolCalls must be a positive safe integer/,
	);
	await assert.rejects(
		runTaskEvalSuite(
			{
				id: "ambiguous",
				cases: [
					{
						...evalCase,
						expect: {
							...evalCase.expect,
							requiredEvidence: ["verification"],
							forbiddenEvidence: ["verification"],
						},
					},
				],
			},
			async () => taskRun(),
		),
		/cannot be both required and forbidden/,
	);
});

function report(
	passRate: number,
	verifiedRate: number,
	passed: boolean,
): TaskEvalReport {
	return {
		suiteId: "learning-agent-regression",
		startedAt: "2026-07-30T00:00:00.000Z",
		completedAt: "2026-07-30T00:00:01.000Z",
		results: [
			{
				caseId: "edit-cache",
				category: "edit",
				passed,
				grades: [],
			},
		],
		summary: {
			caseCount: 1,
			passed: passed ? 1 : 0,
			failed: passed ? 0 : 1,
			passRate,
			verified: verifiedRate > 0 ? 1 : 0,
			verifiedRate,
			averageDurationMs: 0,
			averageProviderRequests: 0,
			averageToolCalls: 0,
		},
	};
}

test("task eval comparison reports release regressions", () => {
	const comparison = compareTaskEvalReports(
		report(100, 100, true),
		report(0, 0, false),
	);

	assert.equal(comparison.deltaPassRate, -100);
	assert.equal(comparison.deltaVerifiedRate, -100);
	assert.equal(comparison.cases[0]?.change, "regressed");
});
