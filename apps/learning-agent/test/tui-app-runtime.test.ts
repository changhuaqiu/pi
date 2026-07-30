import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { VirtualTerminal } from "../../../packages/tui/test/virtual-terminal.ts";
import type { LearningAgentCacheStats } from "../src/cache-stats.ts";
import type {
	LearningAgent,
	LearningAgentCompactResult,
	LearningAgentContextInfo,
	LearningAgentSessionInfo,
	LearningAgentSessionListItem,
	LearningAgentUiEvent,
} from "../src/learning-agent.ts";
import type {
	ToolCapabilityKind,
	ToolPermission,
	ToolPolicyInfo,
} from "../src/tool-system.ts";
import type { TaskRunState } from "../src/task-run.ts";
import { LearningAgentTui } from "../src/tui-app.ts";

class CountingVirtualTerminal extends VirtualTerminal {
	writeCount = 0;

	override write(data: string): void {
		this.writeCount++;
		super.write(data);
	}
}

const emptyCacheStats: LearningAgentCacheStats = {
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

class FakeLearningAgent implements LearningAgent {
	readonly prompts: string[] = [];
	readonly toolPermissionChanges: Array<{
		toolName: string;
		permission: ToolPermission | undefined;
	}> = [];
	sessions: LearningAgentSessionListItem[] = [];
	toolPolicies: ToolPolicyInfo[] = [];
	sessionListStarted = false;
	sessionSwitchStarted = false;
	private listeners = new Set<(event: LearningAgentUiEvent) => void | Promise<void>>();
	private pending?: { resolve: (message: AssistantMessage) => void };
	private busy = false;
	private sessionListGate?: Promise<void>;
	private resolveSessionList?: () => void;
	private sessionSwitchGate?: Promise<void>;
	private resolveSessionSwitch?: () => void;
	private rejectSessionSwitch?: (error: Error) => void;
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

	async finishPrompt(text = "done"): Promise<void> {
		const pending = this.pending;
		assert.ok(pending, "expected a pending prompt");
		const message = assistantMessage(text);
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

	async emitEvent(event: LearningAgentUiEvent): Promise<void> {
		await this.emit(event);
	}

	async abort(): Promise<void> {
		if (!this.pending) return;
		const pending = this.pending;
		const message = { ...assistantMessage(""), stopReason: "aborted" as const };
		this.pending = undefined;
		this.busy = false;
		await this.emit({ type: "abort", clearedSteer: [], clearedFollowUp: [] });
		await this.emit({ type: "agent_end", messages: [message] });
		pending.resolve(message);
	}

	async waitForIdle(): Promise<void> {}

	isBusy(): boolean {
		return this.busy;
	}

	subscribe(listener: (event: LearningAgentUiEvent) => void | Promise<void>): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	respondToApproval(): boolean {
		return false;
	}

	async getMessages(): Promise<AgentMessage[]> {
		return [];
	}

	async getSessionInfo(): Promise<LearningAgentSessionInfo> {
		return { id: "session-current", path: "session.jsonl", messageCount: 0 };
	}

	async newSession(): Promise<LearningAgentSessionInfo> {
		return await this.getSessionInfo();
	}

	getModelId(): string {
		return "test-model";
	}

	getWorkspaceRoot(): string {
		return process.cwd();
	}

	async listSessions(): Promise<LearningAgentSessionListItem[]> {
		this.sessionListStarted = true;
		await this.sessionListGate;
		return this.sessions;
	}

	async switchSession(): Promise<LearningAgentSessionInfo> {
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

	async compact(): Promise<LearningAgentCompactResult> {
		return {
			status: "not_needed",
			tokensBefore: 0,
			tokensAfter: 0,
			tokensSaved: 0,
			restoreAvailable: false,
		};
	}

	async restoreLastCompaction(): Promise<LearningAgentContextInfo> {
		return await this.getContextInfo();
	}

	async getContextInfo(): Promise<LearningAgentContextInfo> {
		return { tokenCount: 0, contextWindow: 100_000, percent: 0 };
	}

	async getCacheStats(): Promise<LearningAgentCacheStats> {
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

	private async emit(event: LearningAgentUiEvent): Promise<void> {
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

test("busy Learning Agent queues guidance and runs it after the active turn", async () => {
	const agent = new FakeLearningAgent();
	const terminal = new VirtualTerminal(100, 30);
	const app = new LearningAgentTui(agent, terminal);
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

test("activity animation advances, throttles review, and stops after abort", async () => {
	const agent = new FakeLearningAgent();
	const terminal = new CountingVirtualTerminal(100, 30);
	const app = new LearningAgentTui(agent, terminal);
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
				kind: "tool",
				toolName: "read_file",
				capabilities: [{ kind: "fs.read", scope: "workspace" }],
			},
		},
	});
	await terminal.waitForRender();
	assert.match(terminal.getViewport().join("\n"), /Awaiting review/);
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
		subjectKind: "tool",
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
	const agent = new FakeLearningAgent();
	const terminal = new VirtualTerminal(100, 30);
	const app = new LearningAgentTui(agent, terminal);
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
	const agent = new FakeLearningAgent();
	const terminal = new VirtualTerminal(100, 30);
	const app = new LearningAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	terminal.sendInput("/");
	await waitFor(() =>
		terminal.getViewport().join("\n").includes("COMMAND"),
	);
	assert.match(terminal.getViewport().join("\n"), /<session-id>/);

	terminal.sendInput("\x1b");
	terminal.sendInput("\x15");
	terminal.sendInput("@src/learning-i");
	await waitFor(() =>
		terminal.getViewport().join("\n").includes("learning-input.ts"),
	);
	assert.match(terminal.getViewport().join("\n"), /REFERENCE/);
	assert.match(terminal.getViewport().join("\n"), /learning-input\.ts/);

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

test("session picker waits for listing and switching before draining queued guidance", async () => {
	const agent = new FakeLearningAgent();
	agent.sessions = [
		{
			id: "session-target",
			path: "target.jsonl",
			messageCount: 3,
			createdAt: "2026-07-29T10:00:00.000Z",
			preview: "Review the learning loop",
		},
	];
	agent.delaySessionList();
	agent.delaySessionSwitch();
	const terminal = new VirtualTerminal(100, 30);
	const app = new LearningAgentTui(agent, terminal);
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
	const agent = new FakeLearningAgent();
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
	const app = new LearningAgentTui(agent, terminal);
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
	const agent = new FakeLearningAgent();
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
	const app = new LearningAgentTui(agent, terminal);
	const running = app.run();
	await terminal.waitForRender();

	terminal.sendInput("/sessions");
	terminal.sendInput("\r");
	await waitFor(() =>
		terminal.getScrollBuffer().join("\n").includes("Resume a learning session"),
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
	const agent = new FakeLearningAgent();
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
	const app = new LearningAgentTui(agent, terminal);
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
