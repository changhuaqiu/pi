import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { VirtualTerminal } from "../../../packages/tui/test/virtual-terminal.ts";
import type { LogosAgentCacheStats } from "../src/cache-stats.ts";
import type { UserQuestionAction } from "../src/ask-user-tool.ts";
import type {
	CodeGraphWorkspaceOperationResult,
	CodeGraphWorkspaceStatus,
} from "../src/code-intelligence.ts";
import type {
	LogosAgent,
	LogosAgentCompactResult,
	LogosAgentContextInfo,
	LogosAgentSessionInfo,
	LogosAgentSessionListItem,
	LogosAgentUiEvent,
} from "../src/logos-agent.ts";
import type {
	ToolCapabilityKind,
	ToolPermission,
	ToolPolicyInfo,
} from "../src/tool-system.ts";
import type { TaskRunState } from "../src/task-run.ts";
import { LogosAgentTui } from "../src/tui-app.ts";
import {
	taskCompletionContinuationPrompt,
	taskLengthContinuationPrompt,
} from "../src/task-completion-tool.ts";

class CountingVirtualTerminal extends VirtualTerminal {
	writeCount = 0;

	override write(data: string): void {
		this.writeCount++;
		super.write(data);
	}
}

const emptyCacheStats: LogosAgentCacheStats = {
	requestCount: 0,
	telemetryRequestCount: 0,
	telemetryCoverage: undefined,
	promptTokens: 0,
	uncachedInputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	hitRate: undefined,
	latestHitRate: undefined,
};

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

class FakeLogosAgent implements LogosAgent {
	readonly prompts: string[] = [];
	messages: AgentMessage[] = [];
	readonly questionResponses: Array<{
		requestId: string;
		action: UserQuestionAction;
	}> = [];
	readonly toolPermissionChanges: Array<{
		toolName: string;
		permission: ToolPermission | undefined;
	}> = [];
	sessions: LogosAgentSessionListItem[] = [];
	toolPolicies: ToolPolicyInfo[] = [];
	codeGraphStatus: CodeGraphWorkspaceStatus = {
		availability: "ready",
		freshness: "fresh",
		version: "test",
	};
	codeGraphOperations: Array<"init" | "sync"> = [];
	sessionListStarted = false;
	sessionSwitchStarted = false;
	private listeners = new Set<(event: LogosAgentUiEvent) => void | Promise<void>>();
	private pending?: { resolve: (message: AssistantMessage) => void };
	private busy = false;
	private sessionListGate?: Promise<void>;
	private resolveSessionList?: () => void;
	private sessionSwitchGate?: Promise<void>;
	private resolveSessionSwitch?: () => void;
	private rejectSessionSwitch?: (error: Error) => void;
	private codeGraphOperationGate?: Promise<void>;
	private rejectCodeGraphOperation?: (error: Error) => void;
	private readonly policyResolvers: Array<{
		resolve: () => void;
		reject: (error: Error) => void;
	}> = [];

	delaySessionList(): void {
		this.sessionListGate = new Promise<void>((resolve) => {
			this.resolveSessionList = resolve;
		});
	}

	finishSessionList(): void {
		this.resolveSessionList?.();
	}

	delaySessionSwitch(): void {
		this.sessionSwitchGate = new Promise<void>((resolve, reject) => {
			this.resolveSessionSwitch = resolve;
			this.rejectSessionSwitch = reject;
		});
	}

	delayCodeGraphOperation(): void {
		this.codeGraphOperationGate = new Promise<void>((_resolve, reject) => {
			this.rejectCodeGraphOperation = reject;
		});
	}

	finishSessionSwitch(error?: Error): void {
		if (error) this.rejectSessionSwitch?.(error);
		else this.resolveSessionSwitch?.();
	}

	finishPolicyUpdate(error?: Error): void {
		const pending = this.policyResolvers.shift();
		assert.ok(pending, "expected a pending policy update");
		if (error) pending.reject(error);
		else pending.resolve();
	}

	hasPendingPrompt(): boolean {
		return this.pending !== undefined;
	}

	async prompt(text: string): Promise<AssistantMessage> {
		this.busy = true;
		this.prompts.push(text);
		await this.emit({
			type: "message_start",
			message: { role: "user", content: text, timestamp: Date.now() },
		});
		return await new Promise<AssistantMessage>((resolve) => {
			this.pending = { resolve };
		});
	}

	async finishPrompt(
		text = "done",
		stopReason: AssistantMessage["stopReason"] = "stop",
	): Promise<void> {
		const pending = this.pending;
		assert.ok(pending, "expected a pending prompt");
		const message = { ...assistantMessage(text), stopReason };
		await this.emit({ type: "message_start", message });
		await this.emit({ type: "message_end", message });
		await this.emit({ type: "agent_end", messages: [message] });
		this.pending = undefined;
		this.busy = false;
		pending.resolve(message);
	}

	async steer(text: string): Promise<void> {
		this.prompts.push(text);
	}

