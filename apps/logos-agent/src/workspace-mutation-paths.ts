import { lstat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { normalizeRelativePath } from "./read-only-tools.ts";

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	throw error;
}

export function normalizeWorkspaceMutationPath(path: string): string {
	const normalized = normalizeRelativePath(path);
	if (normalized === ".") {
		throw new Error("Workspace root cannot be used as a mutation target");
	}
	if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalized)) {
		throw new Error(
			"Workspace mutation paths cannot contain Unicode control or formatting characters",
		);
	}
	return normalized;
}

export async function rejectLinkedDirectorySegments(
	workspaceRoot: string,
	targetDirectory: string,
	signal?: AbortSignal,
): Promise<void> {
	const pathFromRoot = relative(workspaceRoot, targetDirectory);
	if (!pathFromRoot) return;
	let current = workspaceRoot;
	for (const segment of pathFromRoot.split(sep)) {
		throwIfAborted(signal);
		current = join(current, segment);
		if ((await lstat(current)).isSymbolicLink()) {
			throw new Error("Symbolic links are not writable");
		}
	}
}
