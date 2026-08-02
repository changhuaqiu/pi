import type { AgentMessage } from "../../../packages/agent/src/index.ts";

export interface ToolResultContextProjectionOptions {
	readonly maxRetainedBytes?: number;
	readonly keepRecent?: number;
	readonly compactableToolNames: ReadonlySet<string>;
	readonly compactAfterUseToolNames?: ReadonlySet<string>;
}

export interface ToolResultContextProjectionStats {
	readonly compactedResults: number;
	readonly newlyCompactedResults: number;
	readonly retainedResults: number;
	readonly originalBytes: number;
	readonly projectedBytes: number;
}

export interface ToolResultContextProjection {
	readonly messages: AgentMessage[];
	readonly stats: ToolResultContextProjectionStats;
}

export interface ModelContextInput {
	readonly messages: readonly AgentMessage[];
}

export interface ModelContextContribution {
	readonly messages: readonly AgentMessage[];
	readonly afterUserText?: string;
	readonly replaceCustomTypes?: readonly string[];
}

export type ModelContextContributor = (
	input: ModelContextInput,
) => ModelContextContribution | undefined;

function userMessageText(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function findLastUserMessage(
	messages: readonly AgentMessage[],
	text: string,
): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (userMessageText(messages[index]!) === text) return index;
	}
	return -1;
}

function toolResultBytes(message: Extract<AgentMessage, { role: "toolResult" }>): number {
	return message.content.reduce(
		(total, item) =>
			total + Buffer.byteLength(item.type === "text" ? item.text : item.data, "utf8"),
		0,
	);
}

