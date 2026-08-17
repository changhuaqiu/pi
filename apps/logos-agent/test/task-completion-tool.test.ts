import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	createFinishTaskTool,
	getEligibleTaskCompletionToolCallId,
	hasSuccessfulTaskCompletion,
	isInternalContinuationPrompt,
	isSuccessfulTaskCompletionResult,
	maxTaskCompletionContinuations,
	runTaskCompletionLoop,
	TaskCompletionTracker,
	taskCompletionContinuationPrompt,
	taskLengthContinuationPrompt,
	turnCompletionContinuationPrompt,
	turnLengthContinuationPrompt,
} from "../src/task-completion-tool.ts";

function completionMessage(toolCallId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "Implemented and verified." },
			{
				type: "toolCall",
				id: toolCallId,
				name: "finish_task",
				arguments: { summary: "Implemented" },
			},
		],
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
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function finalSummaryMessage(): AssistantMessage {
	return {
		...completionMessage("unused"),
		content: [{ type: "text", text: "Implemented and verified." }],
		stopReason: "stop",
	};
}

test("finish_task records bounded details and requests a normal final summary", async () => {
	const tool = createFinishTaskTool();
	const result = await tool.execute(
		"finish-1",
		{ summary: "  Implemented the fix  ", verification: "  typecheck passed  " },
		undefined,
		undefined,
	);

	assert.equal(result.terminate, undefined);
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /final user-facing summary/);
	assert.deepEqual(result.details, {
		stage: "completed",
		summary: "Implemented the fix",
		verification: "typecheck passed",
	});
});

