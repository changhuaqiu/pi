import {
	type AssistantMessage,
	type Context,
	contentText,
	type ImageContent,
	type Model,
	type Models,
	type RetryCallbacks,
	type RetryPolicy,
	retryAssistantCall,
	type SimpleStreamOptions,
	type TextContent,
	type Usage,
} from "@earendil-works/pi-ai";
import type { AgentMessage, ThinkingLevel } from "../../types.ts";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import { buildSessionContext } from "../session/session.ts";
import { type CompactionEntry, CompactionError, err, ok, type Result, type SessionTreeEntry } from "../types.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	serializeConversation,
} from "./utils.ts";

/** File-operation details stored on generated compaction entries. */
export interface CompactionDetails {
	/** Structured compaction format. Missing on legacy entries. */
	formatVersion?: 2;
	/** Files read in the compacted history. */
	readFiles: string[];
	/** Files modified in the compacted history. */
	modifiedFiles: string[];
	/** Legacy cumulative snapshot retained only for transition compatibility. */
	userIntentHistory?: string[];
	/** Legacy cumulative snapshot retained only for transition compatibility. */
	toolCallHistory?: CompactedToolCall[];
	/** Older user messages omitted from the bounded deterministic context block. */
	omittedUserIntentCount?: number;
	/** Older tool-call records omitted from the bounded deterministic context block. */
	omittedToolCallCount?: number;
	/** Highest assigned tool-call sequence, including records omitted by the bound. */
	lastToolCallSequence?: number;
	/** Number of exact user messages represented by the compaction. */
	userIntentCount?: number;
	/** Number of tool invocations represented by the compaction. */
	toolCallCount?: number;
	/** Whether a legacy summary was quarantined because its content provenance is unknown. */
	legacySummaryQuarantined?: true;
}

/** Durable record of a tool invocation whose output is no longer present in compacted context. */
export interface CompactedToolCall {
	sequence: number;
	id: string;
	name: string;
	arguments: string;
	status: "success" | "error" | "cancelled" | "unknown";
	outputDisposition: "removed" | "empty" | "not_present";
}

const TOOL_OUTPUT_REMOVED_MARKER = "[Tool output removed during compaction]";
const MAX_USER_INTENT_HISTORY_CHARS = 64_000;
const MAX_TOOL_CALL_HISTORY_CHARS = 32_000;

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function textFromUserMessage(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			parts.push(block.text);
		} else if (block.type === "image") {
			parts.push("[Image omitted from compacted context; original remains in the session]");
		}
	}
	return parts.join("\n");
}

function hasToolOutput(message: Extract<AgentMessage, { role: "toolResult" }>): boolean {
	return message.content.some((block) => block.type === "image" || (block.type === "text" && block.text.length > 0));
}

function redactToolOutputs(messages: AgentMessage[]): AgentMessage[] {
	return messages.map((message) => {
		if (message.role === "toolResult") {
			const disposition = hasToolOutput(message) ? "removed" : "empty";
			return {
				...message,
				content: [
					{
						type: "text",
						text: `${TOOL_OUTPUT_REMOVED_MARKER} tool=${message.toolName} id=${message.toolCallId} status=${message.isError ? "error" : "success"} disposition=${disposition}`,
					},
				],
			};
		}
		if (message.role === "bashExecution") {
			return {
				...message,
				output: message.output ? TOOL_OUTPUT_REMOVED_MARKER : "",
				truncated: false,
				fullOutputPath: undefined,
			};
		}
		return message;
	});
}

