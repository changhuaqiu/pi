import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TaskRunAssurance } from "./task-run.ts";

const finishTaskSchema = Type.Object(
	{
		summary: Type.String({
			minLength: 1,
			maxLength: 2_000,
			description: "Concise description of the result that is now complete",
		}),
		verification: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 2_000,
				description: "Checks performed, or why verification was not applicable",
			}),
		),
	},
	{ additionalProperties: false },
);

type FinishTaskInput = Static<typeof finishTaskSchema>;

export const taskCompletionToolName = "finish_task";

export interface FinishTaskDetails {
	stage: "completed";
	summary: string;
	verification?: string;
	assurance?: TaskRunAssurance;
}

export interface FinishTaskToolOptions {
	loadAssurance?: () => Promise<TaskRunAssurance | undefined>;
}

const assuranceNotes: Record<TaskRunAssurance, string> = {
	verified: "a verification check passed against the current workspace state",
	partial: "verification passed earlier, but none covers the latest changes",
	unverified:
		"no passing verification covers the current workspace state; state exactly what was not verified in the final summary",
};

export const taskCompletionContinuationPrompt =
	"Continue executing the current user task now. Do not only announce what you will do. Use the available tools for remaining work. When the task is genuinely complete, call finish_task as the only tool call. After its result, provide the concise final user-facing summary as normal assistant text.";

export const taskLengthContinuationPrompt =
	"Continue the current response from where it was truncated. Preserve the current task plan and evidence. Complete any remaining work, then call finish_task as the only tool call. After its result, provide the concise final user-facing summary as normal assistant text.";

export const turnCompletionContinuationPrompt =
	"Provide the missing user-facing answer to the current request. End normally when the answer is complete.";

export const turnLengthContinuationPrompt =
	"Continue the current answer from where it was truncated. End normally when the answer is complete.";

export type CompletionContinuationReason = "completion" | "length";

const internalContinuationPrompts = new Set([
	taskCompletionContinuationPrompt,
	taskLengthContinuationPrompt,
	turnCompletionContinuationPrompt,
	turnLengthContinuationPrompt,
]);

export function isInternalContinuationPrompt(text: string): boolean {
	return internalContinuationPrompts.has(text);
}

export const maxTaskCompletionContinuations = 2;

export interface TaskCompletionLoopResult {
	message: AssistantMessage;
	completed: boolean;
	continuationCount: number;
}

const finishTaskValidator = Compile(finishTaskSchema);

function parseFinishTaskInput(input: Readonly<Record<string, unknown>>): FinishTaskInput {
	if (!finishTaskValidator.Check(input)) {
		throw new Error("finish_task arguments failed execution-time validation");
	}
	const summary = input.summary.trim();
	const verification = input.verification?.trim();
	if (!summary || (input.verification !== undefined && !verification)) {
		throw new Error("finish_task text must not be empty");
	}
	return {
		summary,
		...(verification === undefined ? {} : { verification }),
	};
}

export function createFinishTaskTool(
	options: FinishTaskToolOptions = {},
): AgentTool<typeof finishTaskSchema, FinishTaskDetails> {
	return {
		name: taskCompletionToolName,
		label: "finish task",
		description:
			"Optionally record an explicit completion checkpoint for a longer execution task after requested actions and relevant verification are complete. Simple changes and read-only answers should end with a normal assistant response instead. Use this as the only tool call in its message, then answer the user's original goal naturally without more tools.",
		parameters: finishTaskSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal) {
			if (signal?.aborted) throw signal.reason;
			const input = parseFinishTaskInput(rawInput);
			let assurance: TaskRunAssurance | undefined;
			if (options.loadAssurance) {
				try {
					assurance = await options.loadAssurance();
				} catch {
					// Assurance is advisory; completion recording must not fail because of it.
				}
			}
			const details: FinishTaskDetails = {
				stage: "completed",
				summary: input.summary,
				...(input.verification === undefined
					? {}
					: { verification: input.verification }),
				...(assurance === undefined ? {} : { assurance }),
			};
			const text = [
				"Task completion recorded.",
				...(assurance === undefined
					? []
					: [`Assurance: ${assurance} — ${assuranceNotes[assurance]}.`]),
				"Now answer the user's original request naturally as normal assistant text. Do not mechanically restate the summary, verification, assurance, or task state, and do not call another tool.",
			].join(" ");
			return {
				content: [{ type: "text", text }],
				details,
			} satisfies AgentToolResult<FinishTaskDetails>;
		},
	};
}

