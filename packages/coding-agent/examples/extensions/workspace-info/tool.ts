import { basename } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type {
	WorkspaceEntry,
	WorkspaceGitMetadata,
	WorkspaceInfoOperations,
	WorkspacePackageMetadata,
} from "./operations.ts";

const workspaceInfoSectionSchema = Type.Union([Type.Literal("entries"), Type.Literal("package"), Type.Literal("git")]);

export const workspaceInfoSchema = Type.Object(
	{
		include: Type.Optional(
			Type.Array(workspaceInfoSectionSchema, {
				description: "Workspace information to include",
				minItems: 1,
				maxItems: 3,
				uniqueItems: true,
			}),
		),
		maxEntries: Type.Optional(
			Type.Integer({
				description: "Maximum number of top-level entries to return",
				minimum: 1,
				maximum: 100,
			}),
		),
	},
	{ additionalProperties: false },
);

export type WorkspaceInfoInput = Static<typeof workspaceInfoSchema>;
export type WorkspaceInfoSection = Static<typeof workspaceInfoSectionSchema>;
export type WorkspaceInfoStage = "validating" | "scanning" | "summarizing" | "completed";

export interface WorkspaceInfoDetails {
	stage: WorkspaceInfoStage;
	sections: WorkspaceInfoSection[];
	currentSection?: WorkspaceInfoSection;
	entryCount?: number;
	entriesTruncated?: boolean;
}

interface WorkspaceInfoSnapshot {
	entries?: WorkspaceEntry[];
	packageMetadata?: WorkspacePackageMetadata;
	gitMetadata?: WorkspaceGitMetadata;
}

const DEFAULT_SECTIONS: WorkspaceInfoSection[] = ["entries", "package", "git"];
const DEFAULT_MAX_ENTRIES = 50;
const MAX_VALUE_LENGTH = 200;
const workspaceInfoValidator = Compile(workspaceInfoSchema);

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	throw error;
}

function emitStage(
	onUpdate: AgentToolUpdateCallback<WorkspaceInfoDetails> | undefined,
	details: WorkspaceInfoDetails,
	signal: AbortSignal | undefined,
): void {
	throwIfAborted(signal);
	onUpdate?.({
		content: [
			{
				type: "text",
				text: `workspace_info: ${details.stage}${details.currentSection ? ` ${details.currentSection}` : ""}`,
			},
		],
		details,
	});
	throwIfAborted(signal);
}

export function isWorkspaceInfoInput(value: unknown): value is WorkspaceInfoInput {
	return workspaceInfoValidator.Check(value);
}

function validateAndCopyInput(value: unknown): WorkspaceInfoInput {
	if (!isWorkspaceInfoInput(value)) {
		throw new Error("workspace_info arguments failed execution-time validation");
	}
	return {
		include: value.include ? [...value.include] : undefined,
		maxEntries: value.maxEntries,
	};
}

function formatUntrustedValue(value: string): string {
	const escaped = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
		const codePoint = character.codePointAt(0);
		return codePoint === undefined ? "" : `\\u${codePoint.toString(16).padStart(4, "0")}`;
	});
	const limited = escaped.length <= MAX_VALUE_LENGTH ? escaped : `${escaped.slice(0, MAX_VALUE_LENGTH)}…`;
	return JSON.stringify(limited);
}

function formatEntries(entries: WorkspaceEntry[], maxEntries: number): { lines: string[]; truncated: boolean } {
	const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name));
	const visible = sorted.slice(0, maxEntries);
	const lines = visible.map((entry) => `- ${formatUntrustedValue(entry.name)} (${entry.kind})`);
	return { lines, truncated: sorted.length > visible.length };
}

