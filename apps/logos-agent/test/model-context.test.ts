import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "../../../packages/agent/src/index.ts";
import { createContextManager } from "../src/context-manager.ts";
import {
	assembleModelContext,
	type ModelContextContributor,
} from "../src/model-context.ts";

function userMessage(text: string, timestamp: number): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp,
	};
}

function contextMessage(
	customType: string,
	content: string,
	timestamp: number,
): AgentMessage {
	return {
		role: "custom",
		customType,
		content,
		display: false,
		timestamp,
	};
}

function toolResultMessage(
	toolName: string,
	text: string,
	timestamp: number,
	isError = false,
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `${toolName}-${timestamp}`,
		toolName,
		content: [{ type: "text", text }],
		details: { original: true },
		isError,
		timestamp,
	};
}

test("context contributors see the same base and merge in registration order", () => {
	const base = [userMessage("change auth", 1)];
	const seenLengths: number[] = [];
	const contributors: ModelContextContributor[] = [
		(input) => {
			seenLengths.push(input.messages.length);
			return {
				afterUserText: "change auth",
				messages: [contextMessage("task", "task context", 2)],
			};
		},
		(input) => {
			seenLengths.push(input.messages.length);
			return {
				afterUserText: "change auth",
				messages: [contextMessage("code", "code context", 3)],
			};
		},
	];

	const result = assembleModelContext(base, contributors);

	assert.deepEqual(seenLengths, [1, 1]);
	assert.deepEqual(
		result.map((message) =>
			message.role === "custom" ? message.customType : message.role,
		),
		["user", "task", "code"],
	);
	assert.equal(base.length, 1);
});

test("context assembly replaces owned ephemeral messages without changing session input", () => {
	const stale = contextMessage("code", "stale code", 2);
	const base = [
		userMessage("change auth", 1),
		stale,
		contextMessage("tool", "later tool result", 3),
	];

	const result = assembleModelContext(base, [() => ({
		afterUserText: "change auth",
		messages: [contextMessage("code", "fresh code", 4)],
		replaceCustomTypes: ["code"],
	})]);

	assert.deepEqual(
		result.map((message) =>
			message.role === "custom" ? message.content : message.role,
		),
		["user", "fresh code", "later tool result"],
	);
	assert.equal(base[1], stale);
});

test("anchored context is omitted when its user prompt is not present", () => {
	const base = [userMessage("different prompt", 1)];
	const result = assembleModelContext(base, [() => ({
		afterUserText: "missing prompt",
		messages: [contextMessage("code", "unrelated code", 2)],
	})]);

	assert.deepEqual(result, base);
});

test("tool result projection retains the recent working set and compacts older output", () => {
	const oldRead = toolResultMessage("read_file", `src/old.ts:1-200\n${"a".repeat(80)}`, 1);
	const oldSearch = toolResultMessage("grep", `matches: 50\n${"b".repeat(80)}`, 2);
	const latestCommand = toolResultMessage("run_command", `npm run check exited with exit code 0\n${"c".repeat(80)}`, 3);
	const messages = [oldRead, oldSearch, latestCommand];

	const manager = createContextManager({
		maxRetainedToolResultBytes: 120,
		keepRecentToolResults: 1,
		compactableToolNames: new Set(["read_file", "grep", "run_command"]),
	});
	const projection = manager.prepare(messages);

	assert.equal(projection.toolResults.compactedResults, 2);
	assert.equal(projection.toolResults.newlyCompactedResults, 2);
	assert.equal(projection.toolResults.retainedResults, 1);
	assert.equal(projection.sequence, 1);
	assert.equal(projection.sourceMessageCount, 3);
	assert.equal(projection.projectedMessageCount, 3);
	assert.deepEqual(
		projection.changes.map((change) => ({
			toolName: change.toolName,
			reason: change.reason,
			newlyCompacted: change.newlyCompacted,
		})),
		[
			{ toolName: "read_file", reason: "budget", newlyCompacted: true },
			{ toolName: "grep", reason: "budget", newlyCompacted: true },
		],
	);
	assert.equal(projection.messages[2], latestCommand);
	for (const index of [0, 1]) {
		const message = projection.messages[index];
		assert.equal(message?.role, "toolResult");
		if (message?.role !== "toolResult") assert.fail("expected tool result");
		assert.match(message.content[0]?.type === "text" ? message.content[0].text : "", /Older tool result compacted/);
	}
	assert.equal(messages[0], oldRead);
	assert.match(
		oldRead.role === "toolResult" && oldRead.content[0]?.type === "text"
			? oldRead.content[0].text
			: "",
		/a{80}/,
	);
});