export function hasSuccessfulTaskCompletion(
	message: AssistantMessage,
	successfulToolCallIds: ReadonlySet<string>,
): boolean {
	const hasToolCall = message.content.some((item) => item.type === "toolCall");
	const hasUserFacingText = message.content.some(
		(item) => item.type === "text" && item.text.trim().length > 0,
	);
	return (
		message.stopReason === "stop" &&
		hasUserFacingText &&
		!hasToolCall &&
		successfulToolCallIds.size > 0
	);
}

export function getEligibleTaskCompletionToolCallId(
	message: AssistantMessage,
): string | undefined {
	const toolCalls = message.content.filter((item) => item.type === "toolCall");
	return toolCalls.length === 1 && toolCalls[0]?.name === taskCompletionToolName
		? toolCalls[0].id
		: undefined;
}

export function isSuccessfulTaskCompletionResult(
	toolName: string,
	isError: boolean,
	details: unknown,
): boolean {
	return (
		toolName === taskCompletionToolName &&
		!isError &&
		typeof details === "object" &&
		details !== null &&
		(details as Record<string, unknown>).stage === "completed"
	);
}

export class TaskCompletionTracker {
	private readonly eligibleToolCallIds = new Set<string>();
	private readonly successfulToolCallIds = new Set<string>();
	private readonly pendingExternalInputIds = new Set<number>();
	private nextExternalInputId = 1;

	private clearCompletion(): void {
		this.eligibleToolCallIds.clear();
		this.successfulToolCallIds.clear();
	}

	reset(): void {
		this.clearCompletion();
		this.pendingExternalInputIds.clear();
	}

	beginExternalInput(): number {
		this.clearCompletion();
		const inputId = this.nextExternalInputId++;
		this.pendingExternalInputIds.add(inputId);
		return inputId;
	}

	observeExternalInput(): void {
		this.clearCompletion();
		const inputId = this.pendingExternalInputIds.values().next().value;
		if (inputId !== undefined) this.pendingExternalInputIds.delete(inputId);
	}

	cancelExternalInput(inputId: number): void {
		this.pendingExternalInputIds.delete(inputId);
	}

	hasPendingExternalInput(): boolean {
		return this.pendingExternalInputIds.size > 0;
	}

	observeAssistantMessage(message: AssistantMessage): void {
		if (this.hasPendingExternalInput()) return;
		const hasToolCall = message.content.some((item) => item.type === "toolCall");
		if (!hasToolCall) return;
		this.successfulToolCallIds.clear();
		this.eligibleToolCallIds.clear();
		const eligibleToolCallId = getEligibleTaskCompletionToolCallId(message);
		if (eligibleToolCallId) this.eligibleToolCallIds.add(eligibleToolCallId);
	}

	observeToolCall(): void {
		if (this.hasPendingExternalInput()) return;
		this.successfulToolCallIds.clear();
	}

	observeToolResult(toolCallId: string, completed: boolean): void {
		if (this.hasPendingExternalInput()) return;
		if (completed && this.eligibleToolCallIds.has(toolCallId)) {
			this.successfulToolCallIds.add(toolCallId);
		}
		this.eligibleToolCallIds.delete(toolCallId);
	}

	isCompleted(message: AssistantMessage): boolean {
		return !this.hasPendingExternalInput() && hasSuccessfulTaskCompletion(message, this.successfulToolCallIds);
	}
}

function throwIfTaskCompletionAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	const error = new Error("Task completion cancelled");
	error.name = "AbortError";
	throw error;
}

export async function runTaskCompletionLoop(
	initialPrompt: string,
	execute: (prompt: string) => Promise<AssistantMessage>,
	isCompleted: (message: AssistantMessage) => boolean,
	onContinuation: (
		attempt: number,
		maxAttempts: number,
		reason: CompletionContinuationReason,
	) => void | Promise<void>,
	signal?: AbortSignal,
	selectContinuationPrompt: (reason: CompletionContinuationReason) => string = (reason) =>
		reason === "length"
			? taskLengthContinuationPrompt
			: taskCompletionContinuationPrompt,
): Promise<TaskCompletionLoopResult> {
	throwIfTaskCompletionAborted(signal);
	let message = await execute(initialPrompt);
	throwIfTaskCompletionAborted(signal);
	let continuationCount = 0;
	while (
		(message.stopReason === "stop" || message.stopReason === "length") &&
		!isCompleted(message) &&
		continuationCount < maxTaskCompletionContinuations
	) {
		const reason = message.stopReason === "length" ? "length" : "completion";
		continuationCount++;
		await onContinuation(continuationCount, maxTaskCompletionContinuations, reason);
		throwIfTaskCompletionAborted(signal);
		message = await execute(selectContinuationPrompt(reason));
		throwIfTaskCompletionAborted(signal);
	}
	return {
		message,
		completed: isCompleted(message),
		continuationCount,
	};
}
