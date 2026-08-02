import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	type Message,
	type Model,
	type Models,
	type Usage,
} from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type CompactedToolCall,
	type CompactionDetails,
	type CompactionPreparation,
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	generateSummary,
	generateSummaryWithUsage,
	getLastAssistantUsage,
	prepareCompaction,
	serializeConversation,
	shouldCompact,
} from "../../src/harness/compaction/compaction.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { buildSessionContext, Session } from "../../src/harness/session/session.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CompactionSettings,
	CustomMessageEntry,
	MessageEntry,
	ModelChangeEntry,
	SessionTreeEntry,
	ThinkingLevelChangeEntry,
} from "../../src/harness/types.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import type { AgentMessage } from "../../src/types.ts";

let nextId = 0;
function createId(): string {
	return `entry-${nextId++}`;
}

function createMockUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function createAssistantMessage(text: string, usage = createMockUsage(100, 50)): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createMessageEntry(message: AgentMessage, parentId: string | null = null): MessageEntry {
	return {
		type: "message",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
}

function createCompactionEntry(
	summary: string,
	firstKeptEntryId: string,
	parentId: string | null = null,
	retainedTail?: AgentMessage[],
): CompactionEntry {
	return {
		type: "compaction",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 1234,
		retainedTail,
	};
}

function createThinkingLevelEntry(level: string, parentId: string | null = null): ThinkingLevelChangeEntry {
	return {
		type: "thinking_level_change",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		thinkingLevel: level,
	};
}

function createModelChangeEntry(provider: string, modelId: string, parentId: string | null = null): ModelChangeEntry {
	return {
		type: "model_change",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		provider,
		modelId,
	};
}

/** Shared collection; each faux provider gets a unique id so coexisting fakes route correctly. */
const models = createModels();
let fauxCount = 0;

function createFauxModel(reasoning: boolean, maxTokens = 8192): { faux: FauxProviderHandle; model: Model<string> } {
	const faux = fauxProvider({
		provider: `faux-${++fauxCount}`,
		models: [
			{
				id: reasoning ? "reasoning-model" : "non-reasoning-model",
				reasoning,
				contextWindow: 200000,
				maxTokens,
			},
		],
	});
	models.setProvider(faux.provider);
	return { faux, model: faux.getModel() };
}

function createModelsWithStreamingResponses(responses: AssistantMessage[]): Models {
	const remaining = [...responses];
	const stub = Object.create(models) as Models;
	stub.streamSimple = () => {
		const response = remaining.shift();
		if (!response) throw new Error("No faux streamSimple response queued");
		const stream = createAssistantMessageEventStream();
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			stream.push({ type: "error", reason: response.stopReason, error: response });
		} else {
			stream.push({ type: "done", reason: response.stopReason, message: response });
		}
		return stream;
	};
	return stub;
}