function formatPackageMetadata(metadata: WorkspacePackageMetadata | undefined): string[] {
	if (!metadata) return ["Package: not found"];
	const fields = [
		metadata.name ? `name=${formatUntrustedValue(metadata.name)}` : undefined,
		metadata.version ? `version=${formatUntrustedValue(metadata.version)}` : undefined,
		metadata.private === undefined ? undefined : `private=${metadata.private}`,
		metadata.workspaceCount === undefined ? undefined : `workspaces=${metadata.workspaceCount}`,
	].filter((value): value is string => value !== undefined);
	return [`Package: ${fields.length > 0 ? fields.join(", ") : "metadata unavailable"}`];
}

function formatGitMetadata(metadata: WorkspaceGitMetadata | undefined): string[] {
	if (!metadata) return ["Git: not found"];
	if (metadata.branch) return [`Git branch: ${formatUntrustedValue(metadata.branch)}`];
	if (metadata.detachedCommit) return [`Git detached at: ${formatUntrustedValue(metadata.detachedCommit)}`];
	return ["Git: metadata unavailable"];
}

export async function inspectWorkspace(
	root: string,
	input: unknown,
	operations: WorkspaceInfoOperations,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<WorkspaceInfoDetails> | undefined,
): Promise<AgentToolResult<WorkspaceInfoDetails>> {
	throwIfAborted(signal);
	const validatedInput = validateAndCopyInput(input);
	const sections = validatedInput.include ? [...validatedInput.include] : [...DEFAULT_SECTIONS];
	const maxEntries = validatedInput.maxEntries ?? DEFAULT_MAX_ENTRIES;
	emitStage(onUpdate, { stage: "validating", sections }, signal);

	const snapshot: WorkspaceInfoSnapshot = {};
	for (const section of sections) {
		emitStage(onUpdate, { stage: "scanning", sections, currentSection: section }, signal);
		if (section === "entries") {
			snapshot.entries = await operations.listEntries(root, signal);
		} else if (section === "package") {
			snapshot.packageMetadata = await operations.readPackageMetadata(root, signal);
		} else {
			snapshot.gitMetadata = await operations.readGitMetadata(root, signal);
		}
		throwIfAborted(signal);
	}

	emitStage(onUpdate, { stage: "summarizing", sections }, signal);
	const lines = [`Workspace: ${formatUntrustedValue(basename(root) || ".")}`];
	let entryCount: number | undefined;
	let entriesTruncated = false;

	if (sections.includes("entries")) {
		const entries = snapshot.entries ?? [];
		const formatted = formatEntries(entries, maxEntries);
		entryCount = entries.length;
		entriesTruncated = formatted.truncated;
		lines.push(`Top-level entries: ${entries.length}${formatted.truncated ? ` (showing ${maxEntries})` : ""}`);
		lines.push(...formatted.lines);
	}
	if (sections.includes("package")) {
		lines.push(...formatPackageMetadata(snapshot.packageMetadata));
	}
	if (sections.includes("git")) {
		lines.push(...formatGitMetadata(snapshot.gitMetadata));
	}

	throwIfAborted(signal);
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			stage: "completed",
			sections,
			entryCount,
			entriesTruncated: sections.includes("entries") ? entriesTruncated : undefined,
		},
	};
}

export function createWorkspaceInfoTool(operations: WorkspaceInfoOperations) {
	return defineTool({
		name: "workspace_info",
		label: "workspace info",
		description:
			"Inspect bounded, read-only metadata about the current workspace: top-level entries, selected package metadata, and Git branch information. This tool cannot read arbitrary paths or modify files.",
		promptSnippet: "Inspect bounded read-only workspace metadata",
		promptGuidelines: [
			"Use workspace_info for a safe overview before deciding which files require closer inspection.",
		],
		parameters: workspaceInfoSchema,
		// Keep this sequential so a model cannot race it with a write-capable
		// tool call that swaps metadata paths after containment validation.
		executionMode: "sequential",
		async execute(_toolCallId, input, signal, onUpdate, ctx) {
			return inspectWorkspace(ctx.cwd, input, operations, signal, onUpdate);
		},
	});
}
