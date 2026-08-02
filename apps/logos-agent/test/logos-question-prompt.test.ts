import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { UserQuestionAction } from "../src/ask-user-tool.ts";
import { LogosQuestionPrompt } from "../src/logos-question-prompt.ts";

function createPrompt(actions: UserQuestionAction[]): LogosQuestionPrompt {
	return new LogosQuestionPrompt(
		{
			id: "question-1",
			question: "Which architecture should be used?",
			context: "The repository does not establish this choice.",
			options: [
				{ label: "Deep module", description: "Hide interaction state behind one interface" },
				{ label: "Inline logic", description: "Keep the behavior inside the TUI application" },
			],
		},
		(action) => actions.push(action),
	);
}

test("question prompt renders choices, custom input, and separate chat action within width", () => {
	const prompt = createPrompt([]);
	for (const width of [32, 80]) {
		const output = prompt.render(width).join("\n");
		assert.match(output, /1\. Deep module/);
		assert.match(output, /3\. Type something\./);
		assert.match(output, /4\. Chat about this/);
		for (const line of prompt.render(width)) {
			assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} exceeds ${width}`);
		}
	}
});

test("question prompt returns selected options as answers", () => {
	const actions: UserQuestionAction[] = [];
	const prompt = createPrompt(actions);
	prompt.handleInput("\x1b[B");
	prompt.handleInput("\r");
	assert.deepEqual(actions, [
		{ kind: "answer", answer: "Inline logic", source: "option" },
	]);
});

test("question prompt supports free-text answers without making escape cancel the turn", () => {
	const actions: UserQuestionAction[] = [];
	const prompt = createPrompt(actions);
	prompt.handleInput("\x1b[B");
	prompt.handleInput("\x1b[B");
	prompt.handleInput("\r");
	assert.equal(prompt.isEditingCustomAnswer(), true);
	prompt.handleInput("draft answer");
	prompt.handleInput("\x1b");
	assert.equal(prompt.isEditingCustomAnswer(), false);
	assert.deepEqual(actions, []);

	prompt.handleInput("\r");
	prompt.handleInput("final answer");
	prompt.handleInput("\r");
	assert.deepEqual(actions, [
		{ kind: "answer", answer: "draft answerfinal answer", source: "custom" },
	]);
});

test("question prompt reports chat and cancel as distinct actions", () => {
	const discussActions: UserQuestionAction[] = [];
	const discussPrompt = createPrompt(discussActions);
	for (let index = 0; index < 3; index++) discussPrompt.handleInput("\x1b[B");
	discussPrompt.handleInput("\r");
	assert.deepEqual(discussActions, [{ kind: "discuss" }]);

	const cancelActions: UserQuestionAction[] = [];
	const cancelPrompt = createPrompt(cancelActions);
	cancelPrompt.handleInput("\x1b");
	assert.deepEqual(cancelActions, [{ kind: "cancel" }]);
});
