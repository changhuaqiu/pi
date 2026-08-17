import type { AgentMessage } from "../../../packages/agent/src/index.ts";

export interface ContextManagerOptions {
	readonly maxRetainedToolResultBytes?: number;
	readonly keepRecentToolResults?: number;
	readonly compactableToolNames: ReadonlySet<string>;
	readonly compactAfterUseToolNames?: ReadonlySet<string>;
}

export interface ToolResultContextStats {
	readonly compactedResults: number;
	readonly newlyCompactedResults: number;
	readonly retainedResults: number;
	readonly originalBytes: number;
	readonly projectedBytes: number;
}

export interface ContextProjectionChange {
	readonly messageIndex: number;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly reason: "after-use" | "budget";
	readonly newlyCompacted: boolean;
	readonly originalBytes: number;
	readonly projectedBytes: number;
}

export interface ContextSnapshot {
	readonly sequence: number;
	readonly sourceMessageCount: number;
	readonly projectedMessageCount: number;
	readonly messages: AgentMessage[];
	readonly toolResults: ToolResultContextStats;
	readonly changes: readonly ContextProjectionChange[];
}

export interface ContextSnapshotSummary {
	readonly sequence: number;
	readonly sourceMessageCount: number;
	readonly projectedMessageCount: number;
	readonly toolResults: ToolResultContextStats;
	readonly changes: readonly ContextProjectionChange[];
}

export interface ContextManager {
	prepare(messages: readonly AgentMessage[]): ContextSnapshot;
}

function toolResultBytes(
	message: Extract<AgentMessage, { role: "toolResult" }>,
): number {
	return message.content.reduce(
		(total, item) =>
			total + Buffer.byteLength(item.type === "text" ? item.text : item.data, "utf8"),
		0,
	);
}