function toolResultSummary(message: Extract<AgentMessage, { role: "toolResult" }>): string {
	const text = message.content
		.filter((item): item is Extract<(typeof message.content)[number], { type: "text" }> => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (!text) return "No text summary was retained.";
	const normalized = text.replace(/\s+/g, " ");
	return normalized.length <= 300 ? normalized : `${normalized.slice(0, 297)}...`;
}

function toolResultAnchors(
	message: Extract<AgentMessage, { role: "toolResult" }>,
): string | undefined {
	if (typeof message.details !== "object" || message.details === null) return undefined;
	const details = message.details as Record<string, unknown>;
	if (!Array.isArray(details.anchors)) return undefined;
	const labels = details.anchors.flatMap((value) => {
		if (typeof value !== "object" || value === null) return [];
		const anchor = value as Record<string, unknown>;
		if (typeof anchor.name !== "string" || !anchor.name.trim()) return [];
		const normalizedName = anchor.name.replace(/\s+/g, " ").trim();
		const name = normalizedName.length <= 80
			? normalizedName
			: `${normalizedName.slice(0, 77)}...`;
		const normalizedFile = typeof anchor.file === "string"
			? anchor.file.replace(/\s+/g, " ").trim()
			: undefined;
		const file = normalizedFile === undefined || normalizedFile.length <= 160
			? normalizedFile
			: `${normalizedFile.slice(0, 79)}...${normalizedFile.slice(-78)}`;
		const line = typeof anchor.line === "number" && Number.isSafeInteger(anchor.line)
			? anchor.line
			: undefined;
		return [`${name}${file ? `@${file}${line === undefined ? "" : `:${line}`}` : ""}`];
	});
	if (labels.length === 0) return undefined;
	const retained: string[] = [];
	for (const label of labels.slice(0, 5)) {
		if ([...retained, label].join(", ").length > 300) break;
		retained.push(label);
	}
	return retained.join(", ");
}

function compactToolResult(
	message: Extract<AgentMessage, { role: "toolResult" }>,
	originalBytes: number,
): Extract<AgentMessage, { role: "toolResult" }> {
	const outcome = message.isError ? "error" : "success";
	const anchors = toolResultAnchors(message);
	return {
		...message,
		content: [{
			type: "text",
			text: [
				"[Older tool result compacted for this provider request]",
				`tool=${message.toolName} outcome=${outcome} originalBytes=${originalBytes}`,
				...(anchors === undefined ? [] : [`anchors=${anchors}`]),
				`summary=${toolResultSummary(message)}`,
				"The full result remains in Session history. Re-run a bounded tool call if exact content is needed.",
			].join("\n"),
		}],
	};
}

export function createToolResultContextProjector(
	options: ToolResultContextProjectionOptions,
): (messages: readonly AgentMessage[]) => ToolResultContextProjection {
	const maxRetainedBytes = options.maxRetainedBytes ?? 128 * 1024;
	const keepRecent = options.keepRecent ?? 2;
	if (!Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes <= 0) {
		throw new Error("Tool result context budget must be a positive safe integer");
	}
	if (!Number.isSafeInteger(keepRecent) || keepRecent < 0) {
		throw new Error("Recent tool result count must be a non-negative safe integer");
	}
	const compactableToolNames = new Set(options.compactableToolNames);
	const compactAfterUseToolNames = new Set(options.compactAfterUseToolNames);
	const compactedToolCallIds = new Set<string>();
	const previouslyProjectedToolCallIds = new Set<string>();
	return (messages) => {
		const candidates: Array<{
			index: number;
			message: Extract<AgentMessage, { role: "toolResult" }>;
			bytes: number;
		}> = [];
		for (let index = 0; index < messages.length; index += 1) {
			const message = messages[index]!;
			if (
				message.role !== "toolResult" ||
				(!compactableToolNames.has(message.toolName) &&
					!compactAfterUseToolNames.has(message.toolName))
			) continue;
			candidates.push({ index, message, bytes: toolResultBytes(message) });
		}
		let newlyCompactedResults = 0;
		for (const candidate of candidates) {
			if (
				compactAfterUseToolNames.has(candidate.message.toolName) &&
				previouslyProjectedToolCallIds.has(candidate.message.toolCallId) &&
				!compactedToolCallIds.has(candidate.message.toolCallId)
			) {
				compactedToolCallIds.add(candidate.message.toolCallId);
				newlyCompactedResults += 1;
			}
		}

		const retained = candidates.filter(
			(candidate) =>
				compactableToolNames.has(candidate.message.toolName) &&
				!compactedToolCallIds.has(candidate.message.toolCallId),
		);
		const retainedBytes = retained.reduce((total, candidate) => total + candidate.bytes, 0);
		if (retainedBytes > maxRetainedBytes) {
			const protectedIds = new Set(
				retained.slice(Math.max(0, retained.length - keepRecent)).map(
					(candidate) => candidate.message.toolCallId,
				),
			);
			for (const candidate of retained) {
				if (protectedIds.has(candidate.message.toolCallId)) continue;
				compactedToolCallIds.add(candidate.message.toolCallId);
				newlyCompactedResults += 1;
			}
		}

		const projected = messages.slice();
		let compactedResults = 0;
		let retainedResults = 0;
		let originalBytes = 0;
		let projectedBytes = 0;
		for (const candidate of candidates) {
			originalBytes += candidate.bytes;
			if (compactedToolCallIds.has(candidate.message.toolCallId)) {
				const compacted = compactToolResult(candidate.message, candidate.bytes);
				projected[candidate.index] = compacted;
				projectedBytes += toolResultBytes(compacted);
				compactedResults += 1;
			} else {
				projectedBytes += candidate.bytes;
				retainedResults += 1;
			}
		}
		for (const candidate of candidates) {
			previouslyProjectedToolCallIds.add(candidate.message.toolCallId);
		}

		return {
			messages: projected,
			stats: {
				compactedResults,
				newlyCompactedResults,
				retainedResults,
				originalBytes,
				projectedBytes,
			},
		};
	};
}

export function assembleModelContext(
	messages: readonly AgentMessage[],
	contributors: readonly ModelContextContributor[],
): AgentMessage[] {
	const contributions = contributors
		.map((contributor) => contributor({ messages: messages.slice() }))
		.filter(
			(contribution): contribution is ModelContextContribution =>
				contribution !== undefined,
		);
	const replacedCustomTypes = new Set(
		contributions.flatMap((contribution) => contribution.replaceCustomTypes ?? []),
	);
	const baseMessages = messages.filter(
		(message) =>
			message.role !== "custom" ||
			!replacedCustomTypes.has(message.customType),
	);
	const insertions = new Map<number, AgentMessage[]>();

	for (const contribution of contributions) {
		if (contribution.messages.length === 0) continue;
		const anchorIndex =
			contribution.afterUserText === undefined
				? baseMessages.length - 1
				: findLastUserMessage(baseMessages, contribution.afterUserText);
		if (contribution.afterUserText !== undefined && anchorIndex < 0) continue;
		const existing = insertions.get(anchorIndex);
		if (existing) existing.push(...contribution.messages);
		else insertions.set(anchorIndex, [...contribution.messages]);
	}

	const result = [...(insertions.get(-1) ?? [])];
	for (let index = 0; index < baseMessages.length; index += 1) {
		result.push(baseMessages[index]!, ...(insertions.get(index) ?? []));
	}
	return result;
}
