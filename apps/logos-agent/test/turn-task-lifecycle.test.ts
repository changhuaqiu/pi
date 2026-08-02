import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	isNormalTurnComplete,
	TurnTaskLifecycle,
} from "../src/turn-task-lifecycle.ts";

function assistantText(
	text: string,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "test",
		model: "test",
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
		stopReason,
		timestamp: Date.now(),
	};
}

test("ordinary conversation and read-only tools remain a turn", () => {
	const lifecycle = new TurnTaskLifecycle();
	lifecycle.beginTurn("你好");
	assert.equal(
		lifecycle.observeToolCapabilities([
			{ kind: "fs.read", scope: "workspace" },
		]),
		false,
	);
	assert.deepEqual(lifecycle.snapshot(), { mode: "turn", goal: "你好" });
	assert.equal(isNormalTurnComplete(assistantText("你好。")), true);
});

test("only side-effecting capabilities promote a turn", () => {
	for (const kind of [
		"edit.propose",
		"fs.write",
		"fs.delete",
		"process.execute",
	] as const) {
		const lifecycle = new TurnTaskLifecycle();
		lifecycle.beginTurn("implement the change");
		assert.equal(
			lifecycle.observeToolCapabilities([{ kind, scope: "test" }]),
			true,
		);
		assert.equal(lifecycle.isTask(), true);
		assert.equal(
			lifecycle.observeToolCapabilities([{ kind, scope: "test" }]),
			false,
		);
	}
});

test("planning and reflection do not turn read-only analysis into an execution task", () => {
	const lifecycle = new TurnTaskLifecycle();
	lifecycle.beginTurn("analyze the TUI");
	assert.equal(
		lifecycle.observeToolCapabilities([
			{ kind: "task.plan", scope: "current" },
			{ kind: "task.reflect", scope: "current" },
			{ kind: "task.complete", scope: "current" },
		]),
		false,
	);
	assert.equal(lifecycle.isTask(), false);
});

test("normal turn completion rejects truncation, blank output, and tool calls", () => {
	assert.equal(isNormalTurnComplete(assistantText("partial", "length")), false);
	assert.equal(isNormalTurnComplete(assistantText("  ")), false);
	const withTool = assistantText("I will inspect it");
	withTool.content.push({
		type: "toolCall",
		id: "read-1",
		name: "read_file",
		arguments: { path: "README.md" },
	});
	assert.equal(isNormalTurnComplete(withTool), false);
});

test("ending a turn clears its task identity", () => {
	const lifecycle = new TurnTaskLifecycle();
	lifecycle.beginTurn("change a file");
	lifecycle.observeToolCapabilities([{ kind: "fs.write", scope: "workspace" }]);
	lifecycle.endTurn();
	assert.deepEqual(lifecycle.snapshot(), { mode: "idle" });
});
