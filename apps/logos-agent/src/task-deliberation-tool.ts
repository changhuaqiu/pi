import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { ToolCallEvent, ToolCallResult } from "../../../packages/agent/src/index.ts";
import type { ToolCapability } from "./tool-system.ts";

const planTaskSchema = Type.Object(
	{
		goal: Type.String({ minLength: 1, maxLength: 1_000 }),
		steps: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
			minItems: 1,
			maxItems: 12,
		}),
		verification: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
			minItems: 1,
			maxItems: 8,
		}),
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
			verification: Object.freeze(normalizedList(input.verification)),
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

	beforeToolCall(
		event: Pick<ToolCallEvent, "toolName">,
		capabilities: readonly ToolCapability[],
	): ToolCallResult | undefined {
		if (isSideEffect(capabilities) && !this.plan) {
			return {
				block: true,
				reason: `Create a task plan with plan_task before using ${event.toolName}`,
			};
		}
		if (capabilities.some((capability) => capability.kind === "task.complete")) {
			if (this.reflectionRequired) {
				return {
					block: true,
					reason: "Reflect on the latest side effects with reflect_task before completing the task",
				};
			}
			if (this.plan && this.reflection?.decision !== "ready") {
				return {
					block: true,
					reason: "A planned task requires a final reflect_task decision of ready before finish_task",
				};
			}
		}
		return undefined;
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
			"Record a concise execution plan before performing side effects. Plans must identify the goal, bounded steps, verification, and relevant risks.",
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
): AgentTool<typeof reflectTaskSchema, TaskReflectionSnapshot> {
	return {
		name: "reflect_task",
		label: "reflect task",
		description:
			"Record an evidence-based checkpoint after side effects or verification. Use ready only when the requested outcome and relevant checks are complete.",
		parameters: reflectTaskSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal) {
			if (signal?.aborted) throw signal.reason;
			if (!reflectionValidator.Check(rawInput)) {
				throw new Error("reflect_task arguments failed execution-time validation");
			}
			const details = controller.recordReflection(rawInput);
			return {
				content: [{ type: "text", text: `Reflection recorded: ${details.decision}` }],
				details,
			} satisfies AgentToolResult<TaskReflectionSnapshot>;
		},
	};
}
