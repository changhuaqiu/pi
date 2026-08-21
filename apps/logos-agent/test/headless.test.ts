import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	HeadlessLogosAgent,
} from "../src/headless.ts";
import { runHeadlessPrompt } from "../src/headless.ts";
import type { LogosAgentUiEvent } from "../src/logos-agent.ts";

function assistantMessage(
	text: string,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai-compatible",
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
		stopReason,
		timestamp: 1,
	};
}

class FakeHeadlessAgent implements HeadlessLogosAgent {
	readonly approvalDecisions: boolean[] = [];
	readonly questionActions: string[] = [];
	message = assistantMessage("final answer");
	private listener?: (event: LogosAgentUiEvent) => void | Promise<void>;

	async prompt(): Promise<AssistantMessage> {
		await this.listener?.({
			type: "approval_request",
			request: {
				id: "approval-1",
				subject: { kind: "tool", toolName: "apply_edit", capabilities: [] },
			},
		});
		await this.listener?.({
			type: "question_request",
			request: { id: "question-1", question: "Which option?" },
		});
		return this.message;
	}

	subscribe(listener: (event: LogosAgentUiEvent) => void | Promise<void>): () => void {
		this.listener = listener;
		return () => {
			this.listener = undefined;
		};
	}

	respondToApproval(_requestId: string, approved: boolean): boolean {
		this.approvalDecisions.push(approved);
		return true;
	}

	respondToQuestion(_requestId: string, action: { kind: "cancel" }) {
		this.questionActions.push(action.kind);
		return { accepted: true };
	}
}

test("headless mode uses the existing approval and question channels", async () => {
	const agent = new FakeHeadlessAgent();
	assert.equal(
		await runHeadlessPrompt(agent, "perform the task", { autoApprove: true }),
		"final answer",
	);
	assert.deepEqual(agent.approvalDecisions, [true]);
	assert.deepEqual(agent.questionActions, ["cancel"]);
});

test("headless mode rejects approval by default", async () => {
	const agent = new FakeHeadlessAgent();
	await runHeadlessPrompt(agent, "inspect only");
	assert.deepEqual(agent.approvalDecisions, [false]);
});

test("headless mode surfaces provider failures", async () => {
	const agent = new FakeHeadlessAgent();
	agent.message = {
		...assistantMessage("", "error"),
		errorMessage: "bridge unavailable",
	};
	await assert.rejects(
		runHeadlessPrompt(agent, "perform the task"),
		/bridge unavailable/,
	);
});

test("headless mode rejects truncated final output", async () => {
	const agent = new FakeHeadlessAgent();
	agent.message = assistantMessage("partial answer", "length");
	await assert.rejects(
		runHeadlessPrompt(agent, "perform the task"),
		/did not complete normally \(length\)/,
	);
});
