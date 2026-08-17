import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TaskRunState } from "./task-run.ts";
import type { ToolCapability } from "./tool-system.ts";

const planTaskSchema = Type.Object(
	{
		goal: Type.String({ minLength: 1, maxLength: 1_000 }),
		steps: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
			minItems: 1,
			maxItems: 12,
		}),
		verification: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
				maxItems: 8,
			}),
		),
		risks: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 8 }),
		),
	},
	{ additionalProperties: false },
);

const reflectTaskSchema = Type.Object(
	{
		decision: Type.Union([
			Type.Literal("continue"),
			Type.Literal("revise"),
			Type.Literal("ready"),
		]),
		evidence: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), {
			minItems: 1,
			maxItems: 12,
		}),
		nextAction: Type.String({ minLength: 1, maxLength: 1_000 }),
		risks: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 8 }),
		),
	},
	{ additionalProperties: false },
);

type PlanTaskInput = Static<typeof planTaskSchema>;
type ReflectTaskInput = Static<typeof reflectTaskSchema>;
export type TaskReflectionDecision = ReflectTaskInput["decision"];

export interface TaskPlanSnapshot {
	goal: string;
	steps: readonly string[];
	verification: readonly string[];
	risks: readonly string[];
}

export interface TaskReflectionSnapshot {
	decision: TaskReflectionDecision;
	evidence: readonly string[];
	nextAction: string;
	risks: readonly string[];
}

export type ReflectionVerificationStatus = "none" | "passed" | "failed";

export interface ReflectionGuidanceInput {
	goal?: string;
	run?: TaskRunState;
}

export interface ReflectionGuidanceSummary {
	changeSites: number;
	changedPaths: readonly string[];
	verification: ReflectionVerificationStatus;
	discrepancies: readonly string[];
}

export interface TaskReflectionDetails extends TaskReflectionSnapshot {
	guidance?: ReflectionGuidanceSummary;
}

export interface ReflectionGuidance {
	summary: ReflectionGuidanceSummary;
	text: string;
}

export interface ReflectTaskToolOptions {
	loadGuidance?: () => Promise<ReflectionGuidanceInput | undefined>;
}

const maxGuidanceGoalChars = 400;
const maxGuidancePaths = 10;
const maxGuidanceDiscrepancies = 5;

