import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	type UserQuestion,
	UserQuestionCoordinator,
} from "../src/ask-user-tool.ts";
import { ApprovalCoordinator } from "../src/edit-approval.ts";
import {
	describeDirectoryMutationEvidence,
	getMessageThinking,
	HarnessLogosAgent,
	type LogosAgentUiEvent,
	type LogosApprovalSubject,
	resolveLogosThinkingLevel,
	shouldRunManualCompaction,
} from "../src/logos-agent.ts";

function bindRequestApproval(agent: HarnessLogosAgent) {
	return (
		agent as unknown as {
			requestApproval(subject: LogosApprovalSubject): Promise<boolean>;
		}
	).requestApproval.bind(agent);
}

test("manual compaction threshold uses the unrounded context ratio", () => {
	assert.equal(
		shouldRunManualCompaction(
			{ tokenCount: 6_999, contextWindow: 10_000, percent: 70 },
			false,
		),
		false,
	);
	assert.equal(
		shouldRunManualCompaction(
			{ tokenCount: 7_000, contextWindow: 10_000, percent: 70 },
			false,
		),
		true,
	);
	assert.equal(
		shouldRunManualCompaction(
			{ tokenCount: 1, contextWindow: 10_000, percent: 0 },
			true,
		),
		true,
	);
});

test("reasoning models default high while explicit thinking configuration wins", () => {
	assert.equal(resolveLogosThinkingLevel(true), "high");
	assert.equal(resolveLogosThinkingLevel(false), "off");
	assert.equal(resolveLogosThinkingLevel(true, "off"), "off");
	assert.equal(resolveLogosThinkingLevel(false, "medium"), "medium");
});

test("direct Node runtime loads the workspace Agent Harness source", async () => {
	const source = await readFile(new URL("../src/logos-agent.ts", import.meta.url), "utf8");
	assert.match(source, /from "\.\.\/\.\.\/\.\.\/packages\/agent\/src\/index\.ts"/);
	assert.match(source, /from "\.\.\/\.\.\/\.\.\/packages\/agent\/src\/node\.ts"/);

	const result = spawnSync(
		process.execPath,
		[fileURLToPath(new URL("./fixtures/direct-node-runtime.ts", import.meta.url))],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "runtime import ok");
});

test("partial directory failures remain visible as workspace changes", () => {
	assert.deepEqual(
		describeDirectoryMutationEvidence(
			{
				stage: "failed",
				paths: ["src/core"],
				created: ["src", "src/core"],
				preserved: ["src/core"],
			},
			true,
		),
		{
			paths: ["src/core"],
			changed: ["src/core"],
			partialFailure: true,
		},
	);
	assert.equal(
		describeDirectoryMutationEvidence(
			{ stage: "failed", paths: ["src/core"], preserved: [] },
			true,
		),
		undefined,
	);
});

test("provider reasoning is extracted without exposing redacted blocks", () => {
	assert.equal(
		getMessageThinking({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "inspect the current state" },
				{ type: "thinking", thinking: "opaque", redacted: true },
				{ type: "text", text: "done" },
			],
			api: "openai-completions",
			provider: "deepseek",
			model: "deepseek-v4-pro",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		}),
		"inspect the current state",
	);
});