function collectToolCalls(messages: AgentMessage[], startingSequence = 0): CompactedToolCall[] {
	const records: CompactedToolCall[] = [];
	const recordIndexes = new Map<string, number>();
	let sequence = startingSequence;
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				recordIndexes.set(block.id, records.length);
				records.push({
					sequence: ++sequence,
					id: block.id,
					name: block.name,
					arguments: safeJsonStringify(block.arguments),
					status: "unknown",
					outputDisposition: "not_present",
				});
			}
			continue;
		}
		if (message.role === "toolResult") {
			const existingIndex = recordIndexes.get(message.toolCallId);
			const record: CompactedToolCall = {
				sequence: existingIndex === undefined ? ++sequence : records[existingIndex].sequence,
				id: message.toolCallId,
				name: message.toolName,
				arguments: existingIndex === undefined ? "{}" : records[existingIndex].arguments,
				status: message.isError ? "error" : "success",
				outputDisposition: hasToolOutput(message) ? "removed" : "empty",
			};
			if (existingIndex === undefined) {
				recordIndexes.set(message.toolCallId, records.length);
				records.push(record);
			} else {
				records[existingIndex] = record;
			}
			continue;
		}
		if (message.role === "bashExecution") {
			records.push({
				sequence: ++sequence,
				id: `bash-${message.timestamp}`,
				name: "bash",
				arguments: safeJsonStringify({ command: message.command }),
				status: message.cancelled ? "cancelled" : message.exitCode === 0 ? "success" : "error",
				outputDisposition: message.output ? "removed" : "empty",
			});
		}
	}
	return records;
}

function isCompactedToolCall(value: unknown): value is CompactedToolCall {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<CompactedToolCall>;
	return (
		typeof record.sequence === "number" &&
		Number.isSafeInteger(record.sequence) &&
		record.sequence > 0 &&
		typeof record.id === "string" &&
		typeof record.name === "string" &&
		typeof record.arguments === "string" &&
		(record.status === "success" ||
			record.status === "error" ||
			record.status === "cancelled" ||
			record.status === "unknown") &&
		(record.outputDisposition === "removed" ||
			record.outputDisposition === "empty" ||
			record.outputDisposition === "not_present")
	);
}

function validNonNegativeInteger(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function boundUserIntentHistory(
	messages: string[],
	previousOmittedCount: number,
): {
	messages: string[];
	omittedCount: number;
	oversizedLatestExcerpt?: { originalChars: number; head: string; tail: string };
} {
	if (messages.length === 0) return { messages: [], omittedCount: previousOmittedCount };
	const latestMessage = messages[messages.length - 1];
	const oversizedLatestExcerpt =
		encodeManagedSection(latestMessage).length > MAX_USER_INTENT_HISTORY_CHARS
			? {
					originalChars: latestMessage.length,
					head: latestMessage.slice(0, 4000),
					tail: latestMessage.slice(-4000),
				}
			: undefined;
	const selectedIndexes = new Set<number>();
	let usedChars = 0;
	const candidateIndexes = [
		messages.length - 1,
		0,
		...Array.from({ length: Math.max(0, messages.length - 2) }, (_, index) => messages.length - index - 2),
	];
	for (const index of candidateIndexes) {
		if (selectedIndexes.has(index)) continue;
		const message = messages[index];
		const messageChars = encodeManagedSection(message).length;
		if (usedChars + messageChars > MAX_USER_INTENT_HISTORY_CHARS) continue;
		selectedIndexes.add(index);
		usedChars += messageChars;
	}
	const selected = [...selectedIndexes].sort((a, b) => a - b).map((index) => messages[index]);
	return {
		messages: selected,
		omittedCount: previousOmittedCount + messages.length - selected.length,
		oversizedLatestExcerpt,
	};
}

function boundToolCallHistory(
	records: CompactedToolCall[],
	previousOmittedCount: number,
): { records: CompactedToolCall[]; omittedCount: number } {
	const selected: CompactedToolCall[] = [];
	let usedChars = 0;
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index];
		let boundedRecord = record;
		let recordChars = encodeManagedSection(boundedRecord).length;
		if (recordChars > MAX_TOOL_CALL_HISTORY_CHARS) {
			boundedRecord = {
				...record,
				arguments: `[arguments omitted from compacted context; ${record.arguments.length} characters remain in the original session]`,
			};
			recordChars = encodeManagedSection(boundedRecord).length;
		}
		if (usedChars + recordChars > MAX_TOOL_CALL_HISTORY_CHARS) continue;
		selected.push(boundedRecord);
		usedChars += recordChars;
	}
	selected.reverse();
	return {
		records: selected,
		omittedCount: previousOmittedCount + records.length - selected.length,
	};
}

