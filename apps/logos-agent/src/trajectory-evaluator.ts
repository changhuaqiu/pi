import { createHmac, randomUUID } from "node:crypto";
import {
	canonicalTrajectoryJson,
	type CanonicalTrajectoryRecordV1,
	TRAJECTORY_COMPILER_VERSION,
	TRAJECTORY_PROJECTION_VERSION,
	TRAJECTORY_SCHEMA_VERSION,
	type TrajectoryArtifactReference,
	type TrajectoryCoverageAttestation,
	type TrajectoryOutcome,
	type TrajectoryStep,
} from "./trajectory-compiler.ts";
import type { TaskRunBudget, TaskRunEvidenceKind } from "./task-run.ts";

export const RUBRIC_SCHEMA_VERSION = 1;
export const DETERMINISTIC_GRADER_VERSION = "p1-v1";

export type CriterionResult = "pass" | "fail" | "unknown" | "not_applicable";
export type RubricDimension =
	| "completion"
	| "semantic_correctness"
	| "verification"
	| "safety"
	| "efficiency"
	| "process";

export type EvidencePredicate =
	| {
			kind: "execution_completed";
			allowedOutcomes: readonly TrajectoryOutcome[];
	  }
	| {
			kind: "step_observed";
			stepKind: TrajectoryStep["kind"];
			outcomes?: readonly TrajectoryStep["outcome"][];
			minimumCount?: number;
			requireCurrentSubject?: boolean;
	  }
	| {
			kind: "evidence_kind_observed";
			evidenceKind: TaskRunEvidenceKind;
			outcomes?: readonly TrajectoryStep["outcome"][];
	  }
	| { kind: "evidence_kind_absent"; evidenceKind: TaskRunEvidenceKind }
	| { kind: "current_subject_verified" }
	| { kind: "budget_within"; budget: TaskRunBudget }
	| {
			kind: "capability_absent";
			capability: TrajectoryCoverageAttestation["capability"];
			forbiddenStepKinds: readonly TrajectoryStep["kind"][];
	  }
	| {
			kind: "artifact_present";
			artifactKind: TrajectoryArtifactReference["kind"];
	  }
	| {
			kind: "command_succeeded";
			commandSpecDigest: string;
			requireCurrentSubject: boolean;
	  }
	| {
			kind: "artifact_matches";
			artifactKind: TrajectoryArtifactReference["kind"];
			constraintDigest: string;
	  }
	| { kind: "claim_grounded"; claimClass: string }
	| { kind: "semantic_satisfaction"; requirementIds: readonly string[] };

export interface RubricAnchor {
	score: number;
	description: string;
}

export interface RubricCriterion {
	id: string;
	name: string;
	description: string;
	dimension: RubricDimension;
	scope: "global" | "task_specific";
	required: boolean;
	decisionRole: "gate" | "diagnostic";
	evaluatorKind: "deterministic" | "semantic" | "human";
	scoring: "binary" | "ordinal";
	scoreDomain: readonly number[];
	anchors: readonly RubricAnchor[];
	evidencePredicate: EvidencePredicate;
}

export interface RubricDefinition {
	schemaVersion: 1;
	version: string;
	taskDigest: string;
	projectionDomainId: string;
	digestScheme: "hmac_sha256";
	digestKeyVersion: string;
	rubricDigest: string;
	generatedBy: "human" | "deterministic" | "llm";
	generatorVersion: string;
	frozenAt: string;
	criteria: readonly RubricCriterion[];
}

export interface RubricFreezeInput {
	version: string;
	goal: unknown;
	generatedBy: RubricDefinition["generatedBy"];
	generatorVersion: string;
	criteria: readonly RubricCriterion[];
}

export interface CriterionEvaluation {
	criterionId: string;
	result: CriterionResult;
	score?: number;
	confidence?: number;
	evidenceRefs: readonly string[];
	explanation: string;
	evaluator: string;
}