function truncateGuidanceText(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 1)}…`;
}

function completedChanges(run: TaskRunState): number {
	return run.evidence.filter(
		(evidence) => evidence.kind === "change" && evidence.outcome === "completed",
	).length;
}

function changedPaths(run: TaskRunState): string[] {
	const paths: string[] = [];
	for (const evidence of run.evidence) {
		if (evidence.kind !== "change" || evidence.outcome !== "completed") continue;
		const pathsMetadata = evidence.metadata?.paths;
		if (!Array.isArray(pathsMetadata)) continue;
		for (const path of pathsMetadata) {
			if (typeof path === "string") paths.push(path);
		}
	}
	return [...new Set(paths)];
}

function verificationAgainstCurrentState(
	run: TaskRunState,
): ReflectionVerificationStatus {
	for (let index = run.evidence.length - 1; index >= 0; index--) {
		const evidence = run.evidence[index];
		if (
			evidence?.kind === "verification" &&
			evidence.subjectFingerprint === run.currentSubjectFingerprint
		) {
			return evidence.outcome === "passed" ? "passed" : "failed";
		}
	}
	return "none";
}

export function buildReflectionGuidance(
	plan: TaskPlanSnapshot | undefined,
	input: ReflectionGuidanceInput,
): ReflectionGuidance {
	const run = input.run;
	const changeSites = run === undefined ? 0 : completedChanges(run);
	const paths = run === undefined ? [] : changedPaths(run);
	const verification =
		run === undefined ? "none" : verificationAgainstCurrentState(run);
	const discrepancies: string[] = [];
	if (plan !== undefined && run !== undefined) {
		if (
			changeSites > 0 &&
			plan.verification.length > 0 &&
			verification === "none"
		) {
			discrepancies.push(
				`The plan declared ${plan.verification.length} verification criteria, but no verification evidence matches the current workspace state.`,
			);
		}
		if (verification === "failed") {
			discrepancies.push(
				"The latest verification for the current workspace state failed.",
			);
		}
		if (changeSites > plan.steps.length) {
			discrepancies.push(
				`${changeSites} change sites were recorded, but the plan declared only ${plan.steps.length} step(s).`,
			);
		}
	}
	const lines: string[] = ["Runtime fact check:"];
	if (input.goal !== undefined) {
		lines.push(
			`- Original goal: ${truncateGuidanceText(input.goal, maxGuidanceGoalChars)}`,
		);
	}
	if (plan !== undefined) {
		lines.push(
			`- Plan: ${plan.steps.length} steps, ${plan.verification.length} verification criteria${plan.risks.length > 0 ? `, ${plan.risks.length} risk(s)` : ""}.`,
		);
	}
	if (run === undefined) {
		lines.push("- No execution task is active, so no changes or verification are recorded.");
	} else {
		const pathsPreview = paths.slice(0, maxGuidancePaths).join(", ");
		const pathsSuffix =
			paths.length > maxGuidancePaths ? `, …(+${paths.length - maxGuidancePaths} more)` : "";
		lines.push(
			changeSites === 0
				? "- Recorded changes: none."
				: `- Recorded changes: ${changeSites} site(s) across ${paths.length} path(s): ${pathsPreview}${pathsSuffix}`,
		);
		const verificationText =
			verification === "none"
				? "none matches the current workspace state"
				: verification === "passed"
					? "passed against the current workspace state"
					: "FAILED against the current workspace state";
		lines.push(`- Verification: ${verificationText}.`);
	}
	if (discrepancies.length > 0) {
		lines.push("- Facts that may indicate deviation:");
		for (const discrepancy of discrepancies.slice(0, maxGuidanceDiscrepancies)) {
			lines.push(`  * ${discrepancy}`);
		}
	}
	lines.push(
		"Compare these facts against the goal. If work is missing or off target, continue with tools and reflect again; otherwise proceed to finish_task.",
	);
	return {
		summary: {
			changeSites,
			changedPaths: paths,
			verification,
			discrepancies,
		},
		text: lines.join("\n"),
	};
}

export interface TaskDeliberationSnapshot {
	plan?: TaskPlanSnapshot;
	reflection?: TaskReflectionSnapshot;
	reflectionRequired: boolean;
}

const planValidator = Compile(planTaskSchema);
const reflectionValidator = Compile(reflectTaskSchema);
const sideEffectCapabilities = new Set([
	"fs.write",
	"fs.delete",
	"process.execute",
	"process.terminate",
]);

function normalizedText(value: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error("Task deliberation text must not be empty");
	return normalized;
}

function normalizedList(values: readonly string[]): string[] {
	return values.map(normalizedText);
}

function isSideEffect(capabilities: readonly ToolCapability[]): boolean {
	return capabilities.some((capability) => sideEffectCapabilities.has(capability.kind));
}

export class TaskDeliberationController {
	private plan?: TaskPlanSnapshot;
	private reflection?: TaskReflectionSnapshot;
	private reflectionRequired = false;

	beginTurn(): void {
		this.plan = undefined;
		this.reflection = undefined;
		this.reflectionRequired = false;
	}

	recordPlan(input: PlanTaskInput): TaskPlanSnapshot {
		const plan = Object.freeze({
			goal: normalizedText(input.goal),
			steps: Object.freeze(normalizedList(input.steps)),
			verification: Object.freeze(normalizedList(input.verification ?? [])),
			risks: Object.freeze(normalizedList(input.risks ?? [])),
		} satisfies TaskPlanSnapshot);
		this.plan = plan;
		this.reflection = undefined;
		return plan;
	}

	recordReflection(input: ReflectTaskInput): TaskReflectionSnapshot {
		const reflection = Object.freeze({
			decision: input.decision,
			evidence: Object.freeze(normalizedList(input.evidence)),
			nextAction: normalizedText(input.nextAction),
			risks: Object.freeze(normalizedList(input.risks ?? [])),
		} satisfies TaskReflectionSnapshot);
		this.reflection = reflection;
		this.reflectionRequired = false;
		return reflection;
	}

	afterToolResult(capabilities: readonly ToolCapability[]): void {
		if (!isSideEffect(capabilities)) return;
		this.reflectionRequired = true;
		this.reflection = undefined;
	}

	snapshot(): TaskDeliberationSnapshot {
		return {
			...(this.plan ? { plan: this.plan } : {}),
			...(this.reflection ? { reflection: this.reflection } : {}),
			reflectionRequired: this.reflectionRequired,
		};
	}
}

export function createPlanTaskTool(
	controller: TaskDeliberationController,
): AgentTool<typeof planTaskSchema, TaskPlanSnapshot> {
	return {
		name: "plan_task",
		label: "plan task",
		description:
			"Record a concise execution plan when a workspace change is multi-step, risky, or benefits from an explicit checkpoint. Skip it for read-only analysis and simple changes. Verification criteria are optional when no check is applicable.",
		parameters: planTaskSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal) {
			if (signal?.aborted) throw signal.reason;
			if (!planValidator.Check(rawInput)) {
				throw new Error("plan_task arguments failed execution-time validation");
			}
			const details = controller.recordPlan(rawInput);
			return {
				content: [{ type: "text", text: `Plan recorded: ${details.steps.length} steps` }],
				details,
			} satisfies AgentToolResult<TaskPlanSnapshot>;
		},
	};
}

export function createReflectTaskTool(
	controller: TaskDeliberationController,
	options: ReflectTaskToolOptions = {},
): AgentTool<typeof reflectTaskSchema, TaskReflectionDetails> {
	return {
		name: "reflect_task",
		label: "reflect task",
		description:
			"Record an evidence-based checkpoint when a multi-step task needs reassessment, a check failed, or the implementation may have drifted from the goal. Skip it when a direct final review is sufficient.",
		parameters: reflectTaskSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal) {
			if (signal?.aborted) throw signal.reason;
			if (!reflectionValidator.Check(rawInput)) {
				throw new Error("reflect_task arguments failed execution-time validation");
			}
			const reflection = controller.recordReflection(rawInput);
			const plan = controller.snapshot().plan;
			let guidance: ReflectionGuidance | undefined;
			if (options.loadGuidance) {
				try {
					const input = await options.loadGuidance();
					if (input) guidance = buildReflectionGuidance(plan, input);
				} catch {
					// Guidance is advisory; recording the reflection must not fail because of it.
				}
			}
			return {
				content: [
					{
						type: "text",
						text: `Reflection recorded: ${reflection.decision}.${guidance === undefined ? "" : `\n${guidance.text}`}`,
					},
				],
				details: {
					...reflection,
					...(guidance === undefined ? {} : { guidance: guidance.summary }),
				},
			} satisfies AgentToolResult<TaskReflectionDetails>;
		},
	};
}