function stripManagedCompactionSections(summary: string): string {
	return summary
		.replace(/\n*<user-intent-history(?:\s[^>]*)?>[\s\S]*?<\/user-intent-history>\n*/g, "\n")
		.replace(/\n*<tool-call-history(?:\s[^>]*)?>[\s\S]*?<\/tool-call-history>\n*/g, "\n")
		.trim();
}

function encodeManagedSection(value: unknown): string {
	return safeJsonStringify(value).replace(/[<>&]/g, (character) => {
		switch (character) {
			case "<":
				return "\\u003c";
			case ">":
				return "\\u003e";
			default:
				return "\\u0026";
		}
	});
}

function formatUserIntentHistory(
	messages: string[],
	omittedCount: number,
	hasQuarantinedLegacySummary: boolean,
	oversizedLatestExcerpt?: { originalChars: number; head: string; tail: string },
): string {
	if (messages.length === 0 && omittedCount === 0 && !hasQuarantinedLegacySummary && !oversizedLatestExcerpt) {
		return "";
	}
	return `\n\n<user-intent-history format="json">\n${encodeManagedSection({
		precedence:
			"Messages are chronological, take precedence over the execution checkpoint, and later messages override earlier conflicts.",
		legacyContext: hasQuarantinedLegacySummary
			? {
					quarantined: true,
					warning:
						"A legacy model-generated summary was withheld because user intent and tool output could not be separated safely. Rely on verbatim messages and ask the user when intent is ambiguous.",
				}
			: undefined,
		omittedCount,
		oversizedLatestExcerpt: oversizedLatestExcerpt
			? {
					...oversizedLatestExcerpt,
					warning:
						"The latest message exceeded the projection bound; this deterministic head/tail excerpt is not verbatim-complete. The full message remains in compaction details.",
				}
			: undefined,
		messages,
	})}\n</user-intent-history>`;
}

function formatToolCallHistory(records: CompactedToolCall[], omittedCount: number): string {
	if (records.length === 0 && omittedCount === 0) return "";
	return `\n\n<tool-call-history format="json">\n${encodeManagedSection({ omittedCount, records })}\n</tool-call-history>`;
}

function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionTreeEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}
function getMessageFromEntry(entry: SessionTreeEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message as AgentMessage;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(
			entry.customType,
			entry.content as string | (TextContent | ImageContent)[],
			entry.display,
			entry.details,
			entry.timestamp,
		);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
	}
	return undefined;
}

function getMessageFromEntryForCompaction(entry: SessionTreeEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

/** Generated compaction data ready to be persisted as a compaction entry. */
export interface CompactionResult<T = unknown> {
	/** Summary text that replaces compacted history in future context. */
	summary: string;
	/** Entry id where retained history starts. Optional during Pi 2.0 transition. */
	firstKeptEntryId?: string;
	/** Estimated context tokens before compaction. */
	tokensBefore: number;
	/** Usage from the LLM call(s) that generated this summary, if available. */
	usage?: Usage;
	/** Retained recent messages stored directly on the compaction entry. Optional during Pi 2.0 transition. */
	retainedTail?: AgentMessage[];
	/** Optional implementation-specific details stored with the compaction entry. */
	details?: T;
}

export interface CompactionProgress {
	phase: "summarizing" | "turn_prefix" | "finalizing";
	/** Accumulated summary text produced so far. */
	text: string;
}

export type CompactionProgressCallback = (progress: CompactionProgress) => Promise<void> | void;

export async function completeSimpleWithRetries(
	models: Models,
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	onText?: (text: string) => Promise<void> | void,
): Promise<AssistantMessage> {
	return retryAssistantCall(
		async () => {
			if (!onText) return await models.completeSimple(model, context, options);
			let text = "";
			await onText(text);
			const stream = models.streamSimple(model, context, options);
			for await (const event of stream) {
				if (event.type !== "text_delta") continue;
				text += event.delta;
				await onText(text);
			}
			return await stream.result();
		},
		retry,
		options.signal,
		callbacks,
	);
}

function combineUsage(first: Usage, second: Usage): Usage {
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

/** Compaction thresholds and retention settings. */
export interface CompactionSettings {
	/** Enable automatic compaction decisions. */
	enabled: boolean;
	/** Tokens reserved for summary prompt and output. */
	reserveTokens: number;
	/** Approximate recent-context tokens to keep after compaction. */
	keepRecentTokens: number;
}

/** Default compaction settings used by the harness. */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

/** Calculate total context tokens from provider usage. */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (
			assistantMsg.stopReason !== "aborted" &&
			assistantMsg.stopReason !== "error" &&
			assistantMsg.usage &&
			calculateContextTokens(assistantMsg.usage) > 0
		) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/** Return usage from the last valid assistant message in session entries. */
export function getLastAssistantUsage(entries: SessionTreeEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message as AgentMessage);
			if (usage) return usage;
		}
	}
	return undefined;
}