function toolResultSummary(
	message: Extract<AgentMessage, { role: "toolResult" }>,
): string {
	const text = message.content
		.filter(
			(item): item is Extract<(typeof message.content)[number], { type: "text" }> =>
				item.type === "text",
		)
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

function toolResultFacts(
	message: Extract<AgentMessage, { role: "toolResult" }>,
): string | undefined {
	if (typeof message.details !== "object" || message.details === null) return undefined;
	const details = message.details as Record<string, unknown>;
	const keys = [
		"operation",
		"availability",
		"freshness",
		"truncated",
		"reused",
		"resultKey",
		"resultBytes",
		"sourceBytes",
		"resultCount",
		"fileCount",
		"edgeCount",
	] as const;
	const facts = keys.flatMap((key) => {
		const value = details[key];
		if (
			typeof value !== "string" &&
			typeof value !== "boolean" &&
			!(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
		) return [];
		const normalized = String(value).replace(/\s+/g, " ").trim();
		if (!normalized || normalized.length > 100) return [];
		return [`${key}=${normalized}`];
	});
	if (Array.isArray(details.anchors)) facts.push(`anchorsShown=${details.anchors.length}`);
	if (facts.length === 0) return undefined;
	const retained: string[] = [];
	for (const fact of facts) {
		if ([...retained, fact].join("; ").length > 500) break;
		retained.push(fact);
	}
	return retained.join("; ");
}

function compactToolResult(
	message: Extract<AgentMessage, { role: "toolResult" }>,
	originalBytes: number,
): Extract<AgentMessage, { role: "toolResult" }> {
	const outcome = message.isError ? "error" : "success";
	const anchors = toolResultAnchors(message);
	const facts = toolResultFacts(message);
	return {
		...message,
		content: [{
			type: "text",
			text: [
				"[Older tool result compacted for this provider request]",
				`tool=${message.toolName} outcome=${outcome} originalBytes=${originalBytes}`,
				...(facts === undefined ? [] : [`facts=${facts}`]),
				...(anchors === undefined ? [] : [`anchors=${anchors}`]),
				`summary=${toolResultSummary(message)}`,
				"The full result remains in Session history. Re-run a bounded tool call if exact content is needed.",
			].join("\n"),
		}],
	};
}

export function createContextManager(options: ContextManagerOptions): ContextManager {
	const maxRetainedBytes = options.maxRetainedToolResultBytes ?? 128 * 1024;
	const keepRecent = options.keepRecentToolResults ?? 2;
	if (!Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes <= 0) {
		throw new Error("Tool result context budget must be a positive safe integer");
	}
	if (!Number.isSafeInteger(keepRecent) || keepRecent < 0) {
		throw new Error("Recent tool result count must be a non-negative safe integer");
	}
	const compactableToolNames = new Set(options.compactableToolNames);
	const compactAfterUseToolNames = new Set(options.compactAfterUseToolNames);
	const compactionReasons = new Map<string, ContextProjectionChange["reason"]>();
	const previouslyProjectedToolCallIds = new Set<string>();
	let sequence = 0;

	return {
		prepare(messages) {
			sequence += 1;
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

			const newlyCompactedToolCallIds = new Set<string>();
			for (const candidate of candidates) {
				if (
					compactAfterUseToolNames.has(candidate.message.toolName) &&
					previouslyProjectedToolCallIds.has(candidate.message.toolCallId) &&
					!compactionReasons.has(candidate.message.toolCallId)
				) {
					compactionReasons.set(candidate.message.toolCallId, "after-use");
					newlyCompactedToolCallIds.add(candidate.message.toolCallId);
				}
			}

			const retained = candidates.filter(
				(candidate) =>
					compactableToolNames.has(candidate.message.toolName) &&
					!compactionReasons.has(candidate.message.toolCallId),
			);
			const retainedBytes = retained.reduce(
				(total, candidate) => total + candidate.bytes,
				0,
			);
			if (retainedBytes > maxRetainedBytes) {
				const protectedIds = new Set(
					retained.slice(Math.max(0, retained.length - keepRecent)).map(
						(candidate) => candidate.message.toolCallId,
					),
				);
				for (const candidate of retained) {
					if (protectedIds.has(candidate.message.toolCallId)) continue;
					compactionReasons.set(candidate.message.toolCallId, "budget");
					newlyCompactedToolCallIds.add(candidate.message.toolCallId);
				}
			}

			const projected = messages.slice();
			let compactedResults = 0;
			let retainedResults = 0;
			let originalBytes = 0;
			let projectedBytes = 0;
			const changes: ContextProjectionChange[] = [];
			for (const candidate of candidates) {
				originalBytes += candidate.bytes;
				const reason = compactionReasons.get(candidate.message.toolCallId);
				if (reason !== undefined) {
					const compacted = compactToolResult(candidate.message, candidate.bytes);
					const compactedBytes = toolResultBytes(compacted);
					projected[candidate.index] = compacted;
					projectedBytes += compactedBytes;
					compactedResults += 1;
					changes.push({
						messageIndex: candidate.index,
						toolCallId: candidate.message.toolCallId,
						toolName: candidate.message.toolName,
						reason,
						newlyCompacted: newlyCompactedToolCallIds.has(candidate.message.toolCallId),
						originalBytes: candidate.bytes,
						projectedBytes: compactedBytes,
					});
				} else {
					projectedBytes += candidate.bytes;
					retainedResults += 1;
				}
			}
			for (const candidate of candidates) {
				previouslyProjectedToolCallIds.add(candidate.message.toolCallId);
			}

			return {
				sequence,
				sourceMessageCount: messages.length,
				projectedMessageCount: projected.length,
				messages: projected,
				toolResults: {
					compactedResults,
					newlyCompactedResults: newlyCompactedToolCallIds.size,
					retainedResults,
					originalBytes,
					projectedBytes,
				},
				changes,
			};
		},
	};
}

export function summarizeContextSnapshot(
	snapshot: ContextSnapshot,
): ContextSnapshotSummary {
	return {
		sequence: snapshot.sequence,
		sourceMessageCount: snapshot.sourceMessageCount,
		projectedMessageCount: snapshot.projectedMessageCount,
		toolResults: snapshot.toolResults,
		changes: snapshot.changes,
	};
}