test("abort and waitForIdle include pre-provider TaskRun finalization", async () => {
	let finishLifecycle = () => {};
	const lifecycle = new Promise<void>((resolve) => {
		finishLifecycle = resolve;
	});
	const taskController = new AbortController();
	const agent = Object.create(HarnessLogosAgent.prototype) as HarnessLogosAgent;
	Object.assign(agent as unknown as Record<string, unknown>, {
		activeTaskRunId: "run-1",
		approval: { cancel() {} },
		codeGraphSync: { async waitForIdle() {} },
		harness: {
			async abort() {},
			async waitForIdle() {},
		},
		promptLifecyclePromise: lifecycle,
		questions: { cancel() {} },
		taskAbortController: taskController,
	});
	let abortReturned = false;
	const aborting = agent.abort().then(() => {
		abortReturned = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(taskController.signal.aborted, true);
	assert.equal(abortReturned, false);
	finishLifecycle();
	await aborting;
	assert.equal(abortReturned, true);

	let finishSecondLifecycle = () => {};
	const secondLifecycle = new Promise<void>((resolve) => {
		finishSecondLifecycle = resolve;
	});
	Object.assign(agent as unknown as Record<string, unknown>, {
		promptLifecyclePromise: secondLifecycle,
	});
	let idleReturned = false;
	const waiting = agent.waitForIdle().then(() => {
		idleReturned = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(idleReturned, false);
	finishSecondLifecycle();
	await waiting;
	assert.equal(idleReturned, true);
});

test("approval publication failure records failed and resumes a waiting TaskRun", async () => {
	const approval = new ApprovalCoordinator<LogosApprovalSubject>();
	const events: LogosAgentUiEvent[] = [];
	const evidence: string[] = [];
	const updates: string[] = [];
	let runStatus = "active";
	const agent = Object.create(HarnessLogosAgent.prototype) as HarnessLogosAgent;
	Object.assign(agent as unknown as Record<string, unknown>, {
		activeTaskRunId: "run-1",
		approval,
		taskRuns: {
			async get() {
				return { status: runStatus };
			},
		},
		async applyTaskRunUpdate(
			_controller: unknown,
			_runId: string,
			update: { type: string },
		) {
			updates.push(update.type);
			runStatus = update.type === "wait" ? "waiting" : "active";
		},
		async recordTaskRunEvidence(
			_controller: unknown,
			entry: { outcome: string },
		) {
			evidence.push(entry.outcome);
		},
		async emit(event: LogosAgentUiEvent) {
			events.push(event);
			if (event.type === "approval_request") throw new Error("approval publication failed");
		},
	});

	await assert.rejects(
		bindRequestApproval(agent)({
			kind: "tool",
			toolName: "apply_edit",
			capabilities: [],
		}),
		/approval publication failed/,
	);
	assert.deepEqual(updates, ["wait", "resume"]);
	assert.deepEqual(evidence, ["started", "failed"]);
	assert.equal(events.at(-1)?.type, "approval_resolved");
	const resolved = events.at(-1);
	assert.equal(
		resolved?.type === "approval_resolved" ? resolved.outcome : undefined,
		"failed",
	);
});

test("approval wait failure is resolved and audited as failed", async () => {
	const approval = new ApprovalCoordinator<LogosApprovalSubject>();
	const events: LogosAgentUiEvent[] = [];
	const evidence: string[] = [];
	const agent = Object.create(HarnessLogosAgent.prototype) as HarnessLogosAgent;
	Object.assign(agent as unknown as Record<string, unknown>, {
		activeTaskRunId: "run-1",
		approval,
		taskRuns: {
			async get() {
				return { status: "active" };
			},
		},
		async applyTaskRunUpdate() {
			throw new Error("approval wait failed");
		},
		async recordTaskRunEvidence(
			_controller: unknown,
			entry: { outcome: string },
		) {
			evidence.push(entry.outcome);
		},
		async emit(event: LogosAgentUiEvent) {
			events.push(event);
		},
	});

	await assert.rejects(
		bindRequestApproval(agent)({
			kind: "tool",
			toolName: "apply_edit",
			capabilities: [],
		}),
		/approval wait failed/,
	);
	assert.deepEqual(evidence, ["started", "failed"]);
	assert.deepEqual(events.map((event) => event.type), ["approval_resolved"]);
	assert.equal(
		events[0]?.type === "approval_resolved" ? events[0].outcome : undefined,
		"failed",
	);
});

test("approval resolution publication failure records failed instead of approved", async () => {
	const approval = new ApprovalCoordinator<LogosApprovalSubject>();
	const evidence: string[] = [];
	const agent = Object.create(HarnessLogosAgent.prototype) as HarnessLogosAgent;
	Object.assign(agent as unknown as Record<string, unknown>, {
		activeTaskRunId: "run-1",
		approval,
		taskRuns: {
			async get() {
				return { status: "waiting" };
			},
		},
		async applyTaskRunUpdate() {},
		async recordTaskRunEvidence(
			_controller: unknown,
			entry: { outcome: string },
		) {
			evidence.push(entry.outcome);
		},
		async emit(event: LogosAgentUiEvent) {
			if (event.type === "approval_request") {
				approval.respond(event.request.id, true);
				return;
			}
			if (event.type === "approval_resolved") {
				throw new Error("approval resolution failed");
			}
		},
	});

	await assert.rejects(
		bindRequestApproval(agent)({
			kind: "tool",
			toolName: "apply_edit",
			capabilities: [],
		}),
		/approval resolution failed/,
	);
	assert.deepEqual(evidence, ["started", "failed"]);
});

test("cancelled user questions resume a TaskRun after a delayed wait update", async () => {
	let releaseWait = () => {};
	const waitUpdate = new Promise<void>((resolve) => {
		releaseWait = resolve;
	});
	let confirmResume = () => {};
	const resumed = new Promise<void>((resolve) => {
		confirmResume = resolve;
	});
	let runStatus = "running";
	const updates: string[] = [];
	const events: string[] = [];
	const agent = Object.create(HarnessLogosAgent.prototype) as HarnessLogosAgent;
	Object.assign(agent as unknown as Record<string, unknown>, {
		activeTaskRunId: "run-1",
		questions: new UserQuestionCoordinator(),
		taskRuns: {
			async get() {
				return { status: runStatus };
			},
		},
		async applyTaskRunUpdate(
			_store: unknown,
			_runId: string,
			update: { type: string },
		) {
			updates.push(update.type);
			if (update.type === "wait") {
				await waitUpdate;
				runStatus = "waiting";
				return;
			}
			runStatus = "running";
			confirmResume();
		},
		async emit(event: { type: string }) {
			events.push(event.type);
		},
	});
	const requestUserQuestion = (
		agent as unknown as {
			requestUserQuestion(
				question: UserQuestion,
				signal?: AbortSignal,
			): Promise<unknown>;
		}
	).requestUserQuestion.bind(agent);
	const controller = new AbortController();
	const request = requestUserQuestion({ question: "Continue?" }, controller.signal);
	await new Promise<void>((resolve) => setImmediate(resolve));

	controller.abort();
	await assert.rejects(request, { name: "AbortError" });
	assert.deepEqual(updates, ["wait"]);
	assert.deepEqual(events, []);

	releaseWait();
	await resumed;
	assert.deepEqual(updates, ["wait", "resume"]);
	assert.equal(runStatus, "running");
	assert.deepEqual(events, []);
});

test("cancelling question publication skips later request listeners and resolves once", async () => {
	let releaseFirstListener = () => {};
	const firstListener = new Promise<void>((resolve) => {
		releaseFirstListener = resolve;
	});
	let confirmResolution = () => {};
	const resolution = new Promise<void>((resolve) => {
		confirmResolution = resolve;
	});
	const firstEvents: string[] = [];
	const secondEvents: string[] = [];
	const agent = Object.create(HarnessLogosAgent.prototype) as HarnessLogosAgent;
	Object.assign(agent as unknown as Record<string, unknown>, {
		activeTaskRunId: undefined,
		listeners: new Set([
			async (event: { type: string }) => {
				firstEvents.push(event.type);
				if (event.type === "question_request") await firstListener;
			},
			async (event: { type: string }) => {
				secondEvents.push(event.type);
				if (event.type === "question_resolved") confirmResolution();
			},
		]),
		questions: new UserQuestionCoordinator(),
	});
	const requestUserQuestion = (
		agent as unknown as {
			requestUserQuestion(
				question: UserQuestion,
				signal?: AbortSignal,
			): Promise<unknown>;
		}
	).requestUserQuestion.bind(agent);
	const controller = new AbortController();
	const request = requestUserQuestion({ question: "Continue?" }, controller.signal);
	await new Promise<void>((resolve) => setImmediate(resolve));

	controller.abort();
	await assert.rejects(request, { name: "AbortError" });
	assert.deepEqual(firstEvents, ["question_request"]);
	assert.deepEqual(secondEvents, []);

	releaseFirstListener();
	await resolution;
	assert.deepEqual(firstEvents, ["question_request", "question_resolved"]);
	assert.deepEqual(secondEvents, ["question_resolved"]);
});
