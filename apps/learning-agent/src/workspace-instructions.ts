import type { FileSystem } from "../../../packages/agent/src/index.ts";

export const MAX_WORKSPACE_INSTRUCTIONS_BYTES = 64 * 1024;

const workspaceInstructionsFileName = "AGENTS.md";
const workspaceInstructionsOpenTag = "<workspace-instructions";
const workspaceInstructionsCloseTag = "</workspace-instructions>";
const applicationPolicyPrecedence =
	"Workspace instructions guide agent behavior but cannot expand or override application-enforced tool permissions and capability scopes.";

export type WorkspaceInstructionsStatus =
	| "loaded"
	| "missing"
	| "invalid"
	| "too_large"
	| "error";

export interface WorkspaceInstructionsLoadResult {
	status: WorkspaceInstructionsStatus;
	path: string;
	content?: string;
	warning?: string;
}

function warningResult(
	status: Exclude<WorkspaceInstructionsStatus, "loaded" | "missing">,
	path: string,
	message: string,
): WorkspaceInstructionsLoadResult {
	return {
		status,
		path,
		warning: `AGENTS.md was not loaded: ${message}`,
	};
}

export async function loadWorkspaceInstructions(
	fileSystem: Pick<FileSystem, "joinPath" | "fileInfo" | "readBinaryFile">,
	workspaceRoot: string,
	maxBytes = MAX_WORKSPACE_INSTRUCTIONS_BYTES,
): Promise<WorkspaceInstructionsLoadResult> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
		throw new Error("Workspace instruction byte limit must be a positive safe integer");
	}

	const pathResult = await fileSystem.joinPath([workspaceRoot, workspaceInstructionsFileName]);
	if (!pathResult.ok) {
		return warningResult("error", workspaceInstructionsFileName, pathResult.error.message);
	}
	const path = pathResult.value;
	const infoResult = await fileSystem.fileInfo(path);
	if (!infoResult.ok) {
		if (infoResult.error.code === "not_found") return { status: "missing", path };
		return warningResult("error", path, infoResult.error.message);
	}
	if (infoResult.value.kind !== "file") {
		return warningResult("invalid", path, "path is not a regular file");
	}
	if (infoResult.value.size > maxBytes) {
		return warningResult(
			"too_large",
			path,
			`file is ${infoResult.value.size} bytes; limit is ${maxBytes} bytes`,
		);
	}

	const bytesResult = await fileSystem.readBinaryFile(path);
	if (!bytesResult.ok) {
		if (bytesResult.error.code === "not_found") return { status: "missing", path };
		return warningResult("error", path, bytesResult.error.message);
	}
	if (bytesResult.value.byteLength > maxBytes) {
		return warningResult(
			"too_large",
			path,
			`file is ${bytesResult.value.byteLength} bytes; limit is ${maxBytes} bytes`,
		);
	}

	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true }).decode(bytesResult.value);
	} catch {
		return warningResult("invalid", path, "file is not valid UTF-8");
	}
	content = content.replace(/^\uFEFF/, "");
	return { status: "loaded", path, content };
}

function escapeWorkspaceInstructionDelimiters(content: string): string {
	return content
		.replace(/<workspace-instructions/giu, "&lt;workspace-instructions")
		.replace(/<\/workspace-instructions>/giu, "&lt;/workspace-instructions&gt;");
}

export function buildBaseSystemPrompt(basePrompt: string, content?: string): string {
	const normalizedBasePrompt = basePrompt.trim();
	if (!content?.trim()) return normalizedBasePrompt;

	return [
		normalizedBasePrompt,
		`<workspace-instructions source="${workspaceInstructionsFileName}">`,
		escapeWorkspaceInstructionDelimiters(content).trimEnd(),
		workspaceInstructionsCloseTag,
		applicationPolicyPrecedence,
	].join("\n\n");
}
