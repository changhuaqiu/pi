import type {
	TaskRunAssurance,
	TaskRunBudget,
	TaskRunConclusion,
	TaskRunEvidenceKind,
	TaskRunState,
} from "./task-run.ts";

export type TaskEvalCategory =
	| "analysis"
	| "edit"
	| "debug"
	| "verification";

export interface TaskEvalExpectation {
	conclusion: TaskRunConclusion;
	minimumAssurance: TaskRunAssurance;
	requiredEvidence?: readonly TaskRunEvidenceKind[];
	forbiddenEvidence?: readonly TaskRunEvidenceKind[];
}

export interface TaskEvalCase {
	id: string;
	category: TaskEvalCategory;
	goal: string;
	workspaceFixture: string;
	baseRevision?: string;
	budget: TaskRunBudget;
	expect: TaskEvalExpectation;
}

export interface TaskEvalSuite {
	id: string;
	cases: readonly TaskEvalCase[];
}

export type TaskEvalGradeKind =
	| "execution"
	| "correctness"
	| "verification"
	| "safety"
	| "efficiency";

export interface TaskEvalGrade {
	kind: TaskEvalGradeKind;
	passed: boolean;
	message: string;
}

export interface TaskEvalCaseResult {
	caseId: string;
	category: TaskEvalCategory;
	passed: boolean;
	run?: TaskRunState;
	error?: string;
	grades: readonly TaskEvalGrade[];
}

export interface TaskEvalSummary {
	caseCount: number;
	passed: number;
	failed: number;
	passRate: number;
	verified: number;
	verifiedRate: number;
	averageDurationMs: number;
	averageProviderRequests: number;
	averageToolCalls: number;
}

export interface TaskEvalReport {
	suiteId: string;
	startedAt: string;
	completedAt: string;
	results: readonly TaskEvalCaseResult[];
	summary: TaskEvalSummary;
}

export interface TaskEvalComparisonCase {
	caseId: string;
	change: "improved" | "regressed" | "unchanged";
	baselinePassed: boolean;
	currentPassed: boolean;
}

export interface TaskEvalComparison {
	suiteId: string;
	baselinePassRate: number;
	currentPassRate: number;
	deltaPassRate: number;
	baselineVerifiedRate: number;
	currentVerifiedRate: number;
	deltaVerifiedRate: number;
	cases: readonly TaskEvalComparisonCase[];
}

export interface TaskEvalRunOptions {
	now?: () => Date;
}

const assuranceRank: Record<TaskRunAssurance, number> = {
	unverified: 0,
	partial: 1,
	verified: 2,
};

function isNonEmpty(value: string): boolean {
	return value.trim().length > 0;
}

function validateSuite(suite: TaskEvalSuite): void {
	if (!isNonEmpty(suite.id)) throw new Error("Task eval suite id is required");
	if (suite.cases.length === 0) throw new Error("Task eval suite requires at least one case");
	const caseIds = new Set<string>();
	for (const evalCase of suite.cases) {
		if (!isNonEmpty(evalCase.id)) throw new Error("Task eval case id is required");
		if (caseIds.has(evalCase.id)) {
			throw new Error(`Duplicate task eval case id: ${evalCase.id}`);
		}
		caseIds.add(evalCase.id);
		if (!isNonEmpty(evalCase.goal)) {
			throw new Error(`Task eval case goal is required: ${evalCase.id}`);
		}
		if (!isNonEmpty(evalCase.workspaceFixture)) {
			throw new Error(`Task eval workspace fixture is required: ${evalCase.id}`);
		}
		for (const field of [
			"maxDurationMs",
			"maxProviderRequests",
			"maxToolCalls",
		] as const) {
			const value = evalCase.budget[field];
			if (
				value !== undefined &&
				(!Number.isSafeInteger(value) || value <= 0)
			) {
				throw new Error(
					`Task eval ${field} must be a positive safe integer: ${evalCase.id}`,
				);
			}
		}
		const required = new Set(evalCase.expect.requiredEvidence ?? []);
		const overlap = (evalCase.expect.forbiddenEvidence ?? []).find((kind) =>
			required.has(kind),
		);
		if (overlap) {
			throw new Error(
				`Task eval evidence cannot be both required and forbidden: ${evalCase.id}/${overlap}`,
			);
		}
	}
}

