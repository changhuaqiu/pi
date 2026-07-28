import type { ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

export interface WorkspaceInfoAuditRecord {
	toolCallId: string;
	toolName: "workspace_info";
	decision: "allowed" | "blocked";
	input: {
		include?: string[];
		maxEntries?: number;
	};
	timestamp: string;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactText(text: string, workspaceRoot: string): string {
	let redacted = text;
	const roots = new Set([workspaceRoot, workspaceRoot.replaceAll("\\", "/")]);
	for (const root of roots) {
		if (!root) continue;
		redacted = redacted.replace(new RegExp(escapeRegExp(root), "gi"), "<workspace>");
	}
	redacted = redacted.replace(/(Bearer\s+)[^\s]+/gi, "$1<redacted>");
	redacted = redacted.replace(
		/\b(api[_-]?key|access[_-]?token|token|password|secret)(\s*[:=]\s*)(["']?)[^\s,"'}]+/gi,
		"$1$2$3<redacted>",
	);
	return redacted;
}

function redactUnknown(value: unknown, workspaceRoot: string, seen: WeakSet<object>): unknown {
	if (typeof value === "string") return redactText(value, workspaceRoot);
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return "<circular>";
	seen.add(value);

	if (Array.isArray(value)) {
		return value.map((entry) => redactUnknown(entry, workspaceRoot, seen));
	}

	const redacted: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		redacted[key] = /api[_-]?key|access[_-]?token|token|password|secret/i.test(key)
			? "<redacted>"
			: redactUnknown(entry, workspaceRoot, seen);
	}
	return redacted;
}

export function createWorkspaceInfoAuditRecord(
	event: ToolCallEvent,
	decision: WorkspaceInfoAuditRecord["decision"],
	now: () => Date = () => new Date(),
): WorkspaceInfoAuditRecord | undefined {
	if (event.toolName !== "workspace_info") return undefined;
	const include = Array.isArray(event.input.include)
		? event.input.include.filter((value): value is string => typeof value === "string")
		: undefined;
	const maxEntries = typeof event.input.maxEntries === "number" ? event.input.maxEntries : undefined;
	return {
		toolCallId: event.toolCallId,
		toolName: "workspace_info",
		decision,
		input: {
			include,
			maxEntries,
		},
		timestamp: now().toISOString(),
	};
}

export function freezeWorkspaceInfoInput(event: ToolCallEvent): void {
	if (event.toolName !== "workspace_info") return;
	if (Array.isArray(event.input.include)) {
		Object.freeze(event.input.include);
	}
	Object.freeze(event.input);
}

export function redactWorkspaceInfoResult(event: ToolResultEvent, workspaceRoot: string) {
	if (event.toolName !== "workspace_info") return undefined;
	return {
		content: event.content.map((item) =>
			item.type === "text" ? { ...item, text: redactText(item.text, workspaceRoot) } : item,
		),
		details: redactUnknown(event.details, workspaceRoot, new WeakSet()),
	};
}
