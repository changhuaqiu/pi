import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export type WorkspaceEntryKind = "directory" | "file" | "other";

export interface WorkspaceEntry {
	name: string;
	kind: WorkspaceEntryKind;
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

/**
 * Read-only operations used by workspace_info.
 *
 * The interface intentionally exposes no write, delete, or command execution
 * capability. Tests and remote environments can provide their own adapter.
 */
export interface WorkspaceInfoOperations {
	listEntries(root: string, signal?: AbortSignal): Promise<WorkspaceEntry[]>;
	readPackageMetadata(root: string, signal?: AbortSignal): Promise<WorkspacePackageMetadata | undefined>;
	readGitMetadata(root: string, signal?: AbortSignal): Promise<WorkspaceGitMetadata | undefined>;
}

const MAX_METADATA_BYTES = 64 * 1024;

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	throw error;
}

function isMissingPathError(error: unknown): boolean {
	if (!(error instanceof Error) || !("code" in error)) return false;
	return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function isWithinRoot(root: string, target: string): boolean {
	const relativePath = relative(root, target);
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	);
}

async function readOptionalWorkspaceFile(
	root: string,
	segments: string[],
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	throwIfAborted(signal);
	const resolvedRoot = await realpath(root);
	let resolvedTarget: string;
	try {
		resolvedTarget = await realpath(join(resolvedRoot, ...segments));
	} catch (error) {
		if (isMissingPathError(error)) return undefined;
		throw error;
	}
	if (!isWithinRoot(resolvedRoot, resolvedTarget)) {
		throw new Error("Refusing to read workspace metadata outside the workspace root");
	}

	throwIfAborted(signal);
	const noFollow = constants.O_NOFOLLOW;
	const openFlags = typeof noFollow === "number" ? constants.O_RDONLY | noFollow : constants.O_RDONLY;
	const handle = await open(resolvedTarget, openFlags);
	try {
		const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		throwIfAborted(signal);
		if (bytesRead > MAX_METADATA_BYTES) {
			throw new Error(`Workspace metadata file exceeds ${MAX_METADATA_BYTES} bytes`);
		}
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function getWorkspaceCount(value: unknown): number | undefined {
	if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string").length;
	const record = asRecord(value);
	const packages = record?.packages;
	return Array.isArray(packages) ? packages.filter((entry) => typeof entry === "string").length : undefined;
}

/** Local filesystem adapter. The caller supplies the workspace root per invocation. */
export function createLocalWorkspaceInfoOperations(): WorkspaceInfoOperations {
	return {
		async listEntries(root, signal) {
			throwIfAborted(signal);
			const entries = await readdir(root, { withFileTypes: true });
			throwIfAborted(signal);
			return entries.map((entry) => ({
				name: entry.name,
				kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
			}));
		},

		async readPackageMetadata(root, signal) {
			const content = await readOptionalWorkspaceFile(root, ["package.json"], signal);
			if (content === undefined) return undefined;

			const parsed = asRecord(JSON.parse(content));
			if (!parsed) {
				throw new Error("package.json must contain a JSON object");
			}

			return {
				name: typeof parsed.name === "string" ? parsed.name : undefined,
				version: typeof parsed.version === "string" ? parsed.version : undefined,
				private: typeof parsed.private === "boolean" ? parsed.private : undefined,
				workspaceCount: getWorkspaceCount(parsed.workspaces),
			};
		},

		async readGitMetadata(root, signal) {
			const head = await readOptionalWorkspaceFile(root, [".git", "HEAD"], signal);
			if (head === undefined) return undefined;

			const value = head.trim();
			const branchPrefix = "ref: refs/heads/";
			if (value.startsWith(branchPrefix)) {
				return { branch: value.slice(branchPrefix.length) };
			}
			return value ? { detachedCommit: value.slice(0, 12) } : undefined;
		},
	};
}