	async emitEvent(event: LogosAgentUiEvent): Promise<void> {
		await this.emit(event);
	}

	async abort(): Promise<void> {
		if (this.rejectCodeGraphOperation) {
			const error = new Error("Operation aborted");
			error.name = "AbortError";
			this.rejectCodeGraphOperation(error);
			this.rejectCodeGraphOperation = undefined;
			return;
		}
		if (!this.pending) return;
		const pending = this.pending;
		const message = { ...assistantMessage(""), stopReason: "aborted" as const };
		this.pending = undefined;
		this.busy = false;
		await this.emit({ type: "abort", clearedSteer: [], clearedFollowUp: [] });
		await this.emit({ type: "agent_end", messages: [message] });
		pending.resolve(message);
	}

	async shutdown(): Promise<void> {
		await this.abort();
	}

	async waitForIdle(): Promise<void> {}

	isBusy(): boolean {
		return this.busy;
	}

	subscribe(listener: (event: LogosAgentUiEvent) => void | Promise<void>): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	respondToApproval(): boolean {
		return false;
	}

	respondToQuestion(requestId: string, action: UserQuestionAction) {
		this.questionResponses.push({ requestId, action });
		return { accepted: true };
	}

	async getMessages(): Promise<AgentMessage[]> {
		return this.messages;
	}

	async getSessionInfo(): Promise<LogosAgentSessionInfo> {
		return { id: "session-current", path: "session.jsonl", messageCount: 0 };
	}

	async newSession(): Promise<LogosAgentSessionInfo> {
		return await this.getSessionInfo();
	}

	getModelId(): string {
		return "test-model";
	}

	getWorkspaceRoot(): string {
		return process.cwd();
	}

	async getCodeGraphStatus(): Promise<CodeGraphWorkspaceStatus> {
		return this.codeGraphStatus;
	}

	async initializeCodeGraph(): Promise<CodeGraphWorkspaceOperationResult> {
		this.codeGraphOperations.push("init");
		if (this.codeGraphOperationGate) {
			this.busy = true;
			try {
				await this.codeGraphOperationGate;
			} finally {
				this.codeGraphOperationGate = undefined;
				this.busy = false;
			}
		}
		this.codeGraphStatus = {
			availability: "ready",
			freshness: "fresh",
			version: "test",
			fileCount: 10,
			nodeCount: 20,
			edgeCount: 30,
		};
		return {
			operation: "init",
			output: "Indexed 10 files",
			truncated: false,
			status: this.codeGraphStatus,
		};
	}

	async syncCodeGraph(): Promise<CodeGraphWorkspaceOperationResult> {
		this.codeGraphOperations.push("sync");
		return {
			operation: "sync",
			output: "Index synchronized",
			truncated: false,
			status: this.codeGraphStatus,
		};
	}

	async listSessions(): Promise<LogosAgentSessionListItem[]> {
		this.sessionListStarted = true;
		await this.sessionListGate;
		return this.sessions;
	}

	async switchSession(): Promise<LogosAgentSessionInfo> {
		this.sessionSwitchStarted = true;
		this.busy = true;
		try {
			await this.sessionSwitchGate;
		} finally {
			this.busy = false;
		}
		return {
			id: this.sessions[0]?.id ?? "session-current",
			path: this.sessions[0]?.path ?? "session.jsonl",
			messageCount: this.sessions[0]?.messageCount ?? 0,
		};
	}

	async compact(): Promise<LogosAgentCompactResult> {
		return {
			status: "not_needed",
			tokensBefore: 0,
			tokensAfter: 0,
			tokensSaved: 0,
			restoreAvailable: false,
		};
	}

	async restoreLastCompaction(): Promise<LogosAgentContextInfo> {
		return await this.getContextInfo();
	}

	async getContextInfo(): Promise<LogosAgentContextInfo> {
		return { tokenCount: 0, contextWindow: 100_000, percent: 0 };
	}

	async getCacheStats(): Promise<LogosAgentCacheStats> {
		return emptyCacheStats;
	}

	async getCacheReport(): Promise<never> {
		throw new Error("not used by this TUI test");
	}

	async compareCacheReleases(): Promise<never> {
		throw new Error("not used by this TUI test");
	}

	getCacheRelease(): string {
		return "test-release";
	}

	getActiveTaskRunId(): string | undefined {
		return undefined;
	}

	async getTaskRun(): Promise<TaskRunState> {
		throw new Error("not used by this TUI test");
	}

	async listTaskRuns(): Promise<TaskRunState[]> {
		return [];
	}

	getToolPolicies(): ToolPolicyInfo[] {
		return this.toolPolicies;
	}

	async setToolPermission(
		toolName: string,
		permission: ToolPermission | undefined,
	): Promise<void> {
		this.toolPermissionChanges.push({ toolName, permission });
		this.busy = true;
		await new Promise<void>((resolve, reject) => {
			this.policyResolvers.push({
				resolve: () => {
					this.busy = false;
					resolve();
				},
				reject: (error) => {
					this.busy = false;
					reject(error);
				},
			});
		});
	}