export interface EvaluationDimension {
	result: Exclude<CriterionResult, "not_applicable">;
	evidenceRefs: readonly string[];
}

export interface FailureDiagnostic {
	code: string;
	criterionIds: readonly string[];
	evidenceRefs: readonly string[];
	description: string;
}

export interface EvaluationReport {
	evaluationId: string;
	executionId: string;
	reportDigest: string;
	digestScheme: "hmac_sha256";
	digestKeyVersion: string;
	rubricVersion: string;
	rubricDigest: string;
	trajectoryDigest: string;
	sourceSnapshotDigest: string;
	compilerVersion: string;
	projectionVersion: string;
	projectionDomainId: string;
	artifactSnapshotDigests: readonly string[];
	deterministicGraderVersion: string;
	status: "completed" | "partial" | "failed";
	dimensions: {
		completed: EvaluationDimension;
		semanticallyCorrect: EvaluationDimension;
		verified: EvaluationDimension;
	};
	criteria: readonly CriterionEvaluation[];
	hardDecision: "pass" | "fail" | "unknown";
	diagnostics: readonly FailureDiagnostic[];
	errors: readonly string[];
	startedAt: string;
	completedAt: string;
}

export interface TrajectoryEvaluatorOptions {
	digestKey: Uint8Array;
	digestKeyVersion?: string;
	createId?: () => string;
	now?: () => Date;
}

interface PredicateEvaluation {
	result: CriterionResult;
	evidenceRefs: readonly string[];
	explanation: string;
}

