import type { ContextRequestTrace } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { analyzeContextRequestTrace } from "../src/core/context-transform-trace.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { ContextRequestTraceComponent } from "../src/modes/interactive/components/context-request-trace.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(text: string, timestamp: number): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantMessage(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp,
	};
}

describe("context transform trace", () => {
	it("reports transform removals, injections, modifications, and conversion filtering", () => {
		const originalUser = userMessage("original question", 1);
		const oldAssistant = assistantMessage("old answer", 2);
		const rewrittenUser = userMessage("rewritten question", 1);
		const memory: CustomMessage = {
			role: "custom",
			customType: "memory",
			content: "prefers TypeScript",
			display: false,
			timestamp: 3,
		};
		const convertedMemory = userMessage("prefers TypeScript", 3);
		const trace: ContextRequestTrace = {
			originalMessages: [originalUser, oldAssistant],
			transformedMessages: [rewrittenUser, memory],
			llmMessages: [rewrittenUser, convertedMemory],
			systemPrompt: "system",
			tools: [],
		};

		const analysis = analyzeContextRequestTrace(trace);

		expect(analysis.agentState.messageCount).toBe(2);
		expect(analysis.transformed.roles).toEqual({ user: 1, custom: 1 });
		expect(analysis.transform.removed.map((message) => message.label)).toEqual(["assistant"]);
		expect(analysis.transform.injected.map((message) => message.label)).toEqual(["custom/memory"]);
		expect(analysis.transform.modified).toHaveLength(1);
		expect(analysis.transform.modified[0].before.preview).toBe("original question");
		expect(analysis.transform.modified[0].after.preview).toBe("rewritten question");
		expect(analysis.conversion.modified).toHaveLength(1);
		expect(analysis.conversion.modified[0].before.label).toBe("custom/memory");
		expect(analysis.conversion.modified[0].after.label).toBe("user");
	});

	it("includes system prompt and tool definitions in the final provider estimate", () => {
		const message = userMessage("hello", 1);
		const trace: ContextRequestTrace = {
			originalMessages: [message],
			transformedMessages: [message],
			llmMessages: [message],
			systemPrompt: "12345678",
			tools: [
				{
					name: "read",
					label: "Read",
					description: "Read a file",
					parameters: { type: "object", properties: {} },
				},
			],
		};

		const analysis = analyzeContextRequestTrace(trace);

		expect(analysis.finalProviderContext.systemPromptTokens).toBe(2);
		expect(analysis.finalProviderContext.toolTokens).toBeGreaterThan(0);
		expect(analysis.finalProviderContext.totalTokens).toBe(
			analysis.finalProviderContext.systemPromptTokens +
				analysis.finalProviderContext.toolTokens +
				analysis.finalProviderContext.messageTokens,
		);
	});

	it("does not guess modification pairs when timestamps collide", () => {
		const beforeA = userMessage("before A", 1);
		const beforeB = userMessage("before B", 1);
		const afterA = userMessage("after A", 1);
		const afterB = userMessage("after B", 1);
		const trace: ContextRequestTrace = {
			originalMessages: [beforeA, beforeB],
			transformedMessages: [afterA, afterB],
			llmMessages: [afterA, afterB],
			systemPrompt: "",
			tools: [],
		};

		const analysis = analyzeContextRequestTrace(trace);

		expect(analysis.transform.modified).toEqual([]);
		expect(analysis.transform.removed.map((message) => message.preview)).toEqual(["before A", "before B"]);
		expect(analysis.transform.injected.map((message) => message.preview)).toEqual(["after A", "after B"]);
	});

	it("renders collapsed and expanded request stages", () => {
		initTheme("dark");
		const message = userMessage("hello", 1);
		const trace: ContextRequestTrace = {
			originalMessages: [message],
			transformedMessages: [message],
			llmMessages: [message],
			systemPrompt: "system",
			tools: [],
		};
		const component = new ContextRequestTraceComponent(2, trace);

		const collapsed = stripAnsi(component.render(100).join("\n"));
		expect(collapsed).toContain("[context request #2]");
		expect(collapsed).toContain("Agent 1 → 1 | LLM 1");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(100).join("\n"));
		expect(expanded).toContain("① Agent state");
		expect(expanded).toContain("[0] user");
		expect(expanded).toContain("hello");
		expect(expanded).toContain("② After transformContext");
		expect(expanded).toContain("③ After convertToLlm");
		expect(expanded).toContain("④ Final provider context");
	});
});
