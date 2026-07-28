import type { AgentMessage, ContextRequestTrace } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { estimateTokens } from "./compaction/compaction.ts";

export interface ContextTraceSnapshot {
	messageCount: number;
	estimatedTokens: number;
	roles: Record<string, number>;
	contentTypes: Record<string, number>;
	messages: ContextTraceMessage[];
}

export interface ContextTraceMessage {
	index: number;
	role: string;
	label: string;
	preview: string;
	content: string;
	estimatedTokens: number;
}

export interface ContextTraceModification {
	before: ContextTraceMessage;
	after: ContextTraceMessage;
}

export interface ContextTraceDiff {
	removed: ContextTraceMessage[];
	injected: ContextTraceMessage[];
	modified: ContextTraceModification[];
}

export interface ContextRequestTraceAnalysis {
	agentState: ContextTraceSnapshot;
	transformed: ContextTraceSnapshot;
	llm: ContextTraceSnapshot;
	finalProviderContext: {
		systemPromptTokens: number;
		toolTokens: number;
		messageTokens: number;
		totalTokens: number;
	};
	transform: ContextTraceDiff;
	conversion: ContextTraceDiff;
}

type TraceableMessage = AgentMessage | Message;

interface InternalMessageDescriptor {
	public: ContextTraceMessage;
	fingerprint: string;
	identity: string;
}

const MAX_PREVIEW_LENGTH = 240;

export function analyzeContextRequestTrace(trace: ContextRequestTrace): ContextRequestTraceAnalysis {
	const agentState = summarizeMessages(trace.originalMessages);
	const transformed = summarizeMessages(trace.transformedMessages);
	const llm = summarizeMessages(trace.llmMessages);
	const systemPromptTokens = estimateTextTokens(trace.systemPrompt);
	const toolTokens = estimateTextTokens(safeJsonStringify(trace.tools));

	return {
		agentState,
		transformed,
		llm,
		finalProviderContext: {
			systemPromptTokens,
			toolTokens,
			messageTokens: llm.estimatedTokens,
			totalTokens: systemPromptTokens + toolTokens + llm.estimatedTokens,
		},
		transform: diffMessages(trace.originalMessages, trace.transformedMessages),
		conversion: diffMessages(trace.transformedMessages, trace.llmMessages),
	};
}

function summarizeMessages(messages: readonly TraceableMessage[]): ContextTraceSnapshot {
	const roles: Record<string, number> = {};
	const contentTypes: Record<string, number> = {};
	let estimatedTokens = 0;
	const messageDetails: ContextTraceMessage[] = [];

	for (const [index, message] of messages.entries()) {
		roles[message.role] = (roles[message.role] ?? 0) + 1;
		estimatedTokens += estimateMessageTokens(message);
		messageDetails.push(createDescriptor(message, index).public);
		for (const contentType of getContentTypes(message)) {
			contentTypes[contentType] = (contentTypes[contentType] ?? 0) + 1;
		}
	}

	return { messageCount: messages.length, estimatedTokens, roles, contentTypes, messages: messageDetails };
}

function diffMessages(before: readonly TraceableMessage[], after: readonly TraceableMessage[]): ContextTraceDiff {
	const beforeDescriptors = before.map(createDescriptor);
	const afterDescriptors = after.map(createDescriptor);
	const unmatchedBefore = new Set(beforeDescriptors.keys());
	const unmatchedAfter = new Set(afterDescriptors.keys());

	for (const beforeIndex of beforeDescriptors.keys()) {
		const match = afterDescriptors.findIndex(
			(descriptor, afterIndex) =>
				unmatchedAfter.has(afterIndex) && descriptor.fingerprint === beforeDescriptors[beforeIndex].fingerprint,
		);
		if (match !== -1) {
			unmatchedBefore.delete(beforeIndex);
			unmatchedAfter.delete(match);
		}
	}

	const modified: ContextTraceModification[] = [];
	pairUniqueModifications(beforeDescriptors, afterDescriptors, unmatchedBefore, unmatchedAfter, modified);
	pairUnambiguousConversions(beforeDescriptors, afterDescriptors, unmatchedBefore, unmatchedAfter, modified);

	return {
		removed: [...unmatchedBefore].map((index) => beforeDescriptors[index].public),
		injected: [...unmatchedAfter].map((index) => afterDescriptors[index].public),
		modified,
	};
}

function pairUniqueModifications(
	before: InternalMessageDescriptor[],
	after: InternalMessageDescriptor[],
	unmatchedBefore: Set<number>,
	unmatchedAfter: Set<number>,
	modified: ContextTraceModification[],
): void {
	const beforeByIdentity = groupIndexesByIdentity(before, unmatchedBefore);
	const afterByIdentity = groupIndexesByIdentity(after, unmatchedAfter);

	for (const [identity, beforeIndexes] of beforeByIdentity) {
		const afterIndexes = afterByIdentity.get(identity);
		if (beforeIndexes.length !== 1 || afterIndexes?.length !== 1) continue;
		recordModification(beforeIndexes[0], afterIndexes[0], before, after, unmatchedBefore, unmatchedAfter, modified);
	}
}

