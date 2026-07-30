import assert from "node:assert/strict";
import { test } from "node:test";
import {
	describeLearningInput,
	type LearningInputContext,
} from "../src/learning-input.ts";

const readyContext: LearningInputContext = {
	text: "",
	agentBusy: false,
	commandRunning: false,
	drainingQueue: false,
	pendingPolicyUpdates: 0,
	policyUpdateFailed: false,
	sessionSwitchFailed: false,
	queuedCount: 0,
	referenceCompletionActive: false,
};

test("learning input explains useful goals and multiline prompts", () => {
	assert.equal(describeLearningInput(readyContext).mode, "ready");
	assert.match(describeLearningInput(readyContext).help, /acceptance criteria/);
	assert.deepEqual(
		describeLearningInput({
			...readyContext,
			text: "Inspect evidence\nthen propose a change",
		}),
		{
			mode: "draft",
			label: "PROMPT",
			help: "2 lines · 38 chars · Enter send · Shift+Enter/Ctrl+J newline",
		},
	);
});

test("learning input distinguishes commands, references, guidance, and blockers", () => {
	assert.equal(
		describeLearningInput({ ...readyContext, text: "/sessions" }).mode,
		"command",
	);
	assert.equal(
		describeLearningInput({
			...readyContext,
			text: "inspect @src/",
			referenceCompletionActive: true,
		}).mode,
		"reference",
	);
	assert.match(
		describeLearningInput({
			...readyContext,
			agentBusy: true,
			queuedCount: 2,
		}).help,
		/2 queued/,
	);
	assert.match(
		describeLearningInput({
			...readyContext,
			policyUpdateFailed: true,
		}).help,
		/\/permissions/,
	);
	assert.match(
		describeLearningInput({
			...readyContext,
			sessionSwitchFailed: true,
		}).help,
		/\/sessions or \/switch/,
	);
});