/** Estimated context-token usage for a message list. */
export interface ContextUsageEstimate {
	/** Estimated total context tokens. */
	tokens: number;
	/** Tokens reported by the most recent assistant usage block. */
	usageTokens: number;
	/** Estimated tokens after the most recent assistant usage block. */
	trailingTokens: number;
	/** Index of the message that provided usage, or null when none exists. */
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	let minimumUsageIndex = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "compactionSummary") continue;
		if (message.retainedMessageCount === undefined) return undefined;
		minimumUsageIndex = i + message.retainedMessageCount + 1;
		break;
	}
	for (let i = messages.length - 1; i >= minimumUsageIndex; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/** Return whether context usage exceeds the configured compaction threshold. */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + safeJsonStringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}
function findValidCutPoints(entries: SessionTreeEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "active_tools_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
			case "session_info":
			case "leaf":
				break;
		}
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/** Find the user-visible message that starts the turn containing an entry. */
export function findTurnStartIndex(entries: SessionTreeEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

/** Cut point selected for compaction. */
export interface CutPointResult {
	/** Index of the first entry retained after compaction. */
	firstKeptEntryIndex: number;
	/** Index of the turn-start entry when the cut splits a turn, otherwise -1. */
	turnStartIndex: number;
	/** Whether the selected cut point splits an in-progress turn. */
	isSplitTurn: boolean;
}

/** Find the compaction cut point that keeps approximately the requested recent-token budget. */
export function findCutPoint(
	entries: SessionTreeEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0];

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const messageTokens = estimateTokens(entry.message as AgentMessage);
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			break;
		}
		cutIndex--;
	}
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured execution checkpoint that another LLM will use to continue the work.

User intent is preserved separately and appended deterministically. Do not invent, reinterpret, or restate the user's goal. Tool outputs have been removed intentionally. Do not infer or fabricate their contents.

Use this EXACT format:

## Execution Checkpoint
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE execution progress, decisions, file paths, errors, and unresolved context from the previous summary
- Do not add new interpretations of user intent. Preserve legacy Goal or Constraints sections only when no verbatim history is available
- REMOVE any quoted or verbatim tool-output content; preserve only the execution facts needed to continue
- ADD new progress, decisions, and context from the new messages
- User intent is preserved separately; do not invent, reinterpret, or restate it
- Tool outputs were removed intentionally; do not infer or fabricate their contents
- UPDATE the checkpoint: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Execution Checkpoint
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Generate or update a conversation summary for compaction. */
export async function generateSummary(
	currentMessages: AgentMessage[],
	models: Models,
	model: Model<any>,
	reserveTokens: number,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	onText?: (text: string) => Promise<void> | void,
): Promise<Result<string, CompactionError>> {
	const result = await generateSummaryWithUsage(
		currentMessages,
		models,
		model,
		reserveTokens,
		signal,
		customInstructions,
		previousSummary,
		thinkingLevel,
		retry,
		callbacks,
		onText,
	);
	return result.ok ? ok(result.value.text) : err(result.error);
}