function gradeConclusion(
	evalCase: TaskEvalCase,
	run: TaskRunState,
): TaskEvalGrade {
	const passed =
		run.status === "terminal" &&
		run.conclusion === evalCase.expect.conclusion;
	return {
		kind: "correctness",
		passed,
		message: passed
			? `conclusion=${run.conclusion}`
			: `expected terminal conclusion=${evalCase.expect.conclusion}; received status=${run.status} conclusion=${run.conclusion ?? "none"}`,
	};
}

function gradeAssurance(
	evalCase: TaskEvalCase,
	run: TaskRunState,
): TaskEvalGrade {
	const passed =
		assuranceRank[run.assurance] >=
		assuranceRank[evalCase.expect.minimumAssurance];
	return {
		kind: "verification",
		passed,
		message: passed
			? `assurance=${run.assurance}`
			: `expected assurance>=${evalCase.expect.minimumAssurance}; received ${run.assurance}`,
	};
}

function gradeEvidence(
	evalCase: TaskEvalCase,
	run: TaskRunState,
): TaskEvalGrade {
	const evidenceKinds = new Set(run.evidence.map((evidence) => evidence.kind));
	const missing = (evalCase.expect.requiredEvidence ?? []).filter(
		(kind) => !evidenceKinds.has(kind),
	);
	const forbidden = (evalCase.expect.forbiddenEvidence ?? []).filter((kind) =>
		evidenceKinds.has(kind),
	);
	const policyViolation = evidenceKinds.has("policy_violation");
	const passed =
		missing.length === 0 &&
		forbidden.length === 0 &&
		!policyViolation;
	const details = [
		missing.length > 0 ? `missing=${missing.join(",")}` : undefined,
		forbidden.length > 0 ? `forbidden=${forbidden.join(",")}` : undefined,
		policyViolation ? "policy_violation" : undefined,
	].filter((detail): detail is string => detail !== undefined);
	return {
		kind: "safety",
		passed,
		message: passed ? "evidence constraints passed" : details.join("; "),
	};
}

function exceeds(
	actual: number,
	limit: number | undefined,
): boolean {
	return limit !== undefined && actual > limit;
}

function gradeEfficiency(
	evalCase: TaskEvalCase,
	run: TaskRunState,
): TaskEvalGrade {
	const failures = [
		exceeds(run.metrics.durationMs, evalCase.budget.maxDurationMs)
			? `duration=${run.metrics.durationMs}>${evalCase.budget.maxDurationMs}`
			: undefined,
		exceeds(
			run.metrics.providerRequests,
			evalCase.budget.maxProviderRequests,
		)
			? `providerRequests=${run.metrics.providerRequests}>${evalCase.budget.maxProviderRequests}`
			: undefined,
		exceeds(run.metrics.toolCalls, evalCase.budget.maxToolCalls)
			? `toolCalls=${run.metrics.toolCalls}>${evalCase.budget.maxToolCalls}`
			: undefined,
	].filter((failure): failure is string => failure !== undefined);
	return {
		kind: "efficiency",
		passed: failures.length === 0,
		message:
			failures.length === 0
				? "execution stayed within budget"
				: failures.join("; "),
	};
}

function gradeRun(
	evalCase: TaskEvalCase,
	run: TaskRunState,
): TaskEvalGrade[] {
	return [
		{
			kind: "execution",
			passed: run.id.length > 0,
			message: `runId=${run.id}`,
		},
		gradeConclusion(evalCase, run),
		gradeAssurance(evalCase, run),
		gradeEvidence(evalCase, run),
		gradeEfficiency(evalCase, run),
	];
}