function isNonEmptyString(value: string): boolean {
	return value.trim().length > 0;
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

function composeResults(
	evaluations: readonly CriterionEvaluation[],
): EvaluationDimension {
	const applicable = evaluations.filter(
		(evaluation) => evaluation.result !== "not_applicable",
	);
	const evidenceRefs = uniqueSorted(
		applicable.flatMap((evaluation) => evaluation.evidenceRefs),
	);
	if (applicable.length === 0) return { result: "unknown", evidenceRefs };
	if (applicable.some((evaluation) => evaluation.result === "fail")) {
		return { result: "fail", evidenceRefs };
	}
	if (applicable.some((evaluation) => evaluation.result === "unknown")) {
		return { result: "unknown", evidenceRefs };
	}
	return { result: "pass", evidenceRefs };
}

export class TrajectoryEvaluator {
	private readonly digestKey: Uint8Array;
	private readonly digestKeyVersion: string;
	private readonly projectionDomainId: string;
	private readonly createId: () => string;
	private readonly now: () => Date;

	constructor(options: TrajectoryEvaluatorOptions) {
		if (options.digestKey.byteLength < 32) {
			throw new Error("Trajectory evaluator digest key must contain at least 32 bytes");
		}
		this.digestKey = new Uint8Array(options.digestKey);
		this.digestKeyVersion = options.digestKeyVersion ?? "local-v1";
		this.projectionDomainId = this.digest("logos-agent:private-domain").slice(
			0,
			24,
		);
		this.createId = options.createId ?? randomUUID;
		this.now = options.now ?? (() => new Date());
	}

	freeze(input: RubricFreezeInput): RubricDefinition {
		const rubricWithoutDigest: Omit<RubricDefinition, "rubricDigest"> = {
			schemaVersion: RUBRIC_SCHEMA_VERSION,
			version: input.version,
			taskDigest: this.digest(input.goal),
			projectionDomainId: this.projectionDomainId,
			digestScheme: "hmac_sha256",
			digestKeyVersion: this.digestKeyVersion,
			generatedBy: input.generatedBy,
			generatorVersion: input.generatorVersion,
			frozenAt: this.now().toISOString(),
			criteria: structuredClone(input.criteria),
		};
		const rubric: RubricDefinition = {
			...rubricWithoutDigest,
			rubricDigest: this.digest(rubricWithoutDigest),
		};
		this.validateRubric(rubric);
		return rubric;
	}

	evaluate(
		rubric: RubricDefinition,
		trajectory: CanonicalTrajectoryRecordV1,
	): EvaluationReport {
		this.validateInputs(rubric, trajectory);
		const startedAt = this.now().toISOString();
		const evaluations = rubric.criteria.map((criterion) =>
			this.evaluateCriterion(criterion, trajectory),
		);
		const deterministicGates = rubric.criteria.flatMap((criterion, index) =>
			criterion.required &&
			criterion.decisionRole === "gate" &&
			criterion.evaluatorKind === "deterministic"
				? [evaluations[index]!]
				: [],
		);
		const applicableDeterministicGates = deterministicGates.filter(
			(evaluation) => evaluation.result !== "not_applicable",
		);
		const hardDecision =
			applicableDeterministicGates.some(
				(evaluation) => evaluation.result === "fail",
			)
				? "fail"
				: applicableDeterministicGates.length === 0 ||
						applicableDeterministicGates.some(
							(evaluation) => evaluation.result === "unknown",
						)
					? "unknown"
					: "pass";
		const diagnostics: FailureDiagnostic[] = applicableDeterministicGates.flatMap(
			(evaluation) =>
				evaluation.result === "fail" || evaluation.result === "unknown"
					? [
							{
								code:
									evaluation.result === "fail"
										? "hard_gate_failed"
										: "hard_gate_unknown",
								criterionIds: [evaluation.criterionId],
								evidenceRefs: evaluation.evidenceRefs,
								description: evaluation.explanation,
							},
						]
					: [],
		);
		const completed = this.evaluateCompletion(trajectory);
		const verified = this.evaluateCurrentSubject(trajectory);
		const semanticallyCorrect = composeResults(
			rubric.criteria.flatMap((criterion, index) =>
				criterion.dimension === "semantic_correctness" &&
				criterion.evaluatorKind === "deterministic"
					? [evaluations[index]!]
					: [],
			),
		);
		const errors = trajectory.completeness.missingSources.map(
			(source) => `trajectory_missing:${source}`,
		);
		const completedAt = this.now().toISOString();
		const reportWithoutDigest: Omit<EvaluationReport, "reportDigest"> = {
			evaluationId: this.createId(),
			executionId: trajectory.executionId,
			digestScheme: "hmac_sha256",
			digestKeyVersion: this.digestKeyVersion,
			rubricVersion: rubric.version,
			rubricDigest: rubric.rubricDigest,
			trajectoryDigest: trajectory.trajectoryDigest,
			sourceSnapshotDigest: trajectory.sourceSnapshotDigest,
			compilerVersion: trajectory.compilerVersion,
			projectionVersion: trajectory.projectionVersion,
			projectionDomainId: trajectory.projectionDomainId,
			artifactSnapshotDigests: trajectory.artifacts
				.map((artifact) => artifact.digest)
				.sort(),
			deterministicGraderVersion: DETERMINISTIC_GRADER_VERSION,
			status:
				errors.length > 0 ||
				evaluations.some((evaluation) => evaluation.result === "unknown")
					? "partial"
					: "completed",
			dimensions: {
				completed: {
					result: completed.result === "not_applicable" ? "unknown" : completed.result,
					evidenceRefs: completed.evidenceRefs,
				},
				semanticallyCorrect,
				verified: {
					result: verified.result === "not_applicable" ? "unknown" : verified.result,
					evidenceRefs: verified.evidenceRefs,
				},
			},
			criteria: evaluations,
			hardDecision,
			diagnostics,
			errors,
			startedAt,
			completedAt,
		};
		return {
			...reportWithoutDigest,
			reportDigest: this.digest(reportWithoutDigest),
		};
	}

	private evaluateCriterion(
		criterion: RubricCriterion,
		trajectory: CanonicalTrajectoryRecordV1,
	): CriterionEvaluation {
		const predicate =
			criterion.evaluatorKind === "deterministic"
				? this.evaluatePredicate(criterion.evidencePredicate, trajectory)
				: {
						result: "unknown" as const,
						evidenceRefs: [],
						explanation: `${criterion.evaluatorKind} evaluator is not enabled in P1`,
					};
		const score = this.scoreForResult(criterion, predicate.result);
		return {
			criterionId: criterion.id,
			result: predicate.result,
			...(score === undefined ? {} : { score }),
			...(predicate.result === "pass" || predicate.result === "fail"
				? { confidence: 1 }
				: {}),
			evidenceRefs: uniqueSorted(predicate.evidenceRefs),
			explanation: predicate.explanation,
			evaluator:
				criterion.evaluatorKind === "deterministic"
					? DETERMINISTIC_GRADER_VERSION
					: `${criterion.evaluatorKind}:disabled`,
		};
	}

	private evaluatePredicate(
		predicate: EvidencePredicate,
		trajectory: CanonicalTrajectoryRecordV1,
	): PredicateEvaluation {
		if (predicate.kind === "execution_completed") {
			const terminal = this.evaluateTerminal(trajectory);
			if (terminal.result !== "pass") return terminal;
			return {
				result: predicate.allowedOutcomes.includes(trajectory.outcome ?? "failed")
					? "pass"
					: "fail",
				evidenceRefs: terminal.evidenceRefs,
				explanation: `terminal outcome=${trajectory.outcome ?? "missing"}`,
			};
		}
		if (predicate.kind === "step_observed") {
			return this.evaluateObservedStep(predicate, trajectory);
		}
		if (predicate.kind === "evidence_kind_observed") {
			const matching = trajectory.steps.filter(
				(step) =>
					step.evidenceKind === predicate.evidenceKind &&
					(predicate.outcomes === undefined ||
						predicate.outcomes.includes(step.outcome)) &&
					this.evidenceAvailable(step.evidenceRefs, trajectory),
			);
			if (matching.length > 0) {
				return {
					result: "pass",
					evidenceRefs: matching.flatMap((step) => step.evidenceRefs),
					explanation: `observed evidence kind=${predicate.evidenceKind}`,
				};
			}
			return this.closedWorldAbsence(
				trajectory,
				`required evidence kind=${predicate.evidenceKind} is absent`,
			);
		}
		if (predicate.kind === "evidence_kind_absent") {
			const matching = trajectory.steps.filter(
				(step) => step.evidenceKind === predicate.evidenceKind,
			);
			if (matching.length > 0) {
				return {
					result: "fail",
					evidenceRefs: matching.flatMap((step) => step.evidenceRefs),
					explanation: `forbidden evidence kind=${predicate.evidenceKind} was observed`,
				};
			}
			return {
				result: "unknown",
				evidenceRefs: [],
				explanation: `absence of evidence kind=${predicate.evidenceKind} cannot pass without complete coverage`,
			};
		}
		if (predicate.kind === "current_subject_verified") {
			return this.evaluateCurrentSubject(trajectory);
		}
		if (predicate.kind === "budget_within") {
			return this.evaluateBudget(predicate.budget, trajectory);
		}
		if (predicate.kind === "artifact_present") {
			const artifacts = trajectory.artifacts.filter(
				(artifact) =>
					artifact.kind === predicate.artifactKind &&
					this.evidenceAvailable([artifact.evidenceRef], trajectory),
			);
			if (artifacts.length > 0) {
				return {
					result: "pass",
					evidenceRefs: artifacts.map((artifact) => artifact.evidenceRef),
					explanation: `artifact ${predicate.artifactKind} is present`,
				};
			}
			return this.closedWorldAbsence(
				trajectory,
				`artifact ${predicate.artifactKind} is absent`,
			);
		}
		if (predicate.kind === "capability_absent") {
			const coverage = trajectory.coverage.find(
				(attestation) => attestation.capability === predicate.capability,
			);
			if (
				coverage?.status !== "complete" ||
				!this.evidenceAvailable(coverage.evidenceRefs, trajectory)
			) {
				return {
					result: "unknown",
					evidenceRefs: coverage?.evidenceRefs ?? [],
					explanation: `coverage for ${predicate.capability} is not complete`,
				};
			}
			const forbidden = trajectory.steps.filter((step) =>
				predicate.forbiddenStepKinds.includes(step.kind),
			);
			return forbidden.length === 0
				? {
						result: "pass",
						evidenceRefs: coverage.evidenceRefs,
						explanation: `no forbidden ${predicate.capability} event was observed under complete coverage`,
					}
				: {
						result: "fail",
						evidenceRefs: forbidden.flatMap((step) => step.evidenceRefs),
						explanation: `forbidden ${predicate.capability} event was observed`,
					};
		}
		return {
			result: "unknown",
			evidenceRefs: [],
			explanation: `${predicate.kind} requires a P2 evaluator or unavailable canonical facts`,
		};
	}

	private evaluateCompletion(
		trajectory: CanonicalTrajectoryRecordV1,
	): PredicateEvaluation {
		const terminal = this.evaluateTerminal(trajectory);
		if (terminal.result !== "pass") return terminal;
		return {
			result: trajectory.outcome === "completed" ? "pass" : "fail",
			evidenceRefs: terminal.evidenceRefs,
			explanation: `execution terminal outcome=${trajectory.outcome ?? "missing"}`,
		};
	}

	private evaluateTerminal(
		trajectory: CanonicalTrajectoryRecordV1,
	): PredicateEvaluation {
		const finish = trajectory.steps.find(
			(step) =>
				step.kind === "checkpoint" && step.name?.startsWith("execution_finished:"),
		);
		if (trajectory.status !== "terminal" || finish === undefined) {
			return {
				result: "unknown",
				evidenceRefs: [],
				explanation: "execution has no evidence-backed terminal event",
			};
		}
		if (!this.evidenceAvailable(finish.evidenceRefs, trajectory)) {
			return {
				result: "unknown",
				evidenceRefs: finish.evidenceRefs,
				explanation: "execution terminal evidence is unavailable",
			};
		}
		return {
			result: "pass",
			evidenceRefs: finish.evidenceRefs,
			explanation: `execution terminal outcome=${trajectory.outcome ?? "missing"}`,
		};
	}

	private evaluateObservedStep(
		predicate: Extract<EvidencePredicate, { kind: "step_observed" }>,
		trajectory: CanonicalTrajectoryRecordV1,
	): PredicateEvaluation {
		const currentSubject = [...trajectory.steps]
			.reverse()
			.find(
				(step) =>
					step.kind === "workspace_change" &&
					step.subjectFingerprint !== undefined,
			)?.subjectFingerprint;
		if (predicate.requireCurrentSubject && currentSubject === undefined) {
			return {
				result: "unknown",
				evidenceRefs: [],
				explanation: "current workspace subject is unavailable",
			};
		}
		if (predicate.requireCurrentSubject) {
			const coverage = this.evaluateMutationCoverage(trajectory);
			if (coverage.result !== "pass") return coverage;
		}
		const matching = trajectory.steps.filter(
			(step) =>
				step.kind === predicate.stepKind &&
				(predicate.outcomes === undefined || predicate.outcomes.includes(step.outcome)) &&
				(!predicate.requireCurrentSubject ||
					step.subjectFingerprint === currentSubject) &&
				this.evidenceAvailable(step.evidenceRefs, trajectory),
		);
		const minimumCount = predicate.minimumCount ?? 1;
		if (matching.length >= minimumCount) {
			return {
				result: "pass",
				evidenceRefs: matching.flatMap((step) => step.evidenceRefs),
				explanation: `observed ${matching.length} matching ${predicate.stepKind} step(s)`,
			};
		}
		return this.closedWorldAbsence(
			trajectory,
			`expected ${minimumCount} matching ${predicate.stepKind} step(s); observed ${matching.length}`,
		);
	}

	private evaluateCurrentSubject(
		trajectory: CanonicalTrajectoryRecordV1,
	): PredicateEvaluation {
		const change = [...trajectory.steps]
			.reverse()
			.find(
				(step) =>
					step.kind === "workspace_change" &&
					step.subjectFingerprint !== undefined,
			);
		if (change?.subjectFingerprint === undefined) {
			return {
				result: "unknown",
				evidenceRefs: [],
				explanation: "current workspace subject is unavailable",
			};
		}
		if (!this.evidenceAvailable(change.evidenceRefs, trajectory)) {
			return {
				result: "unknown",
				evidenceRefs: change.evidenceRefs,
				explanation: "current workspace subject evidence is unavailable",
			};
		}
		const coverage = this.evaluateMutationCoverage(trajectory);
		if (coverage.result !== "pass") {
			return {
				...coverage,
				evidenceRefs: [...change.evidenceRefs, ...coverage.evidenceRefs],
			};
		}
		const verification = [...trajectory.steps]
			.reverse()
			.find(
				(step) =>
					step.kind === "verification" &&
					step.subjectFingerprint === change.subjectFingerprint,
			);
		if (verification === undefined) {
			return this.closedWorldAbsence(
				trajectory,
				"current workspace subject has no verification",
				change.evidenceRefs,
			);
		}
		if (!this.evidenceAvailable(verification.evidenceRefs, trajectory)) {
			return {
				result: "unknown",
				evidenceRefs: [...change.evidenceRefs, ...verification.evidenceRefs],
				explanation: "current workspace verification evidence is unavailable",
			};
		}
		return {
			result: verification.outcome === "passed" ? "pass" : "fail",
			evidenceRefs: [...change.evidenceRefs, ...verification.evidenceRefs],
			explanation: `current workspace verification outcome=${verification.outcome}`,
		};
	}

	private evaluateMutationCoverage(
		trajectory: CanonicalTrajectoryRecordV1,
	): PredicateEvaluation {
		const requiredCapabilities: readonly TrajectoryCoverageAttestation["capability"][] = [
			"filesystem",
			"process",
			"external_mutation",
		];
		const attestations = requiredCapabilities.map((capability) =>
			trajectory.coverage.find(
				(attestation) => attestation.capability === capability,
			),
		);
		const evidenceRefs = uniqueSorted(
			attestations.flatMap((attestation) => attestation?.evidenceRefs ?? []),
		);
		if (
			attestations.some((attestation) => attestation?.status !== "complete") ||
			!this.evidenceAvailable(evidenceRefs, trajectory)
		) {
			return {
				result: "unknown",
				evidenceRefs,
				explanation: "mutation coverage is incomplete",
			};
		}
		return {
			result: "pass",
			evidenceRefs,
			explanation: "mutation coverage is complete",
		};
	}

	private evaluateBudget(
		budget: TaskRunBudget,
		trajectory: CanonicalTrajectoryRecordV1,
	): PredicateEvaluation {
		const metrics = trajectory.metrics;
		const checkpoint = [...trajectory.steps]
			.reverse()
			.find(
				(step) =>
					step.kind === "checkpoint" &&
					step.name?.startsWith("task_run_finished:"),
			);
		if (
			metrics === undefined ||
			checkpoint === undefined ||
			!this.evidenceAvailable(checkpoint.evidenceRefs, trajectory)
		) {
			return {
				result: "unknown",
				evidenceRefs: checkpoint?.evidenceRefs ?? [],
				explanation: "TaskRun metrics are incomplete or not terminal",
			};
		}
		const evidenceSteps = trajectory.steps.filter(
			(step) =>
				(step.kind === "checkpoint" &&
					(step.name === "task_run_started" ||
						step.name?.startsWith("task_run_finished:"))) ||
				(budget.maxProviderRequests !== undefined &&
					step.evidenceKind === "provider_request") ||
				(budget.maxToolCalls !== undefined &&
					step.evidenceKind === "tool_decision" &&
					step.outcome === "allowed"),
		);
		const evidenceRefs = uniqueSorted(
			evidenceSteps.flatMap((step) => step.evidenceRefs),
		);
		if (!this.evidenceAvailable(evidenceRefs, trajectory)) {
			return {
				result: "unknown",
				evidenceRefs,
				explanation: "TaskRun metric source evidence is unavailable",
			};
		}
		const failures = [
			budget.maxDurationMs !== undefined &&
			metrics.durationMs > budget.maxDurationMs
				? `durationMs=${metrics.durationMs}>${budget.maxDurationMs}`
				: undefined,
			budget.maxProviderRequests !== undefined &&
			metrics.providerRequests > budget.maxProviderRequests
				? `providerRequests=${metrics.providerRequests}>${budget.maxProviderRequests}`
				: undefined,
			budget.maxToolCalls !== undefined && metrics.toolCalls > budget.maxToolCalls
				? `toolCalls=${metrics.toolCalls}>${budget.maxToolCalls}`
				: undefined,
		].filter((failure): failure is string => failure !== undefined);
		return {
			result: failures.length === 0 ? "pass" : "fail",
			evidenceRefs,
			explanation:
				failures.length === 0
					? "TaskRun stayed within the frozen budget"
					: failures.join("; "),
		};
	}

	private closedWorldAbsence(
		trajectory: CanonicalTrajectoryRecordV1,
		explanation: string,
		additionalEvidenceRefs: readonly string[] = [],
	): PredicateEvaluation {
		const completion = this.evaluateCompletion(trajectory);
		if (
			trajectory.completeness.canonicalFacts !== "complete" ||
			completion.result === "unknown"
		) {
			return {
				result: "unknown",
				evidenceRefs: additionalEvidenceRefs,
				explanation: `${explanation}; canonical facts are incomplete`,
			};
		}
		return {
			result: "fail",
			evidenceRefs: [...additionalEvidenceRefs, ...completion.evidenceRefs],
			explanation,
		};
	}

	private evidenceAvailable(
		evidenceRefs: readonly string[],
		trajectory: CanonicalTrajectoryRecordV1,
	): boolean {
		if (evidenceRefs.length === 0) return false;
		const evidenceById = new Map(
			trajectory.evidenceIndex.map((evidence) => [evidence.id, evidence]),
		);
		return evidenceRefs.every(
			(reference) => evidenceById.get(reference)?.available === true,
		);
	}

	private scoreForResult(
		criterion: RubricCriterion,
		result: CriterionResult,
	): number | undefined {
		if (result !== "pass" && result !== "fail") return undefined;
		return result === "pass"
			? criterion.scoreDomain[criterion.scoreDomain.length - 1]
			: criterion.scoreDomain[0];
	}

	private validateInputs(
		rubric: RubricDefinition,
		trajectory: CanonicalTrajectoryRecordV1,
	): void {
		this.validateRubric(rubric);
		if (
			trajectory.schemaVersion !== TRAJECTORY_SCHEMA_VERSION ||
			trajectory.compilerVersion !== TRAJECTORY_COMPILER_VERSION ||
			trajectory.projectionVersion !== TRAJECTORY_PROJECTION_VERSION ||
			trajectory.digestScheme !== "hmac_sha256"
		) {
			throw new Error("Canonical trajectory version or digest scheme is unsupported");
		}
		if (
			rubric.projectionDomainId !== trajectory.projectionDomainId ||
			rubric.digestKeyVersion !== trajectory.digestKeyVersion ||
			trajectory.projectionDomainId !== this.projectionDomainId ||
			trajectory.digestKeyVersion !== this.digestKeyVersion
		) {
			throw new Error("Rubric and trajectory projection domains do not match");
		}
		const { trajectoryDigest, ...trajectoryWithoutDigest } = trajectory;
		if (this.digest(trajectoryWithoutDigest) !== trajectoryDigest) {
			throw new Error("Canonical trajectory digest is invalid");
		}
		const goal = trajectory.contentIndex.find(
			(reference) => reference.id === trajectory.task.originalGoalRef,
		);
		if (goal?.available !== true || goal.digest !== rubric.taskDigest) {
			throw new Error("Rubric task digest does not match the trajectory goal");
		}
		if (Date.parse(rubric.frozenAt) > Date.parse(trajectory.startedAt)) {
			throw new Error("Rubric must be frozen before the evaluated execution starts");
		}
	}

	private validateRubric(rubric: RubricDefinition): void {
		const { rubricDigest, ...rubricWithoutDigest } = rubric;
		if (
			rubric.schemaVersion !== RUBRIC_SCHEMA_VERSION ||
			!isNonEmptyString(rubric.version) ||
			!isNonEmptyString(rubric.taskDigest) ||
			!isNonEmptyString(rubric.generatorVersion) ||
			!Number.isFinite(Date.parse(rubric.frozenAt)) ||
			rubric.projectionDomainId !== this.projectionDomainId ||
			rubric.digestKeyVersion !== this.digestKeyVersion ||
			this.digest(rubricWithoutDigest) !== rubricDigest
		) {
			throw new Error("Rubric envelope is invalid");
		}
		const criterionIds = new Set<string>();
		for (const criterion of rubric.criteria) {
			if (
				!isNonEmptyString(criterion.id) ||
				!isNonEmptyString(criterion.name) ||
				!isNonEmptyString(criterion.description) ||
				criterionIds.has(criterion.id)
			) {
				throw new Error(`Rubric criterion is invalid or duplicated: ${criterion.id}`);
			}
			criterionIds.add(criterion.id);
			if (
				criterion.scoreDomain.length === 0 ||
				criterion.scoreDomain.some(
					(score, index) =>
						!Number.isFinite(score) ||
						(index > 0 && score <= criterion.scoreDomain[index - 1]!),
				) ||
				criterion.anchors.length !== criterion.scoreDomain.length ||
				criterion.anchors.some(
					(anchor, index) =>
						anchor.score !== criterion.scoreDomain[index] ||
						!isNonEmptyString(anchor.description),
				)
			) {
				throw new Error(`Rubric scoring is invalid: ${criterion.id}`);
			}
			if (criterion.scoring === "binary" && criterion.scoreDomain.length !== 2) {
				throw new Error(`Binary rubric criterion requires two scores: ${criterion.id}`);
			}
			if (
				criterion.evaluatorKind === "deterministic" &&
				criterion.scoring !== "binary"
			) {
				throw new Error(
					`P1 deterministic rubric criterion must be binary: ${criterion.id}`,
				);
			}
			if (
				criterion.evidencePredicate.kind === "execution_completed" &&
				criterion.evidencePredicate.allowedOutcomes.length === 0
			) {
				throw new Error(`Execution criterion requires an allowed outcome: ${criterion.id}`);
			}
			if (
				criterion.evidencePredicate.kind === "step_observed" &&
				(!Number.isSafeInteger(
					criterion.evidencePredicate.minimumCount ?? 1,
				) ||
					(criterion.evidencePredicate.minimumCount ?? 1) < 1)
			) {
				throw new Error(`Step criterion minimumCount is invalid: ${criterion.id}`);
			}
			if (criterion.evidencePredicate.kind === "budget_within") {
				for (const field of [
					"maxDurationMs",
					"maxProviderRequests",
					"maxToolCalls",
				] as const) {
					const value = criterion.evidencePredicate.budget[field];
					if (
						value !== undefined &&
						(!Number.isSafeInteger(value) || value <= 0)
					) {
						throw new Error(`Budget criterion ${field} is invalid: ${criterion.id}`);
					}
				}
			}
		}
	}

	private digest(value: unknown): string {
		return createHmac("sha256", this.digestKey)
			.update(canonicalTrajectoryJson(value), "utf8")
			.digest("hex");
	}
}
