import { createHash } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export interface ToolDecisionAuditRecord {
	phase: "decision";
	toolCallId: string;
	toolName: string;
	decision: "allowed" | "blocked";
	input: Record<string, unknown>;
	timestamp: string;
}

export interface ToolResultAuditRecord {
	phase: "result";
	toolCallId: string;
	toolName: string;
	outcome: "completed" | "failed";
	resultBytes: number;
	durationMs?: number;
	timestamp: string;
}

export type ToolAuditRecord = ToolDecisionAuditRecord | ToolResultAuditRecord;

export const DEFAULT_MAX_TOOL_RESULT_BYTES = 64 * 1024;
const SENSITIVE_FIELD_NAME = /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|secret|cookie|authorization)(?:$|[_-])/i;

export interface AuditTextSummary {
	bytes: number;
	sha256: string;
}

export function summarizeAuditText(value: string): AuditTextSummary {
	return {
		bytes: Buffer.byteLength(value, "utf8"),
		sha256: createHash("sha256").update(value, "utf8").digest("hex"),
	};
}

export function sanitizeAuditInput(
	input: Readonly<Record<string, unknown>>,
	root: string,
): Record<string, unknown> {
	const seen = new WeakSet<object>();
	const sanitize = (value: unknown, key?: string): unknown => {
		if (key && SENSITIVE_FIELD_NAME.test(key)) {
			return "<redacted>";
		}
		if (typeof value === "string" && key && /^(?:content|oldText|newText)$/i.test(key)) {
			return summarizeAuditText(value);
		}
		if (typeof value === "string") return redactSensitiveText(value, root);
		if (typeof value !== "object" || value === null) return value;
		if (seen.has(value)) return "<circular>";
		seen.add(value);
		if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
		return Object.fromEntries(
			Object.entries(value).map(([entryKey, entry]) => [entryKey, sanitize(entry, entryKey)]),
		);
	};
	return sanitize(input) as Record<string, unknown>;
}

export function createDecisionAuditRecord(
	toolCallId: string,
	toolName: string,
	inputSummary: Record<string, unknown>,
	decision: ToolDecisionAuditRecord["decision"],
): ToolDecisionAuditRecord {
	return {
		phase: "decision",
		toolCallId,
		toolName,
		decision,
		input: structuredClone(inputSummary),
		timestamp: new Date().toISOString(),
	};
}

export function createResultAuditRecord(
	toolCallId: string,
	toolName: string,
	outcome: ToolResultAuditRecord["outcome"],
	resultBytes: number,
	durationMs?: number,
): ToolResultAuditRecord {
	return {
		phase: "result",
		toolCallId,
		toolName,
		outcome,
		resultBytes,
		...(durationMs === undefined ? {} : { durationMs }),
		timestamp: new Date().toISOString(),
	};
}

export function freezeToolInput(input: Record<string, unknown>): void {
	const seen = new WeakSet<object>();
	const freeze = (value: unknown): void => {
		if (typeof value !== "object" || value === null || seen.has(value)) return;
		seen.add(value);
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	};
	freeze(input);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function redactSensitiveText(text: string, root: string): string {
	let result = text.replaceAll(root, "<workspace>").replaceAll(root.replaceAll("\\", "/"), "<workspace>");
	result = result.replace(/((?:Bearer|Basic)\s+)[^\s]+/gi, "$1<redacted>");
	result = result.replace(
		/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|secret|cookie|authorization)(\s*[:=]\s*)(["']?)[^\s,"'}]+/gi,
		"$1$2$3<redacted>",
	);
	result = result.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "<redacted-key>");
	result = result.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "<redacted-key>");
	return result.replace(/\bAKIA[0-9A-Z]{16}\b/g, "<redacted-key>");
}

function boundRedactedText(text: string, maxBytes: number): string {
	const suffix = "\n[tool result truncated after redaction]";
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return text;
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	if (maxBytes <= suffixBytes) return Buffer.from(suffix, "utf8").subarray(0, maxBytes).toString("utf8");
	const maxContentBytes = maxBytes - suffixBytes;
	let end = maxContentBytes;
	while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
	return `${buffer.subarray(0, end).toString("utf8")}${suffix}`;
}

function redactUnknown(value: unknown, root: string, seen: WeakSet<object>): unknown {
	if (typeof value === "string") return redactSensitiveText(value, root);
	if (!isRecord(value) && !Array.isArray(value)) return value;
	if (seen.has(value)) return "<circular>";
	seen.add(value);
	if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry, root, seen));
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			SENSITIVE_FIELD_NAME.test(key)
				? "<redacted>"
				: redactUnknown(entry, root, seen),
		]),
	);
}

export function redactSensitiveValue(value: unknown, root: string): unknown {
	return redactUnknown(value, root, new WeakSet());
}

function jsonBytes(value: unknown): number {
	if (value === undefined) return 0;
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function boundRedactedDetails(details: unknown, maxBytes: number): unknown {
	if (jsonBytes(details) <= maxBytes) return details;
	const marker = "<tool details truncated after redaction>";
	return jsonBytes(marker) <= maxBytes ? marker : undefined;
}

export function redactToolResult(
	content: AgentToolResult<unknown>["content"],
	details: unknown,
	root: string,
	maxTextBytes = DEFAULT_MAX_TOOL_RESULT_BYTES,
): { content: AgentToolResult<unknown>["content"]; details: unknown } {
	if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes <= 0) {
		throw new Error("Tool result byte limit must be a positive safe integer");
	}
	let remainingBytes = maxTextBytes;
	const governedContent: AgentToolResult<unknown>["content"] = [];
	for (const item of content) {
		if (remainingBytes <= 0) break;
		if (item.type === "text") {
			const text = boundRedactedText(
				redactSensitiveText(item.text, root),
				remainingBytes,
			);
			governedContent.push({ ...item, text });
			remainingBytes -= Buffer.byteLength(text, "utf8");
			continue;
		}
		const imageBytes = Buffer.byteLength(item.data, "utf8");
		if (imageBytes <= remainingBytes) {
			governedContent.push(item);
			remainingBytes -= imageBytes;
			continue;
		}
		const text = boundRedactedText("[tool image omitted: result limit exceeded]", remainingBytes);
		governedContent.push({ type: "text", text });
		remainingBytes -= Buffer.byteLength(text, "utf8");
	}
	const redactedDetails = redactUnknown(details, root, new WeakSet());
	return {
		content: governedContent,
		details: boundRedactedDetails(redactedDetails, remainingBytes),
	};
}