test("tool result projection batches changes and keeps prior replacements stable", () => {
	const manager = createContextManager({
		maxRetainedToolResultBytes: 250,
		keepRecentToolResults: 1,
		compactableToolNames: new Set(["read_file"]),
	});
	const first = toolResultMessage("read_file", "a".repeat(100), 1);
	const second = toolResultMessage("read_file", "b".repeat(100), 2);
	const third = toolResultMessage("read_file", "c".repeat(100), 3);
	const firstProjection = manager.prepare([first, second, third]);
	assert.equal(firstProjection.toolResults.newlyCompactedResults, 2);

	const fourth = toolResultMessage("read_file", "d".repeat(100), 4);
	const stableProjection = manager.prepare([first, second, third, fourth]);
	assert.equal(stableProjection.toolResults.newlyCompactedResults, 0);
	assert.deepEqual(stableProjection.messages[0], firstProjection.messages[0]);
	assert.deepEqual(stableProjection.messages[1], firstProjection.messages[1]);

	const fifth = toolResultMessage("read_file", "e".repeat(100), 5);
	const nextBatch = manager.prepare([first, second, third, fourth, fifth]);
	assert.equal(nextBatch.toolResults.newlyCompactedResults, 2);
	assert.equal(nextBatch.toolResults.compactedResults, 4);
	assert.equal(nextBatch.messages[4], fifth);
});

test("tool result projection preserves failure semantics and a bounded recovery hint", () => {
	const oldFailure = toolResultMessage(
		"run_command",
		`npm run check exited with exit code 1\n${"failure detail ".repeat(100)}`,
		1,
		true,
	);
	const latest = toolResultMessage("read_file", "latest source", 2);

	const manager = createContextManager({
		maxRetainedToolResultBytes: 1,
		keepRecentToolResults: 1,
		compactableToolNames: new Set(["run_command", "read_file"]),
	});
	const projection = manager.prepare([oldFailure, latest]);
	const compacted = projection.messages[0];
	assert.equal(compacted?.role, "toolResult");
	if (compacted?.role !== "toolResult") assert.fail("expected tool result");
	assert.equal(compacted.isError, true);
	const text = compacted.content[0];
	assert.equal(text?.type, "text");
	assert.match(text?.type === "text" ? text.text : "", /outcome=error/);
	assert.match(text?.type === "text" ? text.text : "", /exit code 1/);
	assert.ok(Buffer.byteLength(text?.type === "text" ? text.text : "", "utf8") < 1_000);
});

test("tool result projection leaves stateful edit protocol results unchanged", () => {
	const proposal = toolResultMessage("propose_patch", `${"proposal".repeat(100)}`, 1);
	const latest = toolResultMessage("read_file", "latest source", 2);

	const manager = createContextManager({
		maxRetainedToolResultBytes: 1,
		keepRecentToolResults: 0,
		compactableToolNames: new Set(["read_file"]),
	});
	const projection = manager.prepare([proposal, latest]);

	assert.equal(projection.messages[0], proposal);
	assert.equal(projection.toolResults.compactedResults, 1);
});

test("large graph exploration is retained once and compacted on later provider requests", () => {
	const graph = toolResultMessage("codegraph_explore", `flow\n${"edge ".repeat(2_000)}`, 1);
	const oldReads = [
		toolResultMessage("read_file", "a".repeat(50_000), 2),
		toolResultMessage("read_file", "b".repeat(50_000), 3),
		toolResultMessage("read_file", "c".repeat(50_000), 4),
	];
	const manager = createContextManager({
		maxRetainedToolResultBytes: 128 * 1024,
		keepRecentToolResults: 2,
		compactableToolNames: new Set(["read_file"]),
		compactAfterUseToolNames: new Set(["codegraph_explore"]),
	});

	const firstProjection = manager.prepare([graph, ...oldReads]);
	assert.equal(firstProjection.messages[0], graph);
	assert.equal(firstProjection.toolResults.compactedResults, 1);

	const laterProjection = manager.prepare([graph, ...oldReads, userMessage("continue", 5)]);
	assert.equal(laterProjection.toolResults.compactedResults, 2);
	assert.equal(laterProjection.changes[0]?.reason, "after-use");
	const compacted = laterProjection.messages[0];
	assert.equal(compacted?.role, "toolResult");
	if (compacted?.role !== "toolResult") assert.fail("expected tool result");
	assert.match(
		compacted.content[0]?.type === "text" ? compacted.content[0].text : "",
		/Older tool result compacted/,
	);
});

test("compacted CodeGraph results retain bounded structured anchors", () => {
	const original = toolResultMessage("codegraph_search", "x".repeat(2_000), 1);
	if (original.role !== "toolResult") assert.fail("expected tool result");
	const longPath = `src/${"nested/".repeat(30)}target.ts`;
	const graph: AgentMessage = {
		...original,
		details: {
			operation: "node",
			availability: "ready",
			freshness: "fresh",
			truncated: false,
			reused: false,
			resultKey: "node-result",
			resultBytes: 5_848,
			sourceBytes: 5_848,
			resultCount: 52,
			fileCount: 1,
			anchors: [{ name: "findReusableImplementation", file: longPath, line: 42 }],
		},
	};
	const manager = createContextManager({
		compactableToolNames: new Set(),
		compactAfterUseToolNames: new Set(["codegraph_search"]),
	});
	manager.prepare([graph]);
	const later = manager.prepare([graph, userMessage("continue", 2)]).messages[0];
	assert.equal(later?.role, "toolResult");
	if (later?.role !== "toolResult") assert.fail("expected tool result");
	const text = later.content[0]?.type === "text" ? later.content[0].text : "";
	assert.match(text, /facts=operation=node; availability=ready; freshness=fresh/);
	assert.match(text, /resultCount=52; fileCount=1; anchorsShown=1/);
	assert.match(text, /anchors=findReusableImplementation@src\//);
	assert.match(text, /target\.ts:42/);
});
