import assert from "node:assert/strict";
import test from "node:test";
import type { LogosAgentUiEvent } from "../src/logos-agent.ts";
import { mapLogosEventToAcpUpdates } from "../src/acp/event-mapper.ts";

test("ACP event mapper streams assistant text and thinking deltas", () => {
	const textEvent = {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "hello" },
	} as LogosAgentUiEvent;
	const thoughtEvent = {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "checking" },
	} as LogosAgentUiEvent;

	assert.deepEqual(mapLogosEventToAcpUpdates(textEvent), [{
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text: "hello" },
	}]);
	assert.deepEqual(mapLogosEventToAcpUpdates(thoughtEvent), [{
		sessionUpdate: "agent_thought_chunk",
		content: { type: "text", text: "checking" },
	}]);
});

test("ACP event mapper reports tool lifecycle without forwarding raw input or output", () => {
	const start = mapLogosEventToAcpUpdates({
		type: "tool_execution_start",
		toolCallId: "tool-1",
		toolName: "buzz_cli",
		args: { token: "secret" },
	} as LogosAgentUiEvent);
	const end = mapLogosEventToAcpUpdates({
		type: "tool_execution_end",
		toolCallId: "tool-1",
		toolName: "buzz_cli",
		result: { private: "output" },
		isError: false,
	} as LogosAgentUiEvent);

	assert.deepEqual(start, [{
		sessionUpdate: "tool_call",
		toolCallId: "tool-1",
		title: "buzz_cli",
		kind: "execute",
		status: "in_progress",
	}]);
	assert.deepEqual(end, [{
		sessionUpdate: "tool_call_update",
		toolCallId: "tool-1",
		title: "buzz_cli",
		kind: "execute",
		status: "completed",
	}]);
});