	async setCapabilityPermission(
		_capability: ToolCapabilityKind,
		_permission: ToolPermission | undefined,
	): Promise<void> {}

	private async emit(event: LogosAgentUiEvent): Promise<void> {
		for (const listener of this.listeners) await listener(event);
	}
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for TUI state");
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

test("busy Logos Agent queues guidance and runs it after the active turn", async () => {
	const agent = new FakeLogosAgent();
	const terminal = new VirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();
	assert.match(terminal.getViewport().join("\n"), /LEARNING GOAL/);

	terminal.sendInput("inspect the approval flow");
	terminal.sendInput("\r");
	await waitFor(() => agent.prompts.length === 1);
	await terminal.waitForRender();
	assert.match(terminal.getViewport().join("\n"), /GUIDANCE/);
	assert.match(
		terminal.getViewport().join("\n"),
		/Nebulizing.*thought for \d+s/,
	);
	assert.match(terminal.getViewport().join("\n"), /Tip:/);

	terminal.sendInput("then explain the evidence");
	terminal.sendInput("\r");
	await terminal.waitForRender();
	assert.match(terminal.getScrollBuffer().join("\n"), /queued guidance 1/);

	await agent.finishPrompt("first complete");
	await waitFor(() => agent.prompts.length === 2);
	assert.equal(agent.prompts[1], "then explain the evidence");

	await agent.finishPrompt("second complete");
	await waitFor(() => !agent.isBusy());
	await waitFor(() =>
		!terminal.getViewport().join("\n").includes("Nebulizing"),
	);
	terminal.sendInput("\x04");
	await running;
});

test("ordinary conversation does not print an empty logos loop", async () => {
	const agent = new FakeLogosAgent();
	const terminal = new VirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	terminal.sendInput("你好");
	terminal.sendInput("\r");
	await waitFor(() => agent.hasPendingPrompt());
	await agent.finishPrompt("你好，有什么可以帮你的？");
	await terminal.waitForRender();

	const transcript = terminal.getScrollBuffer().join("\n");
	assert.match(transcript, /你好，有什么可以帮你的/);
	assert.doesNotMatch(transcript, /logos loop/);
	assert.doesNotMatch(transcript, /task not explicitly completed/);

	terminal.sendInput("\x04");
	await running;
});

test("repeated apply_edit calls from one assistant message share one transcript block", async () => {
	const agent = new FakeLogosAgent();
	const terminal = new VirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	const calls = ["apply-a", "apply-b", "apply-c", "apply-d"].map(
		(id, index) => ({
			type: "toolCall" as const,
			id,
			name: "apply_edit",
			arguments: { proposalId: `proposal-${index}` },
		}),
	);
	const message: AssistantMessage = {
		...assistantMessage(""),
		content: calls,
		stopReason: "toolUse",
	};
	await agent.emitEvent({ type: "message_start", message });
	await agent.emitEvent({ type: "message_end", message });
	for (const [index, call] of calls.entries()) {
		await agent.emitEvent({
			type: "tool_execution_start",
			toolCallId: call.id,
			toolName: call.name,
			args: call.arguments,
		});
		await agent.emitEvent({
			type: "tool_execution_end",
			toolCallId: call.id,
			toolName: call.name,
			result: {
				content: [{
					type: "text",
					text: `Applied delete proposal proposal-${index} to "src/core/file-${index}.ts".`,
				}],
				details: { stage: "completed", path: `src/core/file-${index}.ts` },
			},
			isError: false,
		});
	}
	await terminal.waitForRender();

	const transcript = terminal.getViewport().join("\n");
	assert.equal(transcript.match(/Apply\(4 edits\)/gu)?.length, 1);
	assert.doesNotMatch(transcript, /Apply\(proposal-/u);
	for (const index of [0, 1, 2, 3]) {
		assert.match(transcript, new RegExp(`src/core/file-${index}\\.ts`, "u"));
	}

	terminal.sendInput("\x04");
	await running;
});

test("saved session history preserves apply_edit batching", async () => {
	const agent = new FakeLogosAgent();
	const calls = ["history-a", "history-b"].map((id, index) => ({
		type: "toolCall" as const,
		id,
		name: "apply_edit",
		arguments: { proposalId: `history-proposal-${index}` },
	}));
	agent.messages = [
		{
			...assistantMessage(""),
			content: calls,
			stopReason: "toolUse",
		},
		...calls.map((call, index) => ({
			role: "toolResult" as const,
			toolCallId: call.id,
			toolName: call.name,
			content: [{
				type: "text" as const,
				text: `Applied delete proposal history-proposal-${index} to "src/history-${index}.ts".`,
			}],
			details: { stage: "completed", path: `src/history-${index}.ts` },
			isError: false,
			timestamp: Date.now() + index,
		})),
	];
	const terminal = new VirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	const transcript = terminal.getViewport().join("\n");
	assert.equal(transcript.match(/Apply\(2 edits\)/gu)?.length, 1);
	assert.match(transcript, /src\/history-0\.ts/u);
	assert.match(transcript, /src\/history-1\.ts/u);

	terminal.sendInput("\x04");
	await running;
});

test("internal continuation events are visible without rendering control prompts as user input", async () => {
	const agent = new FakeLogosAgent();
	const terminal = new VirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	terminal.sendInput("write the implementation");
	terminal.sendInput("\r");
	await waitFor(() => agent.hasPendingPrompt());
	await agent.finishPrompt("partial one", "length");
	await terminal.waitForRender();
	assert.deepEqual(agent.prompts, ["write the implementation"]);

	await agent.emitEvent({
		type: "task_completion_retry",
		attempt: 1,
		maxAttempts: 2,
		reason: "length",
		mode: "task",
	});
	const internalPrompt = agent.prompt(taskLengthContinuationPrompt);
	await waitFor(() => agent.hasPendingPrompt());
	await terminal.waitForRender();
	assert.doesNotMatch(
		terminal.getScrollBuffer().join("\n"),
		/You\s+Continue the current response from where it was truncated/,
	);
	assert.match(
		terminal.getScrollBuffer().join("\n"),
		/response truncated; continuing within the current task \(1\/2\)/,
	);
	await agent.finishPrompt();
	await internalPrompt;

	await agent.emitEvent({
		type: "task_completion_retry",
		attempt: 2,
		maxAttempts: 2,
		reason: "completion",
		mode: "task",
	});
	const completionPrompt = agent.prompt(taskCompletionContinuationPrompt);
	await waitFor(() => agent.hasPendingPrompt());
	await terminal.waitForRender();
	assert.doesNotMatch(
		terminal.getScrollBuffer().join("\n"),
		/You\s+Continue executing the current user task now/,
	);
	await agent.finishPrompt();
	await completionPrompt;

	terminal.sendInput("\x04");
	await running;
});

test("final provider redaction removes streamed reasoning from the active transcript", async () => {
	const agent = new FakeLogosAgent();
	const terminal = new VirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	const visible = {
		...assistantMessage("working"),
		content: [
			{ type: "thinking" as const, thinking: "temporary-private-reasoning" },
			{ type: "text" as const, text: "working" },
		],
	};
	await agent.emitEvent({ type: "message_start", message: visible });
	await terminal.waitForRender();
	assert.match(terminal.getViewport().join("\n"), /temporary-private-reasoning/);

	await agent.emitEvent({
		type: "message_end",
		message: {
			...visible,
			content: [
				{
					type: "thinking",
					thinking: "temporary-private-reasoning",
					redacted: true,
					thinkingSignature: "opaque",
				},
				{ type: "text", text: "working" },
			],
		},
	});
	await terminal.waitForRender();
	assert.doesNotMatch(terminal.getViewport().join("\n"), /temporary-private-reasoning/);

	terminal.sendInput("\x04");
	await running;
});

test("successful finish_task stays internal and the final assistant summary is shown", async () => {
	const agent = new FakeLogosAgent();
	const terminal = new VirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	const finishMessage: AssistantMessage = {
		...assistantMessage("DUPLICATE_PRE_TOOL_SUMMARY"),
		content: [
			{ type: "text", text: "DUPLICATE_PRE_TOOL_SUMMARY" },
			{
				type: "toolCall",
				id: "finish-1",
				name: "finish_task",
				arguments: { summary: "INTERNAL_FINISH_ARGUMENT" },
			},
		],
		stopReason: "toolUse",
	};
	await agent.emitEvent({ type: "message_start", message: finishMessage });
	await agent.emitEvent({ type: "message_end", message: finishMessage });
	await agent.emitEvent({
		type: "tool_execution_start",
		toolCallId: "finish-1",
		toolName: "finish_task",
		args: { summary: "INTERNAL_FINISH_ARGUMENT" },
	});
	await agent.emitEvent({
		type: "tool_execution_end",
		toolCallId: "finish-1",
		toolName: "finish_task",
		result: {
			content: [{ type: "text", text: "Task completion recorded" }],
			details: { stage: "completed", summary: "INTERNAL_FINISH_ARGUMENT" },
		},
		isError: false,
	});
	const summary = assistantMessage("Completed normally with a user-facing summary.");
	await agent.emitEvent({ type: "message_start", message: summary });
	await agent.emitEvent({ type: "message_end", message: summary });
	await terminal.waitForRender();

	const transcript = terminal.getViewport().join("\n");
	assert.match(transcript, /Completed normally with a user-facing summary/);
	assert.doesNotMatch(
		transcript,
		/finish_task|INTERNAL_FINISH_ARGUMENT|DUPLICATE_PRE_TOOL_SUMMARY/,
	);

	terminal.sendInput("\x04");
	await running;
});

test("finish_task remains visible when it is mixed with another tool call", async () => {
	const agent = new FakeLogosAgent();
	const terminal = new VirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	const mixedMessage: AssistantMessage = {
		...assistantMessage(""),
		content: [
			{
				type: "toolCall",
				id: "mixed-finish",
				name: "finish_task",
				arguments: { summary: "MIXED_FINISH_DIAGNOSTIC" },
			},
			{
				type: "toolCall",
				id: "mixed-read",
				name: "read_file",
				arguments: { path: "README.md" },
			},
		],
		stopReason: "toolUse",
	};
	await agent.emitEvent({ type: "message_start", message: mixedMessage });
	await agent.emitEvent({ type: "message_end", message: mixedMessage });
	await agent.emitEvent({
		type: "tool_execution_start",
		toolCallId: "mixed-finish",
		toolName: "finish_task",
		args: { summary: "MIXED_FINISH_DIAGNOSTIC" },
	});
	await agent.emitEvent({
		type: "tool_execution_end",
		toolCallId: "mixed-finish",
		toolName: "finish_task",
		result: {
			content: [{ type: "text", text: "Task completion recorded" }],
			details: { stage: "completed", summary: "MIXED_FINISH_DIAGNOSTIC" },
		},
		isError: false,
	});
	await terminal.waitForRender();

	const transcript = terminal.getViewport().join("\n");
	assert.match(transcript, /finish_task/);
	assert.match(transcript, /Task completion recorded/);

	terminal.sendInput("\x04");
	await running;
});

test("saved session history hides finish_task and keeps its final assistant summary", async () => {
	const agent = new FakeLogosAgent();
	agent.messages = [
		{
			...assistantMessage("DUPLICATE_HISTORY_SUMMARY"),
			content: [
				{ type: "text", text: "DUPLICATE_HISTORY_SUMMARY" },
				{
					type: "toolCall",
					id: "finish-history-1",
					name: "finish_task",
					arguments: { summary: "HIDDEN_HISTORY_ARGUMENT" },
				},
			],
			stopReason: "toolUse",
		},
		{
			role: "toolResult",
			toolCallId: "finish-history-1",
			toolName: "finish_task",
			content: [{ type: "text", text: "Task completion recorded" }],
			details: { stage: "completed", summary: "HIDDEN_HISTORY_ARGUMENT" },
			isError: false,
			timestamp: Date.now(),
		},
		assistantMessage("Saved final summary remains visible."),
	];
	const terminal = new VirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	const transcript = terminal.getViewport().join("\n");
	assert.match(transcript, /Saved final summary remains visible/);
	assert.doesNotMatch(
		transcript,
		/finish_task|HIDDEN_HISTORY_ARGUMENT|DUPLICATE_HISTORY_SUMMARY/,
	);

	terminal.sendInput("\x04");
	await running;
});

test("saved session history keeps failed finish_task visible", async () => {
	const agent = new FakeLogosAgent();
	agent.messages = [
		{
			...assistantMessage(""),
			content: [
				{
					type: "toolCall",
					id: "finish-history-error",
					name: "finish_task",
					arguments: { summary: "Could not complete" },
				},
			],
			stopReason: "toolUse",
		},
		{
			role: "toolResult",
			toolCallId: "finish-history-error",
			toolName: "finish_task",
			content: [{ type: "text", text: "Completion rejected by policy" }],
			details: {},
			isError: true,
			timestamp: Date.now(),
		},
	];
	const terminal = new VirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	const transcript = terminal.getViewport().join("\n");
	assert.match(transcript, /finish_task/);
	assert.match(transcript, /Completion rejected by policy/);

	terminal.sendInput("\x04");
	await running;
});

test("agent questions route a selected choice to the waiting tool", async () => {
	const agent = new FakeLogosAgent();
	const terminal = new VirtualTerminal(100, 32);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	terminal.sendInput("design the deployment");
	terminal.sendInput("\r");
	await waitFor(() => agent.hasPendingPrompt());
	terminal.sendInput("keep this draft");
	await agent.emitEvent({
		type: "question_request",
		request: {
			id: "question-1",
			question: "Which environment should receive the deployment?",
			context: "No target environment is configured.",
			options: [
				{ label: "Staging", description: "Deploy for validation" },
				{ label: "Production", description: "Deploy to users" },
			],
		},
	});
	await terminal.waitForRender();
	const questionView = terminal.getViewport().join("\n");
	assert.match(questionView, /Agent needs clarification/);
	assert.match(questionView, /Which environment/);
	assert.match(questionView, /1\. Staging/);
	assert.match(questionView, /Type something/);
	assert.match(questionView, /Chat about this/);
	assert.match(questionView, /Do not paste passwords/);

	terminal.sendInput("\x1b[B");
	terminal.sendInput("\r");
	await waitFor(() => agent.questionResponses.length === 1);
	assert.deepEqual(agent.questionResponses, [
		{
			requestId: "question-1",
			action: { kind: "answer", answer: "Production", source: "option" },
		},
	]);
	assert.deepEqual(agent.prompts, ["design the deployment"]);
	assert.doesNotMatch(
		terminal.getScrollBuffer().join("\n"),
		/queued guidance 1/,
	);

	await agent.emitEvent({
		type: "question_resolved",
		requestId: "question-1",
		outcome: "answer",
	});
	await agent.finishPrompt();
	terminal.sendInput("\r");
	await waitFor(() => agent.prompts.length === 2);
	assert.equal(agent.prompts[1], "keep this draft");
	await agent.finishPrompt();
	terminal.sendInput("\x04");
	await running;
});

test("Chat about this resolves the question without fabricating an answer", async () => {
	const agent = new FakeLogosAgent();
	const terminal = new VirtualTerminal(100, 32);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	terminal.sendInput("active prompt");
	terminal.sendInput("\r");
	await waitFor(() => agent.hasPendingPrompt());
	terminal.sendInput("keep this draft");
	await agent.emitEvent({
		type: "question_request",
		request: { id: "question-discuss", question: "Which architecture?" },
	});
	terminal.sendInput("\x1b[B");
	terminal.sendInput("\r");
	await waitFor(() => agent.questionResponses.length === 1);
	assert.deepEqual(agent.questionResponses, [
		{ requestId: "question-discuss", action: { kind: "discuss" } },
	]);
	await terminal.waitForRender();
	assert.match(
		terminal.getScrollBuffer().join("\n"),
		/switched to chat about the question/,
	);

	await agent.emitEvent({
		type: "question_resolved",
		requestId: "question-discuss",
		outcome: "discuss",
	});
	await agent.finishPrompt();
	terminal.sendInput("\r");
	await waitFor(() => agent.prompts.length === 2);
	assert.equal(agent.prompts[1], "keep this draft");
	await agent.finishPrompt();
	terminal.sendInput("\x04");
	await running;
});

test("cancelling an agent question discards a partial answer", async () => {
	const agent = new FakeLogosAgent();
	const terminal = new VirtualTerminal(100, 32);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	terminal.sendInput("active prompt");
	terminal.sendInput("\r");
	await waitFor(() => agent.hasPendingPrompt());
	await agent.emitEvent({
		type: "question_request",
		request: { id: "question-1", question: "Choose?" },
	});
	terminal.sendInput("discard this answer");
	await agent.emitEvent({
		type: "question_resolved",
		requestId: "question-1",
		outcome: "cancel",
	});
	await agent.finishPrompt();
	terminal.sendInput("\r");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(agent.prompts, ["active prompt"]);
	terminal.sendInput("\x04");
	await running;
});

test("cancelling an agent question restores only the held draft", async () => {
	const agent = new FakeLogosAgent();
	const terminal = new VirtualTerminal(100, 32);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	terminal.sendInput("active prompt");
	terminal.sendInput("\r");
	await waitFor(() => agent.hasPendingPrompt());
	terminal.sendInput("keep this draft");
	await agent.emitEvent({
		type: "question_request",
		request: { id: "question-1", question: "Choose?" },
	});
	terminal.sendInput("discard this answer");
	await agent.emitEvent({
		type: "question_resolved",
		requestId: "question-1",
		outcome: "cancel",
	});
	await agent.finishPrompt();
	terminal.sendInput("\r");
	await waitFor(() => agent.prompts.length === 2);
	assert.equal(agent.prompts[1], "keep this draft");
	await agent.finishPrompt();
	terminal.sendInput("\x04");
	await running;
});

test("an unmatched question resolution does not alter the editor draft", async () => {
	const agent = new FakeLogosAgent();
	const terminal = new VirtualTerminal(100, 32);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	terminal.sendInput("keep unrelated draft");
	await agent.emitEvent({
		type: "question_resolved",
		requestId: "question-never-presented",
		outcome: "cancel",
	});
	terminal.sendInput("\r");
	await waitFor(() => agent.prompts.length === 1);
	await waitFor(() => agent.hasPendingPrompt());
	assert.equal(agent.prompts[0], "keep unrelated draft");
	await agent.finishPrompt();
	terminal.sendInput("\x04");
	await running;
});

test("activity animation advances, throttles review, and stops after abort", async () => {
	const agent = new FakeLogosAgent();
	const terminal = new CountingVirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	terminal.sendInput("inspect safely");
	terminal.sendInput("\r");
	await waitFor(() => agent.hasPendingPrompt());
	await waitFor(() =>
		/[✢✣✤✥].*thought for/.test(terminal.getViewport().join("\n")),
	);
	const firstFrame = terminal
		.getViewport()
		.join("\n")
		.match(/([✢✣✤✥]).*thought for/)?.[1];
	assert.ok(firstFrame);
	await waitFor(() => {
		const frame = terminal
			.getViewport()
			.join("\n")
			.match(/([✢✣✤✥]).*thought for/)?.[1];
		return frame !== undefined && frame !== firstFrame;
	});

	await agent.emitEvent({
		type: "approval_request",
		request: {
			id: "approval-1",
			subject: {
				kind: "directories",
				paths: [
					"src/core",
					"src/components",
					"src/hooks",
					"src/styles",
				],
			},
		},
	});
	await terminal.waitForRender();
	assert.match(terminal.getViewport().join("\n"), /Directory creation review/);
	assert.match(terminal.getViewport().join("\n"), /src\/core/);
	const writesBeforeReviewWait = terminal.writeCount;
	await new Promise<void>((resolve) => setTimeout(resolve, 350));
	await terminal.flush();
	assert.ok(
		terminal.writeCount - writesBeforeReviewWait <= 1,
		"review state should not repaint at spinner cadence",
	);

	await agent.emitEvent({
		type: "approval_resolved",
		requestId: "approval-1",
		subjectKind: "directories",
		approved: false,
	});
	terminal.sendInput("\x1b");
	await waitFor(() => !agent.isBusy());
	await terminal.waitForRender();
	assert.doesNotMatch(
		terminal.getViewport().join("\n"),
		/thought for|worked for|waited for/,
	);

	await new Promise<void>((resolve) => setTimeout(resolve, 100));
	await terminal.flush();
	const writesAfterAbort = terminal.writeCount;
	await new Promise<void>((resolve) => setTimeout(resolve, 300));
	await terminal.flush();
	assert.equal(terminal.writeCount, writesAfterAbort);

	terminal.sendInput("\x04");
	await running;
});

test("multiline input keeps arrow navigation inside the draft", async () => {
	const agent = new FakeLogosAgent();
	const terminal = new VirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	terminal.sendInput("top");
	terminal.sendInput("\x1b[13;2~");
	terminal.sendInput("bottom");
	terminal.sendInput("\x1b[A");
	terminal.sendInput("X");
	terminal.sendInput("\r");
	await waitFor(() => agent.prompts.length === 1);
	assert.equal(agent.prompts[0], "topX\nbottom");

	await waitFor(() => agent.hasPendingPrompt());
	await agent.finishPrompt();
	terminal.sendInput("\x04");
	await running;
});

test("input hint exposes command arguments and confined workspace references", async () => {
	const agent = new FakeLogosAgent();
	const terminal = new VirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	terminal.sendInput("/");
	await waitFor(() =>
		terminal.getViewport().join("\n").includes("COMMAND"),
	);
	assert.match(terminal.getViewport().join("\n"), /<session-id>/);

	terminal.sendInput("\x1b");
	terminal.sendInput("\x15");
	terminal.sendInput("@src/logos-i");
	await waitFor(() =>
		terminal.getViewport().join("\n").includes("logos-input.ts"),
	);
	assert.match(terminal.getViewport().join("\n"), /REFERENCE/);
	assert.match(terminal.getViewport().join("\n"), /logos-input\.ts/);

	terminal.sendInput("\x1b");
	terminal.sendInput("\x15");
	terminal.sendInput("@missing-reference");
	terminal.sendInput("\r");
	await waitFor(() => agent.prompts.length === 1);
	await waitFor(() => agent.hasPendingPrompt());
	await agent.finishPrompt();
	await waitFor(() =>
		terminal.getViewport().join("\n").includes("LEARNING GOAL"),
	);

	terminal.sendInput("\x04");
	await running;
});

test("/workspace reports the active opened directory", async () => {
	const agent = new FakeLogosAgent();
	const terminal = new VirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	terminal.sendInput("/workspace");
	terminal.sendInput("\r");
	await waitFor(() =>
		terminal
			.getScrollBuffer()
			.join("\n")
			.includes(`workspace ${agent.getWorkspaceRoot()}`),
	);

	terminal.sendInput("\x04");
	await running;
});

test("a new workspace advertises and runs explicit CodeGraph initialization", async () => {
	const agent = new FakeLogosAgent();
	agent.codeGraphStatus = {
		availability: "unindexed",
		freshness: "unknown",
		reason: "No local CodeGraph index exists for this workspace",
	};
	const terminal = new VirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();
	assert.match(
		terminal.getScrollBuffer().join("\n"),
		/run \/codegraph init to build the local index/,
	);

	terminal.sendInput("/codegraph init");
	terminal.sendInput("\r");
	await waitFor(() => agent.codeGraphOperations.length === 1);
	await terminal.waitForRender();
	assert.deepEqual(agent.codeGraphOperations, ["init"]);
	assert.match(terminal.getScrollBuffer().join("\n"), /codegraph init completed/);
	assert.match(terminal.getScrollBuffer().join("\n"), /10 files · 20 nodes · 30 edges/);

	terminal.sendInput("\x04");
	await running;
});

test("CodeGraph initialization is cancelled when the user aborts the busy command", async () => {
	const agent = new FakeLogosAgent();
	agent.delayCodeGraphOperation();
	const terminal = new VirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	terminal.sendInput("/codegraph init");
	terminal.sendInput("\r");
	await waitFor(() => agent.isBusy());
	terminal.sendInput("\x1b");
	await waitFor(() => !agent.isBusy());
	await terminal.waitForRender();
	assert.match(
		terminal.getScrollBuffer().join("\n"),
		/command error: Operation aborted/,
	);

	terminal.sendInput("\x04");
	await running;
});

test("session picker waits for listing and switching before draining queued guidance", async () => {
	const agent = new FakeLogosAgent();
	agent.sessions = [
		{
			id: "session-target",
			path: "target.jsonl",
			messageCount: 3,
			createdAt: "2026-07-29T10:00:00.000Z",
			preview: "Review the logos loop",
		},
	];
	agent.delaySessionList();
	agent.delaySessionSwitch();
	const terminal = new VirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	terminal.sendInput("/sessions");
	terminal.sendInput("\r");
	await waitFor(() => agent.sessionListStarted);
	terminal.sendInput("guidance after switching");
	terminal.sendInput("\r");
	agent.finishSessionList();
	await terminal.waitForRender();
	assert.equal(agent.prompts.length, 0);

	terminal.sendInput("\r");
	await waitFor(() => agent.sessionSwitchStarted);
	assert.equal(agent.prompts.length, 0);
	agent.finishSessionSwitch();
	await waitFor(() => agent.prompts.length === 1);
	assert.equal(agent.prompts[0], "guidance after switching");

	await agent.finishPrompt();
	terminal.sendInput("\x04");
	await running;
});

test("multiple tool policy changes settle before queued guidance starts", async () => {
	const agent = new FakeLogosAgent();
	agent.toolPolicies = [
		{
			name: "read_file",
			capabilities: [{ kind: "fs.read", scope: "workspace" }],
			defaultPermission: "allow",
			effectivePermission: "allow",
			active: true,
		},
	];
	const terminal = new VirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	terminal.sendInput("/permissions");
	terminal.sendInput("\r");
	await terminal.waitForRender();
	terminal.sendInput(" ");
	terminal.sendInput(" ");
	terminal.sendInput("\x1b");
	terminal.sendInput("guidance after policy update");
	terminal.sendInput("\r");

	await waitFor(() => agent.toolPermissionChanges.length === 1);
	assert.equal(agent.prompts.length, 0);
	agent.finishPolicyUpdate();
	await waitFor(() => agent.toolPermissionChanges.length === 2);
	assert.equal(agent.prompts.length, 0);
	agent.finishPolicyUpdate();
	await waitFor(() => agent.prompts.length === 1);
	assert.deepEqual(agent.toolPermissionChanges, [
		{ toolName: "read_file", permission: "ask" },
		{ toolName: "read_file", permission: "deny" },
	]);

	await agent.finishPrompt();
	terminal.sendInput("\x04");
	await running;
});

test("failed session switching retains guidance instead of running it in the old session", async () => {
	const agent = new FakeLogosAgent();
	agent.sessions = [
		{
			id: "session-missing",
			path: "missing.jsonl",
			messageCount: 1,
			createdAt: "2026-07-29T10:00:00.000Z",
			preview: "Missing target",
		},
	];
	agent.delaySessionSwitch();
	const terminal = new VirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	terminal.sendInput("/sessions");
	terminal.sendInput("\r");
	await waitFor(() =>
		terminal.getScrollBuffer().join("\n").includes("Resume a logos session"),
	);
	terminal.sendInput("\r");
	await waitFor(() => agent.sessionSwitchStarted);
	terminal.sendInput("guidance for missing session");
	terminal.sendInput("\r");
	agent.finishSessionSwitch(new Error("session disappeared"));
	await waitFor(() =>
		terminal.getScrollBuffer().join("\n").includes("session error"),
	);
	await new Promise<void>((resolve) => setTimeout(resolve, 25));
	assert.equal(agent.prompts.length, 0);
	assert.match(
		terminal.getScrollBuffer().join("\n"),
		/queued guidance retained/,
	);
	assert.match(terminal.getViewport().join("\n"), /SESSION BLOCKED/);

	terminal.sendInput("\x04");
	await running;
});

test("failed policy tightening retains guidance under the previous policy", async () => {
	const agent = new FakeLogosAgent();
	agent.toolPolicies = [
		{
			name: "read_file",
			capabilities: [{ kind: "fs.read", scope: "workspace" }],
			defaultPermission: "allow",
			effectivePermission: "allow",
			active: true,
		},
	];
	const terminal = new VirtualTerminal(100, 30);
	const app = new LogosAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	terminal.sendInput("/permissions");
	terminal.sendInput("\r");
	await terminal.waitForRender();
	terminal.sendInput(" ");
	terminal.sendInput("\x1b");
	terminal.sendInput("guidance requiring tightened policy");
	terminal.sendInput("\r");
	await waitFor(() => agent.toolPermissionChanges.length === 1);
	agent.finishPolicyUpdate(new Error("policy apply failed"));
	await waitFor(() =>
		terminal.getScrollBuffer().join("\n").includes("tool policy error"),
	);
	await new Promise<void>((resolve) => setTimeout(resolve, 25));
	assert.equal(agent.prompts.length, 0);
	assert.match(
		terminal.getScrollBuffer().join("\n"),
		/queued guidance retained/,
	);
	assert.match(terminal.getViewport().join("\n"), /POLICY BLOCKED/);

	terminal.sendInput("\x04");
	await running;
});
