export type LearningInputMode =
	| "ready"
	| "draft"
	| "command"
	| "reference"
	| "guidance"
	| "blocked";

export interface LearningInputContext {
	text: string;
	agentBusy: boolean;
	commandRunning: boolean;
	drainingQueue: boolean;
	pendingPolicyUpdates: number;
	policyUpdateFailed: boolean;
	sessionSwitchFailed: boolean;
	queuedCount: number;
	referenceCompletionActive: boolean;
}

export interface LearningInputDescriptor {
	mode: LearningInputMode;
	label: string;
	help: string;
}

function promptSize(text: string): string {
	const lines = text.split("\n").length;
	const characters = Array.from(text).length;
	return `${lines} line${lines === 1 ? "" : "s"} · ${characters} chars`;
}

function queuedSuffix(count: number): string {
	return count > 0 ? ` · ${count} queued` : "";
}

export function describeLearningInput(
	context: LearningInputContext,
): LearningInputDescriptor {
	const text = context.text;
	if (text.trimStart().startsWith("/")) {
		return {
			mode: "command",
			label: "COMMAND",
			help: "↑↓ choose · Tab/Enter complete · Esc close",
		};
	}
	if (context.sessionSwitchFailed) {
		return {
			mode: "blocked",
			label: "SESSION BLOCKED",
			help: `guidance stays queued until /sessions or /switch succeeds${queuedSuffix(context.queuedCount)}`,
		};
	}
	if (context.policyUpdateFailed) {
		return {
			mode: "blocked",
			label: "POLICY BLOCKED",
			help: `guidance stays queued until /permissions applies successfully${queuedSuffix(context.queuedCount)}`,
		};
	}
	if (
		context.agentBusy ||
		context.commandRunning ||
		context.drainingQueue ||
		context.pendingPolicyUpdates > 0
	) {
		const action = context.agentBusy
			? "Enter queues after the current step · Esc interrupts"
			: "Enter queues until the current operation completes";
		return {
			mode: "guidance",
			label: "GUIDANCE",
			help: `${action}${queuedSuffix(context.queuedCount)}`,
		};
	}
	if (context.referenceCompletionActive) {
		return {
			mode: "reference",
			label: "REFERENCE",
			help: "type a workspace path · ↑↓ choose · Tab/Enter complete",
		};
	}
	if (text.length > 0) {
		return {
			mode: "draft",
			label: "PROMPT",
			help: `${promptSize(text)} · Enter send · Shift+Enter/Ctrl+J newline`,
		};
	}
	return {
		mode: "ready",
		label: "LEARNING GOAL",
		help: "describe the outcome, evidence, and acceptance criteria · / commands · @ files",
	};
}