/** Generate or update a conversation summary and return its provider usage. */
export async function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	models: Models,
	model: Model<any>,
	reserveTokens: number,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	onText?: (text: string) => Promise<void> | void,
): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}
	const llmMessages = convertToLlm(redactToolOutputs(currentMessages));
	const conversationText = serializeConversation(llmMessages);
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${stripManagedCompactionSections(previousSummary)}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const completionOptions =
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, signal, reasoning: thinkingLevel }
			: { maxTokens, signal };

	const response = await completeSimpleWithRetries(
		models,
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		completionOptions,
		retry,
		callbacks,
		onText,
	);
	if (response.stopReason === "aborted") {
		return err(new CompactionError("aborted", response.errorMessage || "Summarization aborted"));
	}
	if (response.stopReason === "error") {
		return err(
			new CompactionError(
				"summarization_failed",
				`Summarization failed: ${response.errorMessage || "Unknown error"}`,
			),
		);
	}

	const textContent = contentText(response.content);

	return ok({ text: textContent, usage: response.usage });
}

/** Prepared inputs for a compaction run. */
export interface CompactionPreparation {
	/** Entry id where retained history starts. */
	firstKeptEntryId: string;
	/** Messages summarized into the history summary. */
	messagesToSummarize: AgentMessage[];
	/** Prefix messages summarized separately when compaction splits a turn. */
	turnPrefixMessages: AgentMessage[];
	/** Recent messages retained after compaction and stored on the compaction entry. */
	retainedTail: AgentMessage[];
	/** Whether compaction splits a turn. */
	isSplitTurn: boolean;
	/** Estimated context tokens before compaction. */
	tokensBefore: number;
	/** Previous compaction summary used for iterative updates. */
	previousSummary?: string;
	/** Exact user-authored text accumulated outside the retained raw tail. */
	userIntentHistory?: string[];
	/** Accumulated tool invocations whose outputs are absent from compacted context. */
	toolCallHistory?: CompactedToolCall[];
	/** Highest assigned tool-call sequence. */
	lastToolCallSequence?: number;
	/** Whether a legacy summary was quarantined because its content provenance is unknown. */
	legacySummaryQuarantined?: true;
	/** File operations extracted from summarized history. */
	fileOps: FileOperations;
	/** Settings used to prepare compaction. */
	settings: CompactionSettings;
}

