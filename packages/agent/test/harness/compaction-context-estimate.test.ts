import { describe, expect, it } from "vitest";
import { estimateContextTokens, estimateTokens } from "../../src/harness/compaction/compaction.ts";
import type { AgentMessage } from "../../src/types.ts";
import { createAssistantMessage } from "./session-test-utils.ts";

function createCompactionSummary(retainedMessageCount?: number): AgentMessage {
	return {
		role: "compactionSummary",
		summary: "Short replacement summary",
		tokensBefore: 100_000,
		retainedMessageCount,
		timestamp: 200,
	};
}

describe("post-compaction context estimates", () => {
	it("ignores retained assistant usage captured before the compaction", () => {
		const summary = createCompactionSummary(1);
		const retainedAssistant = createAssistantMessage("retained");
		if (retainedAssistant.role !== "assistant") throw new Error("Expected assistant message");
		retainedAssistant.timestamp = 300;
		retainedAssistant.usage.totalTokens = 100_000;

		const estimate = estimateContextTokens([summary, retainedAssistant]);

		expect(estimate.usageTokens).toBe(0);
		expect(estimate.tokens).toBe(estimateTokens(summary) + estimateTokens(retainedAssistant));
	});

	it("uses assistant usage produced after the compaction", () => {
		const summary = createCompactionSummary(0);
		const laterAssistant = createAssistantMessage("later");
		if (laterAssistant.role !== "assistant") throw new Error("Expected assistant message");
		laterAssistant.timestamp = 100;
		laterAssistant.usage.totalTokens = 500;

		expect(estimateContextTokens([summary, laterAssistant])).toMatchObject({
			tokens: 500,
			usageTokens: 500,
			lastUsageIndex: 1,
		});
	});

	it("uses conservative estimation for legacy summaries without retained metadata", () => {
		const summary = createCompactionSummary();
		const assistant = createAssistantMessage("legacy retained or new");
		if (assistant.role !== "assistant") throw new Error("Expected assistant message");
		assistant.usage.totalTokens = 100_000;

		const estimate = estimateContextTokens([summary, assistant]);

		expect(estimate.usageTokens).toBe(0);
		expect(estimate.tokens).toBe(estimateTokens(summary) + estimateTokens(assistant));
	});
});