describe("harness compaction", () => {
	beforeEach(() => {
		nextId = 0;
	});

	it("calculates total context tokens from usage", () => {
		expect(calculateContextTokens(createMockUsage(1000, 500, 200, 100))).toBe(1800);
		expect(calculateContextTokens(createMockUsage(0, 0, 0, 0))).toBe(0);
	});

	it("checks compaction threshold", () => {
		const settings: CompactionSettings = {
			enabled: true,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};
		expect(shouldCompact(95000, 100000, settings)).toBe(true);
		expect(shouldCompact(89000, 100000, settings)).toBe(false);
		expect(shouldCompact(95000, 100000, { ...settings, enabled: false })).toBe(false);
	});

	it("finds a cut point based on token differences", () => {
		const entries: SessionTreeEntry[] = [];
		let parentId: string | null = null;
		for (let i = 0; i < 10; i++) {
			const user = createMessageEntry(createUserMessage(`User ${i}`), parentId);
			entries.push(user);
			const assistant = createMessageEntry(
				createAssistantMessage(`Assistant ${i}`, createMockUsage(0, 100, (i + 1) * 1000, 0)),
				user.id,
			);
			entries.push(assistant);
			parentId = assistant.id;
		}

		const result = findCutPoint(entries, 0, entries.length, 2500);
		expect(entries[result.firstKeptEntryIndex]?.type).toBe("message");
	});

	it("covers cut-point and turn-start edge cases", () => {
		const thinking = createThinkingLevelEntry("high");
		const modelChange = createModelChangeEntry("openai", "gpt-4", thinking.id);
		expect(findCutPoint([thinking, modelChange], 0, 2, 1)).toEqual({
			firstKeptEntryIndex: 0,
			turnStartIndex: -1,
			isSplitTurn: false,
		});

		const branchSummary: BranchSummaryEntry = {
			type: "branch_summary",
			id: createId(),
			parentId: modelChange.id,
			timestamp: new Date().toISOString(),
			fromId: "branch",
			summary: "branch summary",
		};
		const customMessage: CustomMessageEntry = {
			type: "custom_message",
			id: createId(),
			parentId: branchSummary.id,
			timestamp: new Date().toISOString(),
			customType: "note",
			content: "custom content",
			display: true,
		};
		expect(findTurnStartIndex([thinking, branchSummary], 1, 0)).toBe(1);
		expect(findTurnStartIndex([thinking, customMessage], 1, 0)).toBe(1);
		expect(findTurnStartIndex([thinking, modelChange], 1, 0)).toBe(-1);

		const result = findCutPoint([thinking, branchSummary, customMessage], 0, 3, 1);
		expect(result.firstKeptEntryIndex).toBe(0);

		const toolResult = createMessageEntry({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "tool output" }],
			isError: false,
			timestamp: Date.now(),
		});
		expect(findCutPoint([toolResult], 0, 1, 1)).toEqual({
			firstKeptEntryIndex: 0,
			turnStartIndex: -1,
			isSplitTurn: false,
		});

		const user = createMessageEntry(createUserMessage("user"));
		const compaction = createCompactionEntry("summary", user.id, user.id);
		const assistant = createMessageEntry(createAssistantMessage("assistant"), compaction.id);
		expect(findCutPoint([user, compaction, assistant], 0, 3, 1).firstKeptEntryIndex).toBe(2);
	});

	it("estimates tokens and context usage across supported message roles", () => {
		const usage = createMockUsage(10, 5, 3, 2);
		const assistant = createAssistantMessage("assistant", usage);
		const assistantWithThinkingAndTool: AssistantMessage = {
			...assistant,
			content: [
				{ type: "thinking", thinking: "thinking" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.ts" } },
			],
		};
		const customString: AgentMessage = {
			role: "custom",
			customType: "note",
			content: "custom text",
			display: true,
			timestamp: Date.now(),
		};
		const toolResultWithImage: AgentMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [
				{ type: "text", text: "tool text" },
				{ type: "image", mimeType: "image/png", data: "abc" },
			],
			isError: false,
			timestamp: Date.now(),
		};
		const bashExecution: AgentMessage = {
			role: "bashExecution",
			command: "npm run check",
			output: "ok",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: Date.now(),
		};
		const branchSummaryMessage: AgentMessage = {
			role: "branchSummary",
			summary: "branch",
			fromId: "x",
			timestamp: Date.now(),
		};
		const compactionSummaryMessage: AgentMessage = {
			role: "compactionSummary",
			summary: "compact",
			tokensBefore: 123,
			timestamp: Date.now(),
		};

		expect(estimateTokens({ role: "user", content: "plain user", timestamp: Date.now() })).toBeGreaterThan(0);
		expect(estimateTokens(assistantWithThinkingAndTool)).toBeGreaterThan(0);
		expect(estimateTokens(customString)).toBeGreaterThan(0);
		expect(estimateTokens(toolResultWithImage)).toBeGreaterThan(1000);
		expect(estimateTokens(bashExecution)).toBeGreaterThan(0);
		expect(estimateTokens(branchSummaryMessage)).toBeGreaterThan(0);
		expect(estimateTokens(compactionSummaryMessage)).toBeGreaterThan(0);
		expect(estimateTokens({ role: "unknown", timestamp: Date.now() } as unknown as AgentMessage)).toBe(0);
		expect(
			getLastAssistantUsage([createMessageEntry(createUserMessage("user")), createMessageEntry(assistant)]),
		).toBe(usage);
		expect(
			getLastAssistantUsage([
				createMessageEntry({ ...assistant, stopReason: "aborted" }),
				createMessageEntry({ ...assistant, stopReason: "error" }),
			]),
		).toBeUndefined();
		expect(
			getLastAssistantUsage([
				createMessageEntry(createUserMessage("user")),
				createMessageEntry(assistant),
				createMessageEntry(createAssistantMessage("partial", createMockUsage(0, 0))),
			]),
		).toBe(usage);
		expect(estimateContextTokens([createUserMessage("no usage")]).lastUsageIndex).toBeNull();
		expect(estimateContextTokens([assistant, createUserMessage("tail")])).toMatchObject({
			usageTokens: 20,
			lastUsageIndex: 0,
		});
		const estimate = estimateContextTokens([
			createUserMessage("Hello"),
			assistant,
			createUserMessage("continue"),
			createAssistantMessage("Partial thinking", createMockUsage(0, 0)),
		]);
		expect(estimate.usageTokens).toBe(20);
		expect(estimate.lastUsageIndex).toBe(1);
		expect(estimate.trailingTokens).toBeGreaterThan(0);
		expect(estimate.tokens).toBe(20 + estimate.trailingTokens);
	});

	it("builds session context with a compaction entry", () => {
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"), u1.id);
		const u2 = createMessageEntry(createUserMessage("2"), a1.id);
		const a2 = createMessageEntry(createAssistantMessage("b"), u2.id);
		const compaction = createCompactionEntry("Summary of 1,a,2,b", u2.id, a2.id, [
			createUserMessage("2"),
			createAssistantMessage("b"),
		]);
		const u3 = createMessageEntry(createUserMessage("3"), compaction.id);
		const a3 = createMessageEntry(createAssistantMessage("c"), u3.id);
		const loaded = buildSessionContext([u1, a1, u2, a2, compaction, u3, a3]);
		expect(loaded.messages).toHaveLength(5);
		expect(loaded.messages[0]?.role).toBe("compactionSummary");
		expect(loaded.messages.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
	});

	it("falls back to firstKeptEntryId when a compaction has no retained tail", () => {
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"), u1.id);
		const u2 = createMessageEntry(createUserMessage("2"), a1.id);
		const a2 = createMessageEntry(createAssistantMessage("b"), u2.id);
		const compaction = createCompactionEntry("Summary of 1,a,2,b", u2.id, a2.id);
		const u3 = createMessageEntry(createUserMessage("3"), compaction.id);
		const loaded = buildSessionContext([u1, a1, u2, a2, compaction, u3]);
		expect(loaded.messages.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
			"assistant",
			"user",
		]);
	});

	it("tracks model and thinking level changes in built context", () => {
		const user = createMessageEntry(createUserMessage("1"));
		const modelChange = createModelChangeEntry("openai", "gpt-4", user.id);
		const assistant = createMessageEntry(createAssistantMessage("a"), modelChange.id);
		const thinkingChange = createThinkingLevelEntry("high", assistant.id);
		const loaded = buildSessionContext([user, modelChange, assistant, thinkingChange]);
		expect(loaded.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(loaded.thinkingLevel).toBe("high");
	});

	it("prepares compaction using the latest compaction summary as previousSummary", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1"));
		const a1 = createMessageEntry(createAssistantMessage("assistant msg 1"), u1.id);
		const u2 = createMessageEntry(createUserMessage("user msg 2"), a1.id);
		const a2 = createMessageEntry(createAssistantMessage("assistant msg 2", createMockUsage(5000, 1000)), u2.id);
		const compaction1 = createCompactionEntry(
			"## Goal\nLegacy goal\n\n## Constraints & Preferences\n- Keep this constraint\n\n## Progress\n### Done\n- old work",
			u2.id,
			a2.id,
		);
		const u3 = createMessageEntry(createUserMessage("user msg 3"), compaction1.id);
		const a3 = createMessageEntry(createAssistantMessage("assistant msg 3", createMockUsage(8000, 2000)), u3.id);
		const pathEntries = [u1, a1, u2, a2, compaction1, u3, a3];
		const preparation = getOrThrow(prepareCompaction(pathEntries, DEFAULT_COMPACTION_SETTINGS));
		expect(preparation).toBeDefined();
		expect(preparation?.previousSummary).toBeUndefined();
		expect(preparation?.legacySummaryQuarantined).toBe(true);
		expect(preparation?.firstKeptEntryId).toBeTruthy();
		expect(preparation?.retainedTail.length).toBeGreaterThan(0);
		expect(preparation?.tokensBefore).toBe(estimateContextTokens(buildSessionContext(pathEntries).messages).tokens);
	});

	it("prepares split-turn compaction with prior file-operation details", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1"));
		const assistantMessage: AssistantMessage = {
			...createAssistantMessage("assistant msg 1"),
			content: [{ type: "toolCall", id: "tool-1", name: "write", arguments: { path: "written.ts" } }],
		};
		const a1 = createMessageEntry(assistantMessage, u1.id);
		const compaction1: CompactionEntry = {
			...createCompactionEntry("First summary", u1.id, a1.id),
			details: {
				formatVersion: 2,
				readFiles: ["old-read.ts"],
				modifiedFiles: ["old-edit.ts"],
			},
		};
		const u2 = createMessageEntry(createUserMessage("large turn"), compaction1.id);
		const a2 = createMessageEntry(createAssistantMessage("large assistant message"), u2.id);
		const preparation = getOrThrow(
			prepareCompaction([u1, a1, compaction1, u2, a2], {
				enabled: true,
				reserveTokens: 100,
				keepRecentTokens: 1,
			}),
		);

		expect(preparation).toMatchObject({ previousSummary: "First summary", isSplitTurn: true });
		expect(preparation?.turnPrefixMessages.map((message) => message.role)).toEqual(["user"]);
		expect([...preparation!.fileOps.read]).toContain("old-read.ts");
		expect([...preparation!.fileOps.edited]).toContain("old-edit.ts");
		expect([...preparation!.fileOps.written]).toContain("written.ts");
		expect(preparation?.userIntentHistory).toEqual(["user msg 1", "large turn"]);
		expect(preparation?.toolCallHistory).toEqual([
			{
				sequence: 1,
				id: "tool-1",
				name: "write",
				arguments: '{"path":"written.ts"}',
				status: "unknown",
				outputDisposition: "not_present",
			},
		]);
	});

	it("migrates legacy intent without sending the legacy summary back to the model", async () => {
		const legacyOutput = "LEGACY_TOOL_OUTPUT_MUST_NOT_REENTER";
		const legacyCompaction = createCompactionEntry(
			`## Goal\nPreserve the legacy goal\n\n## Constraints & Preferences\n- Keep legacy constraint\n\n## Progress\n### Done\n- ${legacyOutput}`,
			"old-kept",
			null,
			[],
		);
		const user = createMessageEntry(createUserMessage("Continue"), legacyCompaction.id);
		const assistant = createMessageEntry(createAssistantMessage("Continuing"), user.id);
		const preparation = getOrThrow(
			prepareCompaction([legacyCompaction, user, assistant], {
				enabled: true,
				reserveTokens: 2000,
				keepRecentTokens: 20000,
			}),
		);
		expect(preparation?.previousSummary).toBeUndefined();
		const { faux, model } = createFauxModel(false);
		let promptText = "";
		faux.setResponses([
			(context) => {
				const message = context.messages[0];
				const content = message?.role === "user" ? message.content : [];
				promptText = Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "";
				return fauxAssistantMessage("## Execution Checkpoint\n### In Progress\n- continuing");
			},
		]);

		const result = getOrThrow(await compact(preparation!, models, model));

		expect(promptText).not.toContain(legacyOutput);
		expect(result.summary).not.toContain(legacyOutput);
		expect(result.summary).not.toContain("Preserve the legacy goal");
		expect(result.summary).not.toContain("Keep legacy constraint");
		expect(result.summary).toContain("A legacy model-generated summary was withheld");
		expect((result.details as CompactionDetails).legacySummaryQuarantined).toBe(true);
	});

	it("removes outputs from tool results retained after the compaction cut", () => {
		const user = createMessageEntry(createUserMessage("Read the file"));
		const assistant = createMessageEntry(
			{
				...createAssistantMessage("Reading"),
				content: [{ type: "toolCall", id: "recent-call", name: "read", arguments: { path: "recent.ts" } }],
			},
			user.id,
		);
		const result = createMessageEntry(
			{
				role: "toolResult",
				toolCallId: "recent-call",
				toolName: "read",
				content: [{ type: "text", text: "RECENT_SECRET_OUTPUT" }],
				isError: false,
				timestamp: Date.now(),
			},
			assistant.id,
		);
		const preparation = getOrThrow(
			prepareCompaction([user, assistant, result], {
				enabled: true,
				reserveTokens: 2000,
				keepRecentTokens: 20000,
			}),
		);

		const retainedResult = preparation?.retainedTail.find((message) => message.role === "toolResult");
		expect(retainedResult?.role).toBe("toolResult");
		if (retainedResult?.role === "toolResult") {
			expect(retainedResult.content).toEqual([
				{
					type: "text",
					text: "[Tool output removed during compaction] tool=read id=recent-call status=success disposition=removed",
				},
			]);
		}
	});

	it("prepares custom and branch summary entries for summarization", () => {
		const branchSummary: BranchSummaryEntry = {
			type: "branch_summary",
			id: createId(),
			parentId: null,
			timestamp: new Date().toISOString(),
			fromId: "branch",
			summary: "branch summary",
		};
		const customMessage: CustomMessageEntry = {
			type: "custom_message",
			id: createId(),
			parentId: branchSummary.id,
			timestamp: new Date().toISOString(),
			customType: "note",
			content: "custom content",
			display: true,
		};
		const user = createMessageEntry(createUserMessage("keep"), customMessage.id);
		const assistant = createMessageEntry(createAssistantMessage("assistant"), user.id);
		const preparation = getOrThrow(
			prepareCompaction([branchSummary, customMessage, user, assistant], {
				enabled: true,
				reserveTokens: 100,
				keepRecentTokens: 1,
			}),
		);

		expect(preparation?.messagesToSummarize.map((message) => message.role)).toEqual(["branchSummary", "custom"]);
	});

	it("does not prepare compaction when there is nothing valid to compact", () => {
		const compaction = createCompactionEntry("already compacted", "entry-keep");
		expect(getOrThrow(prepareCompaction([compaction], DEFAULT_COMPACTION_SETTINGS))).toBeUndefined();
		expect(getOrThrow(prepareCompaction([], DEFAULT_COMPACTION_SETTINGS))).toBeUndefined();
	});

	it("serializes conversation with truncated tool results", () => {
		const longContent = "x".repeat(5000);
		const messages = convertMessages([
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		]);
		const result = serializeConversation(messages);
		expect(result).toContain("[Tool result]:");
		expect(result).toContain("[... 3000 more characters truncated]");
	});

	it("passes reasoning through generateSummary only for reasoning models with thinking enabled", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const seenOptions: Array<Record<string, unknown> | undefined> = [];
		const { faux: fauxReasoning, model: reasoningModel } = createFauxModel(true);
		fauxReasoning.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);
		getOrThrow(
			await generateSummary(messages, models, reasoningModel, 2000, undefined, undefined, undefined, "medium"),
		);
		expect(seenOptions[0]).toMatchObject({ reasoning: "medium" });

		const { faux: fauxOff, model: offModel } = createFauxModel(true);
		fauxOff.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);
		getOrThrow(await generateSummary(messages, models, offModel, 2000, undefined, undefined, undefined, "off"));
		expect(seenOptions[1]).not.toHaveProperty("reasoning");

		const { faux: fauxNonReasoning, model: nonReasoningModel } = createFauxModel(false);
		fauxNonReasoning.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);
		getOrThrow(
			await generateSummary(messages, models, nonReasoningModel, 2000, undefined, undefined, undefined, "medium"),
		);
		expect(seenOptions[2]).not.toHaveProperty("reasoning");
	});

	it("includes previous summaries and custom instructions in generateSummary prompts", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		let promptText = "";
		const { faux, model } = createFauxModel(false);
		faux.setResponses([
			(context) => {
				const message = context.messages[0];
				const content = message?.role === "user" ? message.content : [];
				promptText = Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "";
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);

		const summary = getOrThrow(
			await generateSummaryWithUsage(messages, models, model, 2000, undefined, "focus", "old summary"),
		);

		expect(summary.text).toContain("Test summary");
		expect(summary.usage.input).toBeGreaterThan(0);
		expect(summary.usage.output).toBeGreaterThan(0);
		expect(summary.usage.totalTokens).toBe(
			summary.usage.input + summary.usage.output + summary.usage.cacheRead + summary.usage.cacheWrite,
		);
		expect(promptText).toContain("<previous-summary>\nold summary\n</previous-summary>");
		expect(promptText).toContain("Additional focus: focus");
	});

	it("removes tool outputs before asking the summary model", async () => {
		const secretOutput = "SECRET_TOOL_OUTPUT";
		const secretBashOutput = "SECRET_BASH_OUTPUT";
		const assistant: AssistantMessage = {
			...createAssistantMessage("calling read"),
			content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/index.ts" } }],
		};
		const messages: AgentMessage[] = [
			createUserMessage("Inspect the file"),
			assistant,
			{
				role: "toolResult",
				toolCallId: "call-read",
				toolName: "read",
				content: [{ type: "text", text: secretOutput }],
				isError: false,
				timestamp: Date.now(),
			},
			{
				role: "bashExecution",
				command: "npm run check",
				output: secretBashOutput,
				exitCode: 0,
				cancelled: false,
				truncated: true,
				fullOutputPath: "C:/secret/full-output.txt",
				timestamp: Date.now(),
			},
		];
		let promptText = "";
		const { faux, model } = createFauxModel(false);
		faux.setResponses([
			(context) => {
				const message = context.messages[0];
				const content = message?.role === "user" ? message.content : [];
				promptText = Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "";
				return fauxAssistantMessage("## Execution Checkpoint\nNo output retained");
			},
		]);

		getOrThrow(await generateSummaryWithUsage(messages, models, model, 2000));

		expect(promptText).not.toContain(secretOutput);
		expect(promptText).not.toContain(secretBashOutput);
		expect(promptText).not.toContain("C:/secret/full-output.txt");
		expect(promptText).toContain("[Tool output removed during compaction]");
		expect(promptText).toContain("tool=read id=call-read status=success disposition=removed");
	});

	it("preserves the string result from generateSummary", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const { faux, model } = createFauxModel(false);
		faux.setResponses([fauxAssistantMessage("## Goal\nTest summary")]);

		expect(getOrThrow(await generateSummary(messages, models, model, 2000))).toBe("## Goal\nTest summary");
	});

	it("returns error results for failed or aborted summary generations", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const { faux: errorFaux, model: errorModel } = createFauxModel(false);
		errorFaux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
		const errorResult = await generateSummary(messages, models, errorModel, 2000);
		expect(errorResult).toMatchObject({
			ok: false,
			error: { code: "summarization_failed", message: "Summarization failed: boom" },
		});

		const { faux: abortedFaux, model: abortedModel } = createFauxModel(false);
		abortedFaux.setResponses([fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "stopped" })]);
		const abortedResult = await generateSummary(messages, models, abortedModel, 2000);
		expect(abortedResult).toMatchObject({ ok: false, error: { code: "aborted", message: "stopped" } });
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const seenOptions: Array<Record<string, unknown> | undefined> = [];
		const { faux, model } = createFauxModel(false, 128000);
		faux.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			retainedTail: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		getOrThrow(await compact(preparation, models, model));

		expect(seenOptions.map((options) => options?.maxTokens)).toEqual([128000, 128000]);
	});

	it("returns compaction error results without throwing", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			retainedTail: messages,
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};
		const { faux: historyFaux, model: historyModel } = createFauxModel(false);
		historyFaux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "history failed" })]);
		expect(await compact(preparation, models, historyModel)).toMatchObject({
			ok: false,
			error: { code: "summarization_failed", message: "Summarization failed: history failed" },
		});

		const { model: invalidModel } = createFauxModel(false);
		const invalidResult = await compact(
			{ ...preparation, messagesToSummarize: [], firstKeptEntryId: "" },
			models,
			invalidModel,
		);
		expect(invalidResult).toMatchObject({ ok: false, error: { code: "invalid_session" } });
	});

	it("combines usage for split-turn compaction summaries", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const { model } = createFauxModel(false);
		const historyUsage = createMockUsage(1, 2, 3, 4);
		const turnPrefixUsage = createMockUsage(5, 6, 7, 8);
		const usageModels = createModelsWithStreamingResponses([
			{ ...fauxAssistantMessage("history summary"), usage: historyUsage },
			{ ...fauxAssistantMessage("turn prefix summary"), usage: turnPrefixUsage },
		]);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			retainedTail: messages,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		const result = getOrThrow(await compact(preparation, usageModels, model));

		expect(result.usage).toEqual(createMockUsage(6, 8, 10, 12));
	});

	it("passes reasoning through turn-prefix summaries when enabled", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const seenOptions: Array<Record<string, unknown> | undefined> = [];
		const { faux, model } = createFauxModel(true);
		faux.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Original Request\nTest summary");
			},
		]);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			retainedTail: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		getOrThrow(await compact(preparation, models, model, undefined, undefined, "high"));

		expect(seenOptions[0]).toMatchObject({ reasoning: "high" });
	});

	it("returns turn-prefix compaction errors without throwing", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			retainedTail: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};
		const { faux, model } = createFauxModel(false);
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "prefix failed" })]);

		expect(await compact(preparation, models, model)).toMatchObject({
			ok: false,
			error: { code: "summarization_failed", message: "Turn prefix summarization failed: prefix failed" },
		});

		const { faux: abortedFaux, model: abortedModel } = createFauxModel(false);
		abortedFaux.setResponses([fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "prefix stopped" })]);
		expect(await compact(preparation, models, abortedModel)).toMatchObject({
			ok: false,
			error: { code: "aborted", message: "prefix stopped" },
		});
	});

	it("returns a compaction result with file details", async () => {
		const u1 = createMessageEntry(createUserMessage("read a file"));
		const assistantMessage: AssistantMessage = {
			...createAssistantMessage("calling tool", createMockUsage(1000, 200)),
			content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "src/index.ts" } }],
		};
		const a1 = createMessageEntry(assistantMessage, u1.id);
		const u2 = createMessageEntry(createUserMessage("continue"), a1.id);
		const a2 = createMessageEntry(createAssistantMessage("done", createMockUsage(4000, 500)), u2.id);
		const preparation = getOrThrow(prepareCompaction([u1, a1, u2, a2], DEFAULT_COMPACTION_SETTINGS));
		expect(preparation).toBeDefined();
		const { faux, model } = createFauxModel(false);
		faux.setResponses([fauxAssistantMessage("## Goal\nTest summary")]);
		const result = getOrThrow(await compact(preparation!, models, model));
		expect(result.summary.length).toBeGreaterThan(0);
		expect(result.firstKeptEntryId).toBeTruthy();
		expect(result.usage?.totalTokens).toBeGreaterThan(0);
		expect(result.retainedTail?.length).toBeGreaterThan(0);
		expect(result.details).toBeDefined();
	});

	it("retains exact user intent and tool-call records without tool output after compaction", async () => {
		const secretOutput = "SECRET_RESULT_".repeat(100);
		const initialRequest = createMessageEntry(createUserMessage("Inspect src/index.ts without editing it"));
		const assistantWithCall = createMessageEntry(
			{
				...createAssistantMessage("I will inspect it"),
				content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/index.ts" } }],
			},
			initialRequest.id,
		);
		const toolResult = createMessageEntry(
			{
				role: "toolResult",
				toolCallId: "call-read",
				toolName: "read",
				content: [{ type: "text", text: secretOutput }],
				isError: false,
				timestamp: Date.now(),
			},
			assistantWithCall.id,
		);
		const correction = createMessageEntry(createUserMessage("Actually, only report the filename"), toolResult.id);
		const finalAssistant = createMessageEntry(createAssistantMessage("src/index.ts"), correction.id);
		const preparation = getOrThrow(
			prepareCompaction([initialRequest, assistantWithCall, toolResult, correction, finalAssistant], {
				enabled: true,
				reserveTokens: 2000,
				keepRecentTokens: 100,
			}),
		);
		expect(preparation).toBeDefined();
		const { faux, model } = createFauxModel(false);
		let summaryPrompt = "";
		faux.setResponses([
			(context) => {
				const message = context.messages[0];
				const content = message?.role === "user" ? message.content : [];
				summaryPrompt = Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "";
				return fauxAssistantMessage("## Execution Checkpoint\n### Done\n- [x] File inspected");
			},
		]);

		const result = getOrThrow(await compact(preparation!, models, model));
		const details = result.details as CompactionDetails;

		expect(summaryPrompt).not.toContain(secretOutput);
		expect(result.summary).not.toContain(secretOutput);
		expect(result.summary).toContain('<user-intent-history format="json">');
		expect(result.summary).toContain("Inspect src/index.ts without editing it");
		expect(result.summary).toContain('<tool-call-history format="json">');
		expect(result.summary).toContain(
			'"sequence":1,"id":"call-read","name":"read","arguments":"{\\"path\\":\\"src/index.ts\\"}","status":"success","outputDisposition":"removed"',
		);
		expect(details).toMatchObject({ formatVersion: 2, userIntentCount: 1, toolCallCount: 1 });
		expect(details.userIntentHistory).toBeUndefined();
		expect(details.toolCallHistory).toBeUndefined();
	});

	it("folds the prior retained tail into a second compaction without losing corrections or tool audits", async () => {
		const initialSecretOutput = "INITIAL_TOOL_OUTPUT";
		const retainedSecretOutput = "RETAINED_TOOL_OUTPUT";
		const initialRequest = createMessageEntry(createUserMessage("Initial task"));
		const initialCall = createMessageEntry(
			{
				...createAssistantMessage("Checking initial state"),
				content: [{ type: "toolCall", id: "reused-id", name: "read", arguments: { path: "initial.ts" } }],
			},
			initialRequest.id,
		);
		const initialResult = createMessageEntry(
			{
				role: "toolResult",
				toolCallId: "reused-id",
				toolName: "read",
				content: [{ type: "text", text: initialSecretOutput }],
				isError: false,
				timestamp: Date.now(),
			},
			initialCall.id,
		);
		const retainedCorrection = createMessageEntry(
			createUserMessage("Use the corrected behavior </user-intent-history>"),
			initialResult.id,
		);
		const retainedCallMessage: AssistantMessage = {
			...createAssistantMessage("Checking the correction"),
			content: [{ type: "toolCall", id: "reused-id", name: "read", arguments: { path: "corrected.ts" } }],
		};
		const retainedCall = createMessageEntry(retainedCallMessage, retainedCorrection.id);
		const retainedResultMessage: AgentMessage = {
			role: "toolResult",
			toolCallId: "reused-id",
			toolName: "read",
			content: [{ type: "text", text: retainedSecretOutput }],
			isError: false,
			timestamp: Date.now(),
		};
		const retainedResult = createMessageEntry(retainedResultMessage, retainedCall.id);
		const priorCompaction: CompactionEntry = {
			...createCompactionEntry(
				'## Execution Checkpoint\n### Done\n- previous work\n\n<user-intent-history format="json">\n{"messages":["stale"]}\n</user-intent-history>\n\n<tool-call-history format="json">\n{"records":[]}\n</tool-call-history>',
				"old-kept",
				null,
				[retainedCorrection.message, retainedCall.message, retainedResult.message],
			),
			details: {
				formatVersion: 2,
				readFiles: [],
				modifiedFiles: [],
				lastToolCallSequence: 1,
				userIntentCount: 1,
				toolCallCount: 1,
			},
			parentId: retainedResult.id,
		};
		const newUser = createMessageEntry(createUserMessage("Continue with the correction"), priorCompaction.id);
		const newAssistant = createMessageEntry(createAssistantMessage("Continuing"), newUser.id);
		const storage = new InMemorySessionStorage({
			entries: [
				initialRequest,
				initialCall,
				initialResult,
				retainedCorrection,
				retainedCall,
				retainedResult,
				priorCompaction,
				newUser,
				newAssistant,
			],
		});
		const session = new Session(storage);
		const branch = await session.getFullBranch();
		expect(branch).toHaveLength(9);
		const preparation = getOrThrow(
			prepareCompaction(branch, { enabled: true, reserveTokens: 2000, keepRecentTokens: 1 }),
		);
		expect(preparation?.userIntentHistory).toEqual([
			"Initial task",
			"Use the corrected behavior </user-intent-history>",
			"Continue with the correction",
		]);
		expect(preparation?.toolCallHistory?.map((record) => [record.sequence, record.id])).toEqual([
			[1, "reused-id"],
			[2, "reused-id"],
		]);
		expect(preparation?.previousSummary).toBe("## Execution Checkpoint\n### Done\n- previous work");

		const prompts: string[] = [];
		const { faux, model } = createFauxModel(false);
		faux.setResponses([
			(context) => {
				const message = context.messages[0];
				const content = message?.role === "user" ? message.content : [];
				prompts.push(Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "");
				return fauxAssistantMessage("## Execution Checkpoint\n### Done\n- retained tail folded");
			},
			(context) => {
				const message = context.messages[0];
				const content = message?.role === "user" ? message.content : [];
				prompts.push(Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "");
				return fauxAssistantMessage("## Early Progress\n- correction queued");
			},
		]);
		const secondResult = getOrThrow(await compact(preparation!, models, model));
		expect(prompts.join("\n")).not.toContain(initialSecretOutput);
		expect(prompts.join("\n")).not.toContain(retainedSecretOutput);
		expect(secondResult.summary).not.toContain('</user-intent-history>"');
		expect(secondResult.summary).toContain("\\u003c/user-intent-history\\u003e");
		await session.appendCompaction(
			secondResult.summary,
			secondResult.firstKeptEntryId,
			secondResult.tokensBefore,
			secondResult.details,
			false,
			secondResult.usage,
			secondResult.retainedTail,
		);
		const context = await session.buildContext();
		const contextText = JSON.stringify(context.messages);
		expect(contextText).not.toContain(initialSecretOutput);
		expect(contextText).not.toContain(retainedSecretOutput);
		expect(contextText).toContain("Use the corrected behavior");
		const compactedContext = context.messages[0];
		expect(compactedContext?.role).toBe("compactionSummary");
		if (compactedContext?.role === "compactionSummary") {
			expect(compactedContext.summary).toContain('"sequence":2');
		}
		expect(secondResult.details as CompactionDetails).toMatchObject({
			formatVersion: 2,
			userIntentCount: 3,
			toolCallCount: 2,
		});
		expect((secondResult.details as CompactionDetails).userIntentHistory).toBeUndefined();
		expect((secondResult.details as CompactionDetails).toolCallHistory).toBeUndefined();
	});

	it("bounds deterministic intent and tool histories while reporting omitted records", async () => {
		const userIntentHistory = Array.from({ length: 80 }, (_, index) => `user-${index}-${"u".repeat(2000)}`);
		userIntentHistory[userIntentHistory.length - 1] = `LATEST_HEAD_${"z".repeat(70000)}_LATEST_TAIL`;
		const toolCallHistory = Array.from(
			{ length: 80 },
			(_, index): CompactedToolCall => ({
				sequence: index + 1,
				id: `call-${index}`,
				name: "read",
				arguments: JSON.stringify({ value: "a".repeat(1000) }),
				status: "success",
				outputDisposition: "removed",
			}),
		);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [createUserMessage("summarize")],
			turnPrefixMessages: [],
			retainedTail: [],
			isSplitTurn: false,
			tokensBefore: 200000,
			userIntentHistory,
			toolCallHistory,
			lastToolCallSequence: 80,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};
		const { faux, model } = createFauxModel(false);
		faux.setResponses([fauxAssistantMessage("## Execution Checkpoint\n### Done\n- bounded")]);

		const result = getOrThrow(await compact(preparation, models, model));
		const details = result.details as CompactionDetails;

		expect(details.omittedUserIntentCount).toBeGreaterThan(0);
		expect(details.omittedToolCallCount).toBeGreaterThan(0);
		expect(details).toMatchObject({ formatVersion: 2, userIntentCount: 80, toolCallCount: 80 });
		expect(details.userIntentHistory).toBeUndefined();
		expect(details.toolCallHistory).toBeUndefined();
		expect(result.summary).toContain('"omittedCount":');
		expect(result.summary).toContain('"oversizedLatestExcerpt":');
		expect(result.summary).toContain("LATEST_HEAD_");
		expect(result.summary).toContain("_LATEST_TAIL");
		expect(result.summary.length).toBeLessThan(110000);
	});
});

function convertMessages(messages: Message[]): Message[] {
	return messages;
}