/** Prepare session entries for compaction, or return undefined when compaction is not applicable. */
export function prepareCompaction(
	pathEntries: SessionTreeEntry[],
	settings: CompactionSettings,
): Result<CompactionPreparation | undefined, CompactionError> {
	if (pathEntries.length === 0 || pathEntries[pathEntries.length - 1].type === "compaction") {
		return ok(undefined);
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let previousUserIntentHistory: string[] = [];
	let previousToolCallHistory: CompactedToolCall[] = [];
	let lastToolCallSequence = 0;
	let legacySummaryQuarantined: true | undefined;
	let previousRetainedTail: AgentMessage[] = [];
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousRetainedTail = prevCompaction.retainedTail ?? [];
		const details =
			!prevCompaction.fromHook && prevCompaction.details
				? (prevCompaction.details as Partial<CompactionDetails>)
				: undefined;
		const hasStructuredCompaction = details?.formatVersion === 2 || Array.isArray(details?.userIntentHistory);
		if (hasStructuredCompaction) {
			previousSummary = stripManagedCompactionSections(prevCompaction.summary);
			legacySummaryQuarantined = details.legacySummaryQuarantined === true ? true : undefined;
			if (details) {
				if (Array.isArray(details.userIntentHistory)) {
					previousUserIntentHistory = details.userIntentHistory.filter(
						(message): message is string => typeof message === "string",
					);
				}
				if (Array.isArray(details.toolCallHistory)) {
					previousToolCallHistory = details.toolCallHistory.filter(isCompactedToolCall);
				}
				lastToolCallSequence = validNonNegativeInteger(details.lastToolCallSequence);
				for (const record of previousToolCallHistory) {
					lastToolCallSequence = Math.max(lastToolCallSequence, record.sequence);
				}
			}
		} else {
			legacySummaryQuarantined = true;
		}
		if (prevCompaction.retainedTail) {
			boundaryStart = prevCompactionIndex + 1;
		} else {
			const firstKeptEntryIndex = prevCompaction.firstKeptEntryId
				? pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId)
				: -1;
			boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
		}
	}
	const boundaryEnd = pathEntries.length;

	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return err(new CompactionError("invalid_session", "First kept entry has no UUID - session may need migration"));
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const messagesToSummarize: AgentMessage[] = [...previousRetainedTail];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}
	const compactedMessages = cutPoint.isSplitTurn
		? [...messagesToSummarize, ...turnPrefixMessages]
		: messagesToSummarize;
	const messagesFromBranchHistory: AgentMessage[] = [];
	for (let i = 0; i < cutPoint.firstKeptEntryIndex; i++) {
		const message = getMessageFromEntryForCompaction(pathEntries[i]);
		if (message) messagesFromBranchHistory.push(message);
	}
	const hasFullPreCompactionHistory =
		prevCompactionIndex < 0 || pathEntries.slice(0, prevCompactionIndex).some((entry) => entry.type === "message");
	const durableMessages = hasFullPreCompactionHistory ? messagesFromBranchHistory : compactedMessages;
	const accumulatedUserIntentHistory = hasFullPreCompactionHistory
		? durableMessages.map(textFromUserMessage).filter((message): message is string => message !== undefined)
		: [
				...previousUserIntentHistory,
				...durableMessages.map(textFromUserMessage).filter((message): message is string => message !== undefined),
			];
	const accumulatedToolCallHistory = hasFullPreCompactionHistory
		? collectToolCalls(durableMessages)
		: [...previousToolCallHistory, ...collectToolCalls(durableMessages, lastToolCallSequence)];
	if (accumulatedToolCallHistory.length > 0) {
		lastToolCallSequence = accumulatedToolCallHistory[accumulatedToolCallHistory.length - 1].sequence;
	}
	const rawRetainedTail: AgentMessage[] = [];
	for (let i = cutPoint.firstKeptEntryIndex; i < boundaryEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) rawRetainedTail.push(msg);
	}
	const retainedTail = redactToolOutputs(rawRetainedTail);
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return ok({
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		retainedTail,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		userIntentHistory: accumulatedUserIntentHistory,
		toolCallHistory: accumulatedToolCallHistory,
		lastToolCallSequence,
		legacySummaryQuarantined,
		fileOps,
		settings,
	});
}

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

User intent is preserved separately and appended deterministically. Tool outputs have been removed intentionally. Do not infer their contents or restate the user's request.

Summarize only the execution context needed for the retained suffix:

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

export { serializeConversation } from "./utils.ts";