function pairUnambiguousConversions(
	before: InternalMessageDescriptor[],
	after: InternalMessageDescriptor[],
	unmatchedBefore: Set<number>,
	unmatchedAfter: Set<number>,
	modified: ContextTraceModification[],
): void {
	for (const beforeIndex of [...unmatchedBefore]) {
		const candidates = [...unmatchedAfter].filter(
			(afterIndex) =>
				before[beforeIndex].identity === after[afterIndex].identity &&
				before[beforeIndex].public.preview === after[afterIndex].public.preview,
		);
		if (candidates.length !== 1) continue;
		const afterIndex = candidates[0];
		const competingBefore = [...unmatchedBefore].filter(
			(index) =>
				before[index].identity === after[afterIndex].identity &&
				before[index].public.preview === after[afterIndex].public.preview,
		);
		if (competingBefore.length !== 1) continue;
		recordModification(beforeIndex, afterIndex, before, after, unmatchedBefore, unmatchedAfter, modified);
	}
}

function groupIndexesByIdentity(descriptors: InternalMessageDescriptor[], indexes: Set<number>): Map<string, number[]> {
	const grouped = new Map<string, number[]>();
	for (const index of indexes) {
		const identity = descriptors[index].identity;
		const group = grouped.get(identity);
		if (group) {
			group.push(index);
		} else {
			grouped.set(identity, [index]);
		}
	}
	return grouped;
}

function recordModification(
	beforeIndex: number,
	afterIndex: number,
	before: InternalMessageDescriptor[],
	after: InternalMessageDescriptor[],
	unmatchedBefore: Set<number>,
	unmatchedAfter: Set<number>,
	modified: ContextTraceModification[],
): void {
	modified.push({ before: before[beforeIndex].public, after: after[afterIndex].public });
	unmatchedBefore.delete(beforeIndex);
	unmatchedAfter.delete(afterIndex);
}

function createDescriptor(message: TraceableMessage, index: number): InternalMessageDescriptor {
	const timestamp = "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : -1;
	const toolCallId = "toolCallId" in message && typeof message.toolCallId === "string" ? message.toolCallId : "";
	const fingerprint = stableStringify(message);
	const content = getMessageContent(message);

	return {
		public: {
			index,
			role: message.role,
			label: getMessageLabel(message),
			preview: getMessagePreview(content),
			content,
			estimatedTokens: estimateMessageTokens(message),
		},
		fingerprint,
		identity: `${timestamp}:${toolCallId}`,
	};
}

function getMessageLabel(message: TraceableMessage): string {
	if ("customType" in message && typeof message.customType === "string") {
		return `${message.role}/${message.customType}`;
	}
	if ("toolName" in message && typeof message.toolName === "string") {
		return `${message.role}/${message.toolName}`;
	}
	return message.role;
}

function getContentTypes(message: TraceableMessage): string[] {
	if (!("content" in message)) {
		return [];
	}
	if (typeof message.content === "string") {
		return ["text"];
	}
	return message.content.map((part) => part.type);
}

function getMessageContent(message: TraceableMessage): string {
	let text: string;
	if ("summary" in message && typeof message.summary === "string") {
		text = message.summary;
	} else if ("command" in message && typeof message.command === "string") {
		const output = "output" in message && typeof message.output === "string" ? message.output : "";
		text = `$ ${message.command}\n${output}`;
	} else if ("content" in message) {
		if (typeof message.content === "string") {
			text = message.content;
		} else {
			text = message.content
				.map((part) => {
					if (part.type === "text") return part.text;
					if (part.type === "image") return "[image]";
					if (part.type === "thinking") return `[thinking] ${part.thinking}`;
					if (part.type === "toolCall") return `[toolCall ${part.name}] ${safeJsonStringify(part.arguments)}`;
					return "[unknown content]";
				})
				.join("\n");
		}
	} else {
		text = safeJsonStringify(message);
	}
	return text;
}

function getMessagePreview(content: string): string {
	const text = content;
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > MAX_PREVIEW_LENGTH ? `${normalized.slice(0, MAX_PREVIEW_LENGTH - 1)}…` : normalized;
}

function estimateMessageTokens(message: TraceableMessage): number {
	return estimateTokens(message as AgentMessage);
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function stableStringify(value: unknown): string {
	const ancestors = new Set<object>();

	const visit = (current: unknown): unknown => {
		if (current === null || typeof current !== "object") {
			return current;
		}
		if (ancestors.has(current)) {
			return "[circular]";
		}
		ancestors.add(current);
		const normalized = Array.isArray(current)
			? current.map(visit)
			: Object.fromEntries(
					Object.entries(current)
						.sort(([left], [right]) => left.localeCompare(right))
						.map(([key, entry]) => [key, visit(entry)]),
				);
		ancestors.delete(current);
		return normalized;
	};

	return safeJsonStringify(visit(value));
}
