import assert from "node:assert/strict";
import { test } from "node:test";
import {
	describeLogosInput,
	type LogosInputContext,
} from "../src/logos-input.ts";

const readyContext: LogosInputContext = {
	text: "",
	awaitingUserAnswer: false,
	questionOptionCount: 0,
	agentBusy: false,
	commandRunning: false,
	drainingQueue: false,
	pendingPolicyUpdates: 0,
	policyUpdateFailed: false,
	sessionSwitchFailed: false,
	queuedCount: 0,
	referenceCompletionActive: false,
};

test("logos input explains useful goals and multiline prompts", () => {
	assert.equal(describeLogosInput(readyContext).mode, "ready");
	assert.match(describeLogosInput(readyContext).help, /acceptance criteria/);
	assert.deepEqual(
		describeLogosInput({
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

test("logos input distinguishes commands, references, guidance, and blockers", () => {
	assert.deepEqual(
		describeLogosInput({
			...readyContext,
			awaitingUserAnswer: true,
			questionOptionCount: 3,
		}),
		{
			mode: "answer",
			label: "ANSWER",
			help: "choose 1-3, type something, or return to chat · Enter select · Esc cancel turn",
		},
	);
	assert.equal(
		describeLogosInput({ ...readyContext, text: "/sessions" }).mode,
		"command",
	);
	assert.equal(
		describeLogosInput({
			...readyContext,
			text: "inspect @src/",
			referenceCompletionActive: true,
		}).mode,
		"reference",
	);
	assert.match(
		describeLogosInput({
			...readyContext,
			agentBusy: true,
			queuedCount: 2,
		}).help,
		/2 queued/,
	);
	assert.match(
		describeLogosInput({
			...readyContext,
			policyUpdateFailed: true,
		}).help,
		/\/permissions/,
	);
	assert.match(
		describeLogosInput({
			...readyContext,
			sessionSwitchFailed: true,
		}).help,
		/\/sessions or \/switch/,
	);
});