/** Generate compaction summary data from prepared session history. */
export async function compact(
	preparation: CompactionPreparation,
	models: Models,
	model: Model<any>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	onProgress?: CompactionProgressCallback,
): Promise<Result<CompactionResult, CompactionError>> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		retainedTail,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		userIntentHistory = [],
		toolCallHistory = [],
		lastToolCallSequence = 0,
		legacySummaryQuarantined,
		fileOps,
		settings,
	} = preparation;

	if (!firstKeptEntryId) {
		return err(new CompactionError("invalid_session", "First kept entry has no UUID - session may need migration"));
	}

	let summary: string;
	let summaryUsage: Usage;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		let historyText = "No prior history.";
		let historyUsage: Usage | undefined;
		if (messagesToSummarize.length > 0) {
			const historyResult = await generateSummaryWithUsage(
				messagesToSummarize,
				models,
				model,
				settings.reserveTokens,
				signal,
				customInstructions,
				previousSummary,
				thinkingLevel,
				retry,
				callbacks,
				async (text) => await onProgress?.({ phase: "summarizing", text }),
			);
			if (!historyResult.ok) return err(historyResult.error);
			historyText = historyResult.value.text;
			historyUsage = historyResult.value.usage;
		}
		const turnPrefixResult = await generateTurnPrefixSummary(
			turnPrefixMessages,
			models,
			model,
			settings.reserveTokens,
			signal,
			thinkingLevel,
			retry,
			callbacks,
			async (text) =>
				await onProgress?.({
					phase: "turn_prefix",
					text: `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${text}`,
				}),
		);
		if (!turnPrefixResult.ok) return err(turnPrefixResult.error);
		summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.value.text}`;
		summaryUsage = historyUsage
			? combineUsage(historyUsage, turnPrefixResult.value.usage)
			: turnPrefixResult.value.usage;
	} else {
		const summaryResult = await generateSummaryWithUsage(
			messagesToSummarize,
			models,
			model,
			settings.reserveTokens,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			retry,
			callbacks,
			async (text) => await onProgress?.({ phase: "summarizing", text }),
		);
		if (!summaryResult.ok) return err(summaryResult.error);
		summary = summaryResult.value.text;
		summaryUsage = summaryResult.value.usage;
	}

	const candidateUserIntentHistory =
		preparation.userIntentHistory !== undefined
			? userIntentHistory
			: [...messagesToSummarize, ...turnPrefixMessages]
					.map(textFromUserMessage)
					.filter((message): message is string => message !== undefined);
	const boundedUserIntentHistory = boundUserIntentHistory(candidateUserIntentHistory, 0);
	const candidateToolCallHistory =
		preparation.toolCallHistory !== undefined
			? toolCallHistory
			: collectToolCalls([...messagesToSummarize, ...turnPrefixMessages], lastToolCallSequence);
	const boundedToolCallHistory = boundToolCallHistory(candidateToolCallHistory, 0);
	const resultingLastToolCallSequence =
		candidateToolCallHistory.length > 0
			? candidateToolCallHistory[candidateToolCallHistory.length - 1].sequence
			: lastToolCallSequence;
	summary += formatUserIntentHistory(
		boundedUserIntentHistory.messages,
		boundedUserIntentHistory.omittedCount,
		legacySummaryQuarantined !== undefined,
		boundedUserIntentHistory.oversizedLatestExcerpt,
	);
	summary += formatToolCallHistory(boundedToolCallHistory.records, boundedToolCallHistory.omittedCount);
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);
	await onProgress?.({ phase: "finalizing", text: summary });

	return ok({
		summary,
		firstKeptEntryId,
		tokensBefore,
		usage: summaryUsage,
		retainedTail,
		details: {
			formatVersion: 2,
			readFiles,
			modifiedFiles,
			omittedUserIntentCount: boundedUserIntentHistory.omittedCount,
			omittedToolCallCount: boundedToolCallHistory.omittedCount,
			lastToolCallSequence: resultingLastToolCallSequence,
			userIntentCount: candidateUserIntentHistory.length,
			toolCallCount: candidateToolCallHistory.length,
			legacySummaryQuarantined,
		} as CompactionDetails,
	});
}
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	models: Models,
	model: Model<any>,
	reserveTokens: number,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	onText?: (text: string) => Promise<void> | void,
): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	const llmMessages = convertToLlm(redactToolOutputs(messages));
	const conversationText = serializeConversation(llmMessages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const completionOptions =
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, signal, reasoning: thinkingLevel }
			: { maxTokens, signal };
	const response = await completeSimpleWithRetries(
		models,
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		completionOptions,
		retry,
		callbacks,
		onText,
	);
	if (response.stopReason === "aborted") {
		return err(new CompactionError("aborted", response.errorMessage || "Turn prefix summarization aborted"));
	}
	if (response.stopReason === "error") {
		return err(
			new CompactionError(
				"summarization_failed",
				`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`,
			),
		);
	}

	return ok({
		text: contentText(response.content),
		usage: response.usage,
	});
}
