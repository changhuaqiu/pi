import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

export type WorkspaceInfoSection = "entries" | "package" | "git";

export interface WorkspaceEntry {
	name: string;
	kind: "directory" | "file" | "other";
}

export interface WorkspacePackageMetadata {
	name?: string;
	version?: string;
	private?: boolean;
	workspaceCount?: number;
}

export interface WorkspaceGitMetadata {
	branch?: string;
	detachedCommit?: string;
}

export interface WorkspaceInfoOperations {
	listEntries(signal?: AbortSignal): Promise<WorkspaceEntry[]>;
	readPackageMetadata(signal?: AbortSignal): Promise<WorkspacePackageMetadata | undefined>;
	readGitMetadata(signal?: AbortSignal): Promise<WorkspaceGitMetadata | undefined>;
}

export interface WorkspaceInfoDetails {
	stage: "validating" | "scanning" | "summarizing" | "completed";
	sections: WorkspaceInfoSection[];
	currentSection?: WorkspaceInfoSection;
	entryCount?: number;
	entriesTruncated?: boolean;
}

const sectionSchema = Type.Union([Type.Literal("entries"), Type.Literal("package"), Type.Literal("git")]);
const workspaceInfoSchema = Type.Object(
	{
		include: Type.Optional(Type.Array(sectionSchema, { minItems: 1, maxItems: 3, uniqueItems: true })),
		maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	},
	{ additionalProperties: false },
);
export type WorkspaceInfoInput = Static<typeof workspaceInfoSchema>;

const validator = Compile(workspaceInfoSchema);
const defaultSections: WorkspaceInfoSection[] = ["entries", "package", "git"];
const maxMetadataBytes = 64 * 1024;

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isWithinRoot(root: string, target: string): boolean {
	const pathFromRoot = relative(root, target);
	return (
		pathFromRoot === "" ||
		(pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
	);
}

async function readOptionalWorkspaceFile(
	root: string,
	segments: string[],
	signal?: AbortSignal,
): Promise<string | undefined> {
	throwIfAborted(signal);
	const resolvedRoot = await realpath(root);
	throwIfAborted(signal);
	let target: string;
	try {
		target = await realpath(join(resolvedRoot, ...segments));
	} catch (error) {
		if (isMissingPathError(error)) return undefined;
		throw error;
	}
	throwIfAborted(signal);
	if (!isWithinRoot(resolvedRoot, target)) {
		throw new Error("Refusing to read metadata outside the workspace root");
	}

	throwIfAborted(signal);
	const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		throwIfAborted(signal);
		const buffer = Buffer.alloc(maxMetadataBytes + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		throwIfAborted(signal);
		if (bytesRead > maxMetadataBytes) throw new Error(`Metadata exceeds ${maxMetadataBytes} bytes`);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

export function createNodeWorkspaceInfoOperations(root: string): WorkspaceInfoOperations {
	return {
		async listEntries(signal) {
			throwIfAborted(signal);
			const entries = await readdir(root, { withFileTypes: true });
			throwIfAborted(signal);
			return entries.map((entry) => ({
				name: entry.name,
				kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
			}));
		},
		async readPackageMetadata(signal) {
			const content = await readOptionalWorkspaceFile(root, ["package.json"], signal);
			if (content === undefined) return undefined;
			const parsed: unknown = JSON.parse(content);
			if (!isRecord(parsed)) throw new Error("package.json must contain an object");
			const workspaces = parsed.workspaces;
			return {
				name: typeof parsed.name === "string" ? parsed.name : undefined,
				version: typeof parsed.version === "string" ? parsed.version : undefined,
				private: typeof parsed.private === "boolean" ? parsed.private : undefined,
				workspaceCount: Array.isArray(workspaces)
					? workspaces.filter((value) => typeof value === "string").length
					: undefined,
			};
		},
		async readGitMetadata(signal) {
			const head = await readOptionalWorkspaceFile(root, [".git", "HEAD"], signal);
			if (head === undefined) return undefined;
			const value = head.trim();
			const prefix = "ref: refs/heads/";
			return value.startsWith(prefix)
				? { branch: value.slice(prefix.length) }
				: value
					? { detachedCommit: value.slice(0, 12) }
					: undefined;
		},
	};
}

function emitUpdate(
	onUpdate: AgentToolUpdateCallback<WorkspaceInfoDetails> | undefined,
	details: WorkspaceInfoDetails,
	signal?: AbortSignal,
): void {
	throwIfAborted(signal);
	onUpdate?.({
		content: [{ type: "text", text: `workspace_info: ${details.stage}` }],
		details,
	});
	throwIfAborted(signal);
}

export function createWorkspaceInfoTool(
	root: string,
	operations: WorkspaceInfoOperations,
): AgentTool<typeof workspaceInfoSchema, WorkspaceInfoDetails> {
	return {
		name: "workspace_info",
		label: "workspace info",
		description:
			"Inspect bounded, read-only metadata for the current workspace. It accepts no path and cannot modify files.",
		parameters: workspaceInfoSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal, onUpdate) {
			throwIfAborted(signal);
			if (!validator.Check(rawInput)) throw new Error("workspace_info arguments failed execution-time validation");
			const input: WorkspaceInfoInput = rawInput;
			const sections = input.include ? [...input.include] : [...defaultSections];
			const maxEntries = input.maxEntries ?? 50;
			emitUpdate(onUpdate, { stage: "validating", sections }, signal);

			const lines = [`Workspace: ${JSON.stringify(basename(root))}`];
			let entryCount: number | undefined;
			let entriesTruncated: boolean | undefined;
			for (const section of sections) {
				emitUpdate(onUpdate, { stage: "scanning", sections, currentSection: section }, signal);
				if (section === "entries") {
					const entries = (await operations.listEntries(signal)).sort((left, right) =>
						left.name.localeCompare(right.name),
					);
					throwIfAborted(signal);
					entryCount = entries.length;
					entriesTruncated = entries.length > maxEntries;
					lines.push(`Top-level entries: ${entries.length}${entriesTruncated ? ` (showing ${maxEntries})` : ""}`);
					lines.push(...entries.slice(0, maxEntries).map((entry) => `- ${JSON.stringify(entry.name)} (${entry.kind})`));
				} else if (section === "package") {
					const metadata = await operations.readPackageMetadata(signal);
					throwIfAborted(signal);
					lines.push(metadata ? `Package: ${JSON.stringify(metadata)}` : "Package: not found");
				} else {
					const metadata = await operations.readGitMetadata(signal);
					throwIfAborted(signal);
					lines.push(metadata ? `Git: ${JSON.stringify(metadata)}` : "Git: not found");
				}
			}
			emitUpdate(onUpdate, { stage: "summarizing", sections }, signal);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { stage: "completed", sections, entryCount, entriesTruncated },
			} satisfies AgentToolResult<WorkspaceInfoDetails>;
		},
	};
}