function summarize(results: readonly TaskEvalCaseResult[]): TaskEvalSummary {
	const runs = results.flatMap((result) => (result.run ? [result.run] : []));
	const passed = results.filter((result) => result.passed).length;
	const verified = runs.filter((run) => run.assurance === "verified").length;
	const total = (select: (run: TaskRunState) => number): number =>
		runs.reduce((sum, run) => sum + select(run), 0);
	return {
		caseCount: results.length,
		passed,
		failed: results.length - passed,
		passRate: results.length > 0 ? (passed / results.length) * 100 : 0,
		verified,
		verifiedRate: results.length > 0 ? (verified / results.length) * 100 : 0,
		averageDurationMs:
			runs.length > 0
				? total((run) => run.metrics.durationMs) / runs.length
				: 0,
		averageProviderRequests:
			runs.length > 0
				? total((run) => run.metrics.providerRequests) / runs.length
				: 0,
		averageToolCalls:
			runs.length > 0
				? total((run) => run.metrics.toolCalls) / runs.length
				: 0,
	};
}

export async function runTaskEvalSuite(
	suite: TaskEvalSuite,
	execute: (evalCase: TaskEvalCase) => Promise<TaskRunState>,
	options: TaskEvalRunOptions = {},
): Promise<TaskEvalReport> {
	validateSuite(suite);
	const now = options.now ?? (() => new Date());
	const startedAt = now().toISOString();
	const results: TaskEvalCaseResult[] = [];
	for (const evalCase of suite.cases) {
		try {
			const run = await execute(evalCase);
			const grades = gradeRun(evalCase, run);
			results.push({
				caseId: evalCase.id,
				category: evalCase.category,
				passed: grades.every((grade) => grade.passed),
				run,
				grades,
			});
		} catch (error) {
			results.push({
				caseId: evalCase.id,
				category: evalCase.category,
				passed: false,
				error: error instanceof Error ? error.message : String(error),
				grades: [
					{
						kind: "execution",
						passed: false,
						message: error instanceof Error ? error.message : String(error),
					},
				],
			});
		}
	}
	return {
		suiteId: suite.id,
		startedAt,
		completedAt: now().toISOString(),
		results,
		summary: summarize(results),
	};
}

export function compareTaskEvalReports(
	baseline: TaskEvalReport,
	current: TaskEvalReport,
): TaskEvalComparison {
	if (baseline.suiteId !== current.suiteId) {
		throw new Error(
			`Cannot compare task eval suites ${baseline.suiteId} and ${current.suiteId}`,
		);
	}
	const baselineById = new Map(
		baseline.results.map((result) => [result.caseId, result]),
	);
	const currentById = new Map(
		current.results.map((result) => [result.caseId, result]),
	);
	const baselineIds = [...baselineById.keys()].sort();
	const currentIds = [...currentById.keys()].sort();
	if (
		baselineIds.length !== currentIds.length ||
		baselineIds.some((id, index) => id !== currentIds[index])
	) {
		throw new Error("Task eval reports must contain the same case ids");
	}
	const cases = baselineIds.map((caseId): TaskEvalComparisonCase => {
		const baselineResult = baselineById.get(caseId);
		const currentResult = currentById.get(caseId);
		if (!baselineResult || !currentResult) {
			throw new Error(`Task eval case is missing from comparison: ${caseId}`);
		}
		const change =
			baselineResult.passed === currentResult.passed
				? "unchanged"
				: currentResult.passed
					? "improved"
					: "regressed";
		return {
			caseId,
			change,
			baselinePassed: baselineResult.passed,
			currentPassed: currentResult.passed,
		};
	});
	return {
		suiteId: baseline.suiteId,
		baselinePassRate: baseline.summary.passRate,
		currentPassRate: current.summary.passRate,
		deltaPassRate: current.summary.passRate - baseline.summary.passRate,
		baselineVerifiedRate: baseline.summary.verifiedRate,
		currentVerifiedRate: current.summary.verifiedRate,
		deltaVerifiedRate:
			current.summary.verifiedRate - baseline.summary.verifiedRate,
		cases,
	};
}
