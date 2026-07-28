import { createHash } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ControlledEditToolName } from "./controlled-edit-tools.ts";
import type { ReadOnlyToolName } from "./read-only-tools.ts";

export type LearningToolName = "workspace_info" | ReadOnlyToolName | ControlledEditToolName;

export interface ToolAuditRecord {
	toolCallId: string;
	toolName: LearningToolName;
	decision: "allowed" | "blocked";
	input: Record<string, unknown>;
	timestamp: string;
}

function hashAuditText(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function createAuditInput(toolName: LearningToolName, input: Record<string, unknown>): Record<string, unknown> {
	if (toolName !== "propose_patch") return structuredClone(input);
	const oldText = typeof input.oldText === "string" ? input.oldText : "";
	const newText = typeof input.newText === "string" ? input.newText : "";
	return {
		path: input.path,
		description: input.description,
		oldTextBytes: Buffer.byteLength(oldText, "utf8"),
		oldTextHash: hashAuditText(oldText),
		newTextBytes: Buffer.byteLength(newText, "utf8"),
		newTextHash: hashAuditText(newText),
	};
}

export function createAuditRecord(
	toolCallId: string,
	toolName: LearningToolName,
	input: Record<string, unknown>,
	decision: ToolAuditRecord["decision"],
): ToolAuditRecord {
	return {
		toolCallId,
		toolName,
		decision,
		input: createAuditInput(toolName, input),
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

function redactText(text: string, root: string): string {
	let result = text.replaceAll(root, "<workspace>").replaceAll(root.replaceAll("\\", "/"), "<workspace>");
	result = result.replace(/(Bearer\s+)[^\s]+/gi, "$1<redacted>");
	return result.replace(
		/\b(api[_-]?key|access[_-]?token|token|password|secret)(\s*[:=]\s*)(["']?)[^\s,"'}]+/gi,
		"$1$2$3<redacted>",
	);
}

function redactUnknown(value: unknown, root: string, seen: WeakSet<object>): unknown {
	if (typeof value === "string") return redactText(value, root);
	if (!isRecord(value) && !Array.isArray(value)) return value;
	if (seen.has(value)) return "<circular>";
	seen.add(value);
	if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry, root, seen));
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			/api[_-]?key|access[_-]?token|token|password|secret/i.test(key)
				? "<redacted>"
				: redactUnknown(entry, root, seen),
		]),
	);
}

export function redactToolResult(
	content: AgentToolResult<unknown>["content"],
	details: unknown,
	root: string,
): { content: AgentToolResult<unknown>["content"]; details: unknown } {
	return {
		content: content.map((item) => (item.type === "text" ? { ...item, text: redactText(item.text, root) } : item)),
		details: redactUnknown(details, root, new WeakSet()),
	};
}
