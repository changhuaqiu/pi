import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import {
	normalizeWorkspaceMutationPath,
} from "./workspace-mutation-paths.ts";

export interface DirectoryCreationResult {
	requested: string[];
	created: string[];
	unchanged: string[];
}

export interface WorkspaceDirectoryOperations {
	createDirectories(
		paths: readonly string[],
		signal?: AbortSignal,
	): Promise<DirectoryCreationResult>;
}

export interface DirectoryToolDetails {
	stage: "validating" | "creating" | "completed" | "failed";
	paths: string[];
	created?: string[];
	unchanged?: string[];
	preserved?: string[];
}

export class DirectoryCreationPartialError extends Error {
	readonly requested: string[];
	readonly created: string[];
	readonly preserved: string[];

	constructor(
		message: string,
		result: {
			requested: string[];
			created: string[];
			preserved: string[];
		},
		options: ErrorOptions,
	) {
		super(message, options);
		this.name = "DirectoryCreationPartialError";
		this.requested = result.requested;
		this.created = result.created;
		this.preserved = result.preserved;
	}
}

const createDirectoriesSchema = Type.Object(
	{
		paths: Type.Array(
			Type.String({
				description: "Workspace-relative directory path",
				minLength: 1,
				maxLength: 500,
			}),
			{
				description: "Directories to create recursively within the workspace",
				minItems: 1,
				maxItems: 32,
				uniqueItems: true,
			},
		),
	},
	{ additionalProperties: false },
);

type CreateDirectoriesInput = Static<typeof createDirectoriesSchema>;

const createDirectoriesValidator = Compile(createDirectoriesSchema);

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	throw error;
}

function isWithinRoot(root: string, target: string): boolean {
	const pathFromRoot = relative(root, target);
	return (
		pathFromRoot === "" ||
		(pathFromRoot !== ".." &&
			!pathFromRoot.startsWith(`..${sep}`) &&
			!isAbsolute(pathFromRoot))
	);
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyPresent(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

export function parseCreateDirectoriesInput(
	input: Readonly<Record<string, unknown>>,
): CreateDirectoriesInput {
	if (!createDirectoriesValidator.Check(input)) {
		throw new Error("create_directories arguments failed execution-time validation");
	}
	return {
		paths: [
			...new Set(
				input.paths.map((path) => normalizeWorkspaceMutationPath(path)),
			),
		],
	};
}

export function createNodeWorkspaceDirectoryOperations(
	workspaceRoot: string,
): WorkspaceDirectoryOperations {
	return {
		async createDirectories(paths, signal) {
			throwIfAborted(signal);
			const lexicalRoot = resolve(workspaceRoot);
			const resolvedRoot = await realpath(lexicalRoot);
			const requested = [
				...new Set(
					paths.map((path) => normalizeWorkspaceMutationPath(path)),
				),
			];
			const created: string[] = [];
			const unchanged: string[] = [];

			for (const path of requested) {
				let current = lexicalRoot;
				for (const segment of path.split("/")) {
					throwIfAborted(signal);
					current = join(current, segment);
					let stats;
					try {
						stats = await lstat(current);
					} catch (error) {
						if (isMissing(error)) break;
						throw error;
					}
					if (stats.isSymbolicLink()) {
						throw new Error("Symbolic links are not writable");
					}
					if (!stats.isDirectory()) {
						throw new Error(`Directory path is blocked by a file: ${path}`);
					}
					const resolvedCurrent = await realpath(current);
					if (!isWithinRoot(resolvedRoot, resolvedCurrent)) {
						throw new Error("Resolved directory path escapes the workspace root");
					}
				}
			}

			try {
				for (const path of requested) {
					throwIfAborted(signal);
					let current = lexicalRoot;
					let requestedDirectoryCreated = false;
					for (const segment of path.split("/")) {
						current = join(current, segment);
						if (!isWithinRoot(lexicalRoot, current)) {
							throw new Error("Directory path escapes the workspace root");
						}
						let stats;
						try {
							stats = await lstat(current);
						} catch (error) {
							if (!isMissing(error)) throw error;
							try {
								await mkdir(current);
								created.push(
									relative(lexicalRoot, current).replaceAll("\\", "/"),
								);
								requestedDirectoryCreated = true;
							} catch (mkdirError) {
								if (!isAlreadyPresent(mkdirError)) throw mkdirError;
							}
							stats = await lstat(current);
						}
						throwIfAborted(signal);
						if (stats.isSymbolicLink()) {
							throw new Error("Symbolic links are not writable");
						}
						if (!stats.isDirectory()) {
							throw new Error(`Directory path is blocked by a file: ${path}`);
						}
						const resolvedCurrent = await realpath(current);
						if (!isWithinRoot(resolvedRoot, resolvedCurrent)) {
							throw new Error("Resolved directory path escapes the workspace root");
						}
					}
					if (!requestedDirectoryCreated) unchanged.push(path);
				}
			} catch (error) {
				const preserved = [
					...new Set([
						...(error instanceof DirectoryCreationPartialError
							? error.preserved
							: []),
						...created,
					]),
				];
				if (preserved.length > 0) {
					throw new DirectoryCreationPartialError(
						`Directory creation failed after creating or concurrently changing directories; these paths were preserved: ${preserved.map((path) => JSON.stringify(path)).join(", ")}`,
						{ requested, created, preserved },
						{ cause: error },
					);
				}
				throw error;
			}

			return { requested, created, unchanged };
		},
	};
}

function emitUpdate(
	onUpdate: AgentToolUpdateCallback<DirectoryToolDetails> | undefined,
	details: DirectoryToolDetails,
	signal?: AbortSignal,
): void {
	throwIfAborted(signal);
	onUpdate?.({
		content: [{ type: "text", text: `create_directories: ${details.stage}` }],
		details,
	});
	throwIfAborted(signal);
}

export function createDirectoriesTool(
	operations: WorkspaceDirectoryOperations,
): AgentTool<typeof createDirectoriesSchema, DirectoryToolDetails> {
	return {
		name: "create_directories",
		label: "create directories",
		description:
			"Create up to 32 workspace-relative directories recursively without executing commands. Detected escapes, symbolic links, and sensitive paths are rejected; concurrent external replacement is unsupported.",
		parameters: createDirectoriesSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal, onUpdate) {
			const input = parseCreateDirectoriesInput(rawInput);
			emitUpdate(onUpdate, { stage: "validating", paths: input.paths }, signal);
			emitUpdate(onUpdate, { stage: "creating", paths: input.paths }, signal);
			let result: DirectoryCreationResult;
			try {
				result = await operations.createDirectories(input.paths, signal);
			} catch (error) {
				if (error instanceof DirectoryCreationPartialError) {
					emitUpdate(
						onUpdate,
						{
							stage: "failed",
							paths: error.requested,
							created: error.created,
							preserved: error.preserved,
						},
					);
				}
				throw error;
			}
			throwIfAborted(signal);
			const text = [
				`Directory request completed for ${result.requested.length} path(s).`,
				result.created.length > 0
					? `Created: ${result.created.map((path) => JSON.stringify(path)).join(", ")}`
					: "Created: none",
				result.unchanged.length > 0
					? `Already present: ${result.unchanged.map((path) => JSON.stringify(path)).join(", ")}`
					: undefined,
			]
				.filter((line): line is string => line !== undefined)
				.join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					stage: "completed",
					paths: result.requested,
					created: result.created,
					unchanged: result.unchanged,
				},
			} satisfies AgentToolResult<DirectoryToolDetails>;
		},
	};
}