test("finish_task appends the runtime assurance level to the result", async () => {
	for (const assurance of ["verified", "partial", "unverified"] as const) {
		const tool = createFinishTaskTool({ loadAssurance: async () => assurance });
		const result = await tool.execute(
			"finish-1",
			{ summary: "Implemented the fix" },
			undefined,
			undefined,
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.match(text, new RegExp(`Assurance: ${assurance} — `));
		assert.match(text, /final user-facing summary/);
		assert.equal(result.details.assurance, assurance);
	}
});

test("finish_task omits assurance when it is unavailable or fails to load", async () => {
	const withoutRun = createFinishTaskTool({ loadAssurance: async () => undefined });
	const plain = await withoutRun.execute(
		"finish-1",
		{ summary: "Implemented the fix" },
		undefined,
		undefined,
	);
	const plainText = plain.content[0]?.type === "text" ? plain.content[0].text : "";
	assert.doesNotMatch(plainText, /Assurance:/);
	assert.equal(plain.details.assurance, undefined);

	const failing = createFinishTaskTool({
		loadAssurance: async () => {
			throw new Error("no active run");
		},
	});
	const result = await failing.execute(
		"finish-2",
		{ summary: "Implemented the fix" },
		undefined,
		undefined,
	);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	assert.doesNotMatch(text, /Assurance:/);
	assert.equal(result.details.assurance, undefined);
});

test("a final text response completes only after finish_task succeeded", () => {
	const message = finalSummaryMessage();
	assert.equal(hasSuccessfulTaskCompletion(message, new Set(["finish-1"])), true);
	assert.equal(hasSuccessfulTaskCompletion(message, new Set()), false);
	message.content.push({
		type: "toolCall",
		id: "other-1",
		name: "read_file",
		arguments: { path: "README.md" },
	});
	assert.equal(hasSuccessfulTaskCompletion(message, new Set(["finish-1"])), false);
});

test("finish_task is eligible only when it is the message's sole tool call", () => {
	const message = completionMessage("finish-1");
	assert.equal(getEligibleTaskCompletionToolCallId(message), "finish-1");
	message.content.push({
		type: "toolCall",
		id: "read-1",
		name: "read_file",
		arguments: { path: "README.md" },
	});
	assert.equal(getEligibleTaskCompletionToolCallId(message), undefined);
});

test("completion tracker invalidates success from any later assistant tool call", () => {
	const tracker = new TaskCompletionTracker();
	tracker.observeAssistantMessage(completionMessage("finish-1"));
	tracker.observeToolCall();
	tracker.observeToolResult("finish-1", true);
	assert.equal(tracker.isCompleted(finalSummaryMessage()), true);

	tracker.observeAssistantMessage({
		...completionMessage("unknown-1"),
		content: [
			{
				type: "toolCall",
				id: "unknown-1",
				name: "unknown_tool",
				arguments: {},
			},
		],
		stopReason: "length",
	});
	assert.equal(tracker.isCompleted(finalSummaryMessage()), false);
});

test("completion tracker rejects mixed and failed finish_task calls", () => {
	const tracker = new TaskCompletionTracker();
	const mixed = completionMessage("finish-1");
	mixed.content.push({
		type: "toolCall",
		id: "read-1",
		name: "read_file",
		arguments: { path: "README.md" },
	});
	tracker.observeAssistantMessage(mixed);
	tracker.observeToolResult("finish-1", true);
	assert.equal(tracker.isCompleted(finalSummaryMessage()), false);

	tracker.observeAssistantMessage(completionMessage("finish-2"));
	tracker.observeToolResult("finish-2", false);
	assert.equal(tracker.isCompleted(finalSummaryMessage()), false);
});

test("completion tracker reset invalidates success when new user guidance arrives", () => {
	const tracker = new TaskCompletionTracker();
	tracker.observeAssistantMessage(completionMessage("finish-1"));
	tracker.observeToolResult("finish-1", true);
	assert.equal(tracker.isCompleted(finalSummaryMessage()), true);
	tracker.reset();
	assert.equal(tracker.isCompleted(finalSummaryMessage()), false);
});

test("pending external input blocks stale finish events until the user message is injected", () => {
	const tracker = new TaskCompletionTracker();
	tracker.beginExternalInput();
	tracker.observeAssistantMessage(completionMessage("stale-finish"));
	tracker.observeToolCall();
	tracker.observeToolResult("stale-finish", true);
	assert.equal(tracker.isCompleted(finalSummaryMessage()), false);

	tracker.observeExternalInput();
	tracker.observeAssistantMessage(completionMessage("new-finish"));
	tracker.observeToolCall();
	tracker.observeToolResult("new-finish", true);
	assert.equal(tracker.isCompleted(finalSummaryMessage()), true);
});

test("overlapping external inputs remain blocked until every queued message is injected", () => {
	const tracker = new TaskCompletionTracker();
	const first = tracker.beginExternalInput();
	tracker.beginExternalInput();
	tracker.observeExternalInput();
	assert.equal(tracker.hasPendingExternalInput(), true);
	tracker.cancelExternalInput(first);
	tracker.observeAssistantMessage(completionMessage("stale-finish"));
	tracker.observeToolResult("stale-finish", true);
	assert.equal(tracker.isCompleted(finalSummaryMessage()), false);
	assert.equal(tracker.hasPendingExternalInput(), true);

	tracker.observeExternalInput();
	assert.equal(tracker.hasPendingExternalInput(), false);
	tracker.observeAssistantMessage(completionMessage("finish-after-guidance"));
	tracker.observeToolResult("finish-after-guidance", true);
	assert.equal(tracker.isCompleted(finalSummaryMessage()), true);
});

test("finish result is successful only with completed details", () => {
	assert.equal(
		isSuccessfulTaskCompletionResult("finish_task", false, { stage: "completed" }),
		true,
	);
	assert.equal(isSuccessfulTaskCompletionResult("finish_task", false, undefined), false);
	assert.equal(
		isSuccessfulTaskCompletionResult("finish_task", false, { stage: "prepared" }),
		false,
	);
	assert.equal(
		isSuccessfulTaskCompletionResult("finish_task", true, { stage: "completed" }),
		false,
	);
});

test("finish_task without a user-facing final answer is not completion", () => {
	const message = finalSummaryMessage();
	message.content = [];
	assert.equal(hasSuccessfulTaskCompletion(message, new Set(["finish-1"])), false);
});

test("a truncated or failed partial summary is not completion", () => {
	for (const stopReason of ["length", "error", "aborted"] as const) {
		const message = { ...finalSummaryMessage(), stopReason };
		assert.equal(
			hasSuccessfulTaskCompletion(message, new Set(["finish-1"])),
			false,
		);
	}
});

test("plain stop text is not task completion", () => {
	const message = finalSummaryMessage();
	message.content = [{ type: "text", text: "I will start implementing now." }];
	assert.equal(hasSuccessfulTaskCompletion(message, new Set()), false);
});

test("normal stops are continued until finish_task succeeds", async () => {
	const responses = [
		{ ...completionMessage("unused-1"), content: [{ type: "text" as const, text: "I will start." }], stopReason: "stop" as const },
		{ ...completionMessage("unused-2"), content: [{ type: "text" as const, text: "Now implementing." }], stopReason: "stop" as const },
		finalSummaryMessage(),
	];
	const prompts: string[] = [];
	const retries: number[] = [];
	const successfulToolCallIds = new Set<string>();
	const result = await runTaskCompletionLoop(
		"implement the feature",
		async (prompt) => {
			prompts.push(prompt);
			const response = responses.shift();
			assert.ok(response);
			if (responses.length === 0) successfulToolCallIds.add("finish-1");
			return response;
		},
		(message) => hasSuccessfulTaskCompletion(message, successfulToolCallIds),
		(attempt) => {
			retries.push(attempt);
		},
	);

	assert.equal(result.completed, true);
	assert.equal(result.continuationCount, 2);
	assert.deepEqual(retries, [1, 2]);
	assert.deepEqual(prompts, [
		"implement the feature",
		taskCompletionContinuationPrompt,
		taskCompletionContinuationPrompt,
	]);
});

test("normal stops fail closed after the bounded continuation limit", async () => {
	let calls = 0;
	const result = await runTaskCompletionLoop(
		"implement the feature",
		async () => {
			calls++;
			return {
				...completionMessage(`unused-${calls}`),
				content: [{ type: "text", text: "I will continue." }],
				stopReason: "stop",
			};
		},
		() => false,
		() => {},
	);

	assert.equal(result.completed, false);
	assert.equal(result.continuationCount, maxTaskCompletionContinuations);
	assert.equal(calls, maxTaskCompletionContinuations + 1);
});

test("length stops continue inside the same bounded task loop", async () => {
	const responses = [
		{ ...finalSummaryMessage(), stopReason: "length" as const },
		finalSummaryMessage(),
	];
	const prompts: string[] = [];
	const reasons: string[] = [];
	const successfulToolCallIds = new Set<string>();
	const result = await runTaskCompletionLoop(
		"implement the feature",
		async (prompt) => {
			prompts.push(prompt);
			const response = responses.shift();
			assert.ok(response);
			if (responses.length === 0) successfulToolCallIds.add("finish-1");
			return response;
		},
		(message) => hasSuccessfulTaskCompletion(message, successfulToolCallIds),
		(_attempt, _maxAttempts, reason) => {
			reasons.push(reason);
		},
	);

	assert.equal(result.completed, true);
	assert.deepEqual(prompts, ["implement the feature", taskLengthContinuationPrompt]);
	assert.deepEqual(reasons, ["length"]);
});

test("ordinary turns select neutral continuation prompts", async () => {
	const responses = [
		{ ...finalSummaryMessage(), content: [], stopReason: "stop" as const },
		{ ...finalSummaryMessage(), stopReason: "length" as const },
		finalSummaryMessage(),
	];
	const prompts: string[] = [];
	const result = await runTaskCompletionLoop(
		"explain the architecture",
		async (prompt) => {
			prompts.push(prompt);
			const response = responses.shift();
			assert.ok(response);
			return response;
		},
		(message) =>
			message.stopReason === "stop" &&
			message.content.some(
				(item) => item.type === "text" && item.text.trim().length > 0,
			),
		() => {},
		undefined,
		(reason) =>
			reason === "length"
				? turnLengthContinuationPrompt
				: turnCompletionContinuationPrompt,
	);

	assert.equal(result.completed, true);
	assert.deepEqual(prompts, [
		"explain the architecture",
		turnCompletionContinuationPrompt,
		turnLengthContinuationPrompt,
	]);
});

test("all continuation prompts are classified as internal", () => {
	for (const prompt of [
		taskCompletionContinuationPrompt,
		taskLengthContinuationPrompt,
		turnCompletionContinuationPrompt,
		turnLengthContinuationPrompt,
	]) {
		assert.equal(isInternalContinuationPrompt(prompt), true);
	}
	assert.equal(isInternalContinuationPrompt("user request"), false);
});

test("a truncated final summary continues after finish_task already succeeded", async () => {
	const successfulToolCallIds = new Set(["finish-1"]);
	const responses = [
		{ ...finalSummaryMessage(), content: [{ type: "text" as const, text: "Partial summary" }], stopReason: "length" as const },
		finalSummaryMessage(),
	];
	const prompts: string[] = [];
	const result = await runTaskCompletionLoop(
		"implement the feature",
		async (prompt) => {
			prompts.push(prompt);
			const response = responses.shift();
			assert.ok(response);
			return response;
		},
		(message) => hasSuccessfulTaskCompletion(message, successfulToolCallIds),
		() => {},
	);

	assert.equal(result.completed, true);
	assert.deepEqual(prompts, ["implement the feature", taskLengthContinuationPrompt]);
});

test("abort between attempts prevents the next provider request", async () => {
	const controller = new AbortController();
	let calls = 0;
	await assert.rejects(
		runTaskCompletionLoop(
			"implement the feature",
			async () => {
				calls++;
				return {
					...completionMessage("unused"),
					content: [{ type: "text", text: "I will start." }],
					stopReason: "stop",
				};
			},
			() => false,
			() => controller.abort(new Error("user aborted")),
			controller.signal,
		),
		/user aborted/,
	);
	assert.equal(calls, 1);
});
