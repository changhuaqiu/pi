import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

export type ReadOnlyToolName = "list_files" | "read_file" | "search_text";

export interface WorkspaceFileEntry {
	path: string;
	kind: "directory" | "file";
}

export interface WorkspaceFileContent {
	path: string;
	startLine: number;
	endLine?: number;
	totalLines?: number;
	lineCount: number;
	text: string;
	truncated: boolean;
}

export interface WorkspaceSearchMatch {
	path: string;
	line: number;
	text: string;
}

export interface ReadOnlyWorkspaceOperations {
	listFiles(
		path: string,
		depth: number,
		maxEntries: number,
		signal?: AbortSignal,
	): Promise<{ entries: WorkspaceFileEntry[]; truncated: boolean }>;
	readFile(
		path: string,
		startLine: number,
		maxLines: number,
		signal?: AbortSignal,
	): Promise<WorkspaceFileContent>;
	searchText(
		path: string,
		query: string,
		caseSensitive: boolean,
		maxResults: number,
		signal?: AbortSignal,
	): Promise<{ matches: WorkspaceSearchMatch[]; truncated: boolean; filesScanned: number }>;
}

export interface ReadOnlyToolDetails {
	stage: "validating" | "scanning" | "completed";
	path: string;
	resultCount?: number;
	truncated?: boolean;
}

const listFilesSchema = Type.Object(
	{
		path: Type.Optional(Type.String({ description: "Workspace-relative directory", maxLength: 500 })),
		depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
		maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
	},
	{ additionalProperties: false },
);

const readFileSchema = Type.Object(
	{
		path: Type.String({ description: "Workspace-relative file path", minLength: 1, maxLength: 500 }),
		startLine: Type.Optional(Type.Integer({ minimum: 1 })),
		maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
	},
	{ additionalProperties: false },
);

const searchTextSchema = Type.Object(
	{
		query: Type.String({ description: "Literal text to search for", minLength: 1, maxLength: 200 }),
		path: Type.Optional(Type.String({ description: "Workspace-relative file or directory", maxLength: 500 })),
		caseSensitive: Type.Optional(Type.Boolean()),
		maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	},
	{ additionalProperties: false },
);

type ListFilesInput = Static<typeof listFilesSchema>;
type ReadFileInput = Static<typeof readFileSchema>;
type SearchTextInput = Static<typeof searchTextSchema>;

const listFilesValidator = Compile(listFilesSchema);
const readFileValidator = Compile(readFileSchema);
const searchTextValidator = Compile(searchTextSchema);
const blockedSegments = new Set([".git", ".data", "node_modules"]);
const blockedFileNames = new Set([
	".env",
	".netrc",
	".npmrc",
	".pypirc",
	"credentials",
	"credentials.json",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
	"id_rsa",
]);
const windowsDeviceName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const textExtensions = new Set([
	".c",
	".cc",
	".cjs",
	".cpp",
	".css",
	".go",
	".h",
	".hpp",
	".html",
	".java",
	".js",
	".json",
	".jsx",
	".kt",
	".kts",
	".md",
	".mjs",
	".py",
	".rs",
	".sh",
	".sql",
	".toml",
	".ts",
	".tsx",
	".txt",
	".xml",
	".yaml",
	".yml",
]);
const extensionlessTextFiles = new Set([
	"dockerfile",
	"license",
	"makefile",
	"readme",
]);
const maxReadOutputCharacters = 64 * 1024;
const maxReadScanBytes = 1024 * 1024;
const maxSearchFileBytes = 512 * 1024;
const maxSearchFiles = 2_000;
const maxSearchDepth = 20;
const maxSearchDirectories = 2_000;
const maxSearchEntries = 10_000;
const maxSearchLineLength = 500;

class BinaryFileError extends Error {
	constructor() {
		super("Binary files are not readable");
		this.name = "BinaryFileError";
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	throw error;
}

export function normalizeRelativePath(path: string): string {
	const trimmed = path.trim() || ".";
	if (isAbsolute(trimmed)) throw new Error("Only workspace-relative paths are allowed");
	const segments = trimmed.replaceAll("\\", "/").split("/").filter((segment) => segment && segment !== ".");
	if (segments.includes("..")) throw new Error("Parent path traversal is not allowed");
	for (const segment of segments) {
		const lower = segment.toLowerCase();
		if (segment.includes(":")) throw new Error("NTFS alternate data stream paths are not allowed");
		if (/[. ]$/.test(segment)) throw new Error("Path segments cannot end with dots or spaces");
		if (windowsDeviceName.test(segment)) throw new Error(`Windows device path is not allowed: ${segment}`);
		if (blockedSegments.has(lower)) throw new Error(`Path segment is not readable: ${segment}`);
		if (
			blockedFileNames.has(lower) ||
			lower.startsWith(".learning-agent-edit-") ||
			lower.startsWith(".env.") ||
			lower.endsWith(".pem") ||
			lower.endsWith(".key")
		) {
			throw new Error(`Sensitive file is not readable: ${segment}`);
		}
	}
	return segments.length === 0 ? "." : segments.join("/");
}

function isWithinRoot(root: string, target: string): boolean {
	const pathFromRoot = relative(root, target);
	return (
		pathFromRoot === "" ||
		(pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
	);
}

function toDisplayPath(root: string, target: string): string {
	return relative(root, target).replaceAll("\\", "/") || ".";
}

function isReadableEntryName(name: string): boolean {
	const lower = name.toLowerCase();
	return !(
		blockedSegments.has(lower) ||
		blockedFileNames.has(lower) ||
		lower.startsWith(".learning-agent-edit-") ||
		lower.startsWith(".env.") ||
		lower.endsWith(".pem") ||
		lower.endsWith(".key")
	);
}

function isTextCandidate(path: string): boolean {
	const name = basename(path).toLowerCase();
	const extension = extname(name);
	return textExtensions.has(extension) || extensionlessTextFiles.has(name);
}

async function resolveWorkspacePath(root: string, inputPath: string, signal?: AbortSignal): Promise<string> {
	throwIfAborted(signal);
	const normalized = normalizeRelativePath(inputPath);
	const lexicalRoot = resolve(root);
	const lexicalTarget = resolve(lexicalRoot, normalized);
	if (!isWithinRoot(lexicalRoot, lexicalTarget)) throw new Error("Path escapes the workspace root");
	const resolvedRoot = await realpath(lexicalRoot);
	throwIfAborted(signal);
	const resolvedTarget = await realpath(lexicalTarget);
	throwIfAborted(signal);
	if (!isWithinRoot(resolvedRoot, resolvedTarget)) throw new Error("Resolved path escapes the workspace root");
	return resolvedTarget;
}

async function readBoundedTextFile(
	path: string,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<{ buffer: Buffer; truncated: boolean }> {
	throwIfAborted(signal);
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		throwIfAborted(signal);
		const stats = await handle.stat();
		throwIfAborted(signal);
		if (!stats.isFile()) throw new Error("Path is not a file");
		const buffer = Buffer.alloc(Math.min(stats.size, maxBytes) + (stats.size > maxBytes ? 1 : 0));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		throwIfAborted(signal);
		const content = buffer.subarray(0, bytesRead);
		if (content.includes(0)) throw new BinaryFileError();
		return { buffer: content, truncated: stats.size > maxBytes };
	} finally {
		await handle.close();
	}
}

async function collectFiles(
	start: string,
	maxFiles: number,
	signal?: AbortSignal,
): Promise<{ files: string[]; truncated: boolean }> {
	const stats = await lstat(start);
	throwIfAborted(signal);
	if (stats.isFile()) return { files: [start], truncated: false };
	if (!stats.isDirectory()) throw new Error("Search path must be a file or directory");

	const files: string[] = [];
	let truncated = false;
	let hardStop = false;
	let directoriesVisited = 0;
	let entriesVisited = 0;
	const visit = async (directory: string, depth: number): Promise<void> => {
		throwIfAborted(signal);
		if (depth > maxSearchDepth || directoriesVisited >= maxSearchDirectories) {
			truncated = true;
			if (directoriesVisited >= maxSearchDirectories) hardStop = true;
			return;
		}
		directoriesVisited += 1;
		const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
			left.name.localeCompare(right.name),
		);
		throwIfAborted(signal);
		for (const entry of entries) {
			entriesVisited += 1;
			if (entriesVisited > maxSearchEntries) {
				truncated = true;
				hardStop = true;
				return;
			}
			if (!isReadableEntryName(entry.name) || entry.isSymbolicLink()) continue;
			const target = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (depth >= maxSearchDepth) {
					truncated = true;
					continue;
				}
				await visit(target, depth + 1);
			} else if (entry.isFile() && isTextCandidate(target)) {
				if (files.length >= maxFiles) {
					truncated = true;
					hardStop = true;
					return;
				}
				files.push(target);
			}
			if (hardStop) return;
		}
	};
	await visit(start, 0);
	return { files, truncated };
}

function sanitizeOutputText(value: string): string {
	return value.replace(
		/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

export function createNodeReadOnlyWorkspaceOperations(root: string): ReadOnlyWorkspaceOperations {
	return {
		async listFiles(path, depth, maxEntries, signal) {
			const resolvedRoot = await realpath(root);
			throwIfAborted(signal);
			const start = await resolveWorkspacePath(root, path, signal);
			const stats = await lstat(start);
			throwIfAborted(signal);
			if (!stats.isDirectory()) throw new Error("list_files path must be a directory");

			const entries: WorkspaceFileEntry[] = [];
			let truncated = false;
			const visit = async (directory: string, remainingDepth: number): Promise<void> => {
				const children = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
					left.name.localeCompare(right.name),
				);
				throwIfAborted(signal);
				for (const child of children) {
					if (!isReadableEntryName(child.name) || child.isSymbolicLink()) continue;
					if (entries.length >= maxEntries) {
						truncated = true;
						return;
					}
					const target = join(directory, child.name);
					if (child.isDirectory()) {
						entries.push({ path: toDisplayPath(resolvedRoot, target), kind: "directory" });
						if (remainingDepth > 1) await visit(target, remainingDepth - 1);
					} else if (child.isFile()) {
						entries.push({ path: toDisplayPath(resolvedRoot, target), kind: "file" });
					}
					if (truncated) return;
				}
			};
			await visit(start, depth);
			return { entries, truncated };
		},

		async readFile(path, startLine, maxLines, signal) {
			const resolvedRoot = await realpath(root);
			throwIfAborted(signal);
			const target = await resolveWorkspacePath(root, path, signal);
			const scanned = await readBoundedTextFile(target, maxReadScanBytes, signal);
			const allLines = scanned.buffer.toString("utf8").split(/\r?\n/);
			const startIndex = Math.min(startLine - 1, allLines.length);
			if (scanned.truncated && startIndex >= allLines.length) {
				throw new Error(`startLine ${startLine} is beyond the bounded ${maxReadScanBytes}-byte scan`);
			}
			const candidates = allLines.slice(startIndex, startIndex + maxLines);
			const selected: string[] = [];
			let outputCharacters = 0;
			for (const line of candidates) {
				const separatorLength = selected.length > 0 ? 1 : 0;
				const remaining = maxReadOutputCharacters - outputCharacters - separatorLength;
				if (remaining <= 0) break;
				selected.push(line.slice(0, remaining));
				outputCharacters += separatorLength + Math.min(line.length, remaining);
				if (line.length > remaining) break;
			}
			const truncated =
				scanned.truncated ||
				startIndex + selected.length < allLines.length ||
				selected.length < candidates.length ||
				selected.some((line, index) => line.length < candidates[index]!.length);
			return {
				path: toDisplayPath(resolvedRoot, target),
				startLine: selected.length > 0 ? startIndex + 1 : startLine,
				endLine: selected.length > 0 ? startIndex + selected.length : undefined,
				totalLines: scanned.truncated ? undefined : allLines.length,
				lineCount: selected.length,
				text: selected.join("\n"),
				truncated,
			};
		},

		async searchText(path, query, caseSensitive, maxResults, signal) {
			const resolvedRoot = await realpath(root);
			throwIfAborted(signal);
			const start = await resolveWorkspacePath(root, path, signal);
			const collected = await collectFiles(start, maxSearchFiles, signal);
			const matches: WorkspaceSearchMatch[] = [];
			const needle = caseSensitive ? query : query.toLocaleLowerCase();
			let filesScanned = 0;
			let truncated = collected.truncated;
			for (const file of collected.files) {
				throwIfAborted(signal);
				const stats = await lstat(file);
				throwIfAborted(signal);
				if (stats.size > maxSearchFileBytes) continue;
				let buffer: Buffer;
				try {
					({ buffer } = await readBoundedTextFile(file, maxSearchFileBytes, signal));
				} catch (error) {
					if (error instanceof BinaryFileError) continue;
					throw error;
				}
				filesScanned += 1;
				const lines = buffer.toString("utf8").split(/\r?\n/);
				for (let index = 0; index < lines.length; index += 1) {
					const line = lines[index]!;
					const haystack = caseSensitive ? line : line.toLocaleLowerCase();
					if (!haystack.includes(needle)) continue;
					matches.push({
						path: toDisplayPath(resolvedRoot, file),
						line: index + 1,
						text: line.slice(0, maxSearchLineLength),
					});
					if (matches.length >= maxResults) {
						truncated = true;
						break;
					}
				}
				if (matches.length >= maxResults) break;
			}
			return { matches, truncated, filesScanned };
		},
	};
}

function emitUpdate(
	toolName: ReadOnlyToolName,
	onUpdate: AgentToolUpdateCallback<ReadOnlyToolDetails> | undefined,
	details: ReadOnlyToolDetails,
	signal?: AbortSignal,
): void {
	throwIfAborted(signal);
	onUpdate?.({ content: [{ type: "text", text: `${toolName}: ${details.stage}` }], details });
	throwIfAborted(signal);
}

export function createListFilesTool(
	operations: ReadOnlyWorkspaceOperations,
): AgentTool<typeof listFilesSchema, ReadOnlyToolDetails> {
	return {
		name: "list_files",
		label: "list files",
		description:
			"List a bounded workspace-relative directory tree. Hidden credential files, dependency folders, sessions, Git metadata, and symlinks are excluded.",
		parameters: listFilesSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal, onUpdate) {
			if (!listFilesValidator.Check(rawInput)) throw new Error("list_files arguments failed execution-time validation");
			const input: ListFilesInput = rawInput;
			const path = input.path ?? ".";
			emitUpdate("list_files", onUpdate, { stage: "validating", path }, signal);
			emitUpdate("list_files", onUpdate, { stage: "scanning", path }, signal);
			const result = await operations.listFiles(path, input.depth ?? 2, input.maxEntries ?? 200, signal);
			throwIfAborted(signal);
			return {
				content: [
					{
						type: "text",
						text: [
							`Files under ${JSON.stringify(path)}: ${result.entries.length}${result.truncated ? " (truncated)" : ""}`,
							...result.entries.map((entry) => `- ${JSON.stringify(entry.path)} (${entry.kind})`),
						].join("\n"),
					},
				],
				details: {
					stage: "completed",
					path,
					resultCount: result.entries.length,
					truncated: result.truncated,
				},
			};
		},
	};
}

export function createReadFileTool(
	operations: ReadOnlyWorkspaceOperations,
): AgentTool<typeof readFileSchema, ReadOnlyToolDetails> {
	return {
		name: "read_file",
		label: "read file",
		description:
			"Read a bounded range from one text file using a workspace-relative path. Binary, credential, dependency, session, and Git metadata files are blocked.",
		parameters: readFileSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal, onUpdate) {
			if (!readFileValidator.Check(rawInput)) throw new Error("read_file arguments failed execution-time validation");
			const input: ReadFileInput = rawInput;
			emitUpdate("read_file", onUpdate, { stage: "validating", path: input.path }, signal);
			emitUpdate("read_file", onUpdate, { stage: "scanning", path: input.path }, signal);
			const result = await operations.readFile(input.path, input.startLine ?? 1, input.maxLines ?? 200, signal);
			throwIfAborted(signal);
			const numberedLines = result.text
				.split("\n")
				.map((line, index) => `${result.startLine + index}: ${sanitizeOutputText(line)}`)
				.join("\n");
			return {
				content: [
					{
						type: "text",
						text: [
							`${JSON.stringify(result.path)}:${result.startLine}-${result.endLine ?? "none"} of ${result.totalLines ?? "unknown total"}${result.truncated ? " (truncated)" : ""}`,
							numberedLines,
						].join("\n"),
					},
				],
				details: {
					stage: "completed",
					path: result.path,
					resultCount: result.lineCount,
					truncated: result.truncated,
				},
			} satisfies AgentToolResult<ReadOnlyToolDetails>;
		},
	};
}

export function createSearchTextTool(
	operations: ReadOnlyWorkspaceOperations,
): AgentTool<typeof searchTextSchema, ReadOnlyToolDetails> {
	return {
		name: "search_text",
		label: "search text",
		description:
			"Search literal text in bounded workspace text files. Results contain workspace-relative paths, line numbers, and shortened matching lines.",
		parameters: searchTextSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal, onUpdate) {
			if (!searchTextValidator.Check(rawInput)) {
				throw new Error("search_text arguments failed execution-time validation");
			}
			const input: SearchTextInput = rawInput;
			const path = input.path ?? ".";
			emitUpdate("search_text", onUpdate, { stage: "validating", path }, signal);
			emitUpdate("search_text", onUpdate, { stage: "scanning", path }, signal);
			const result = await operations.searchText(
				path,
				input.query,
				input.caseSensitive ?? false,
				input.maxResults ?? 50,
				signal,
			);
			throwIfAborted(signal);
			return {
				content: [
					{
						type: "text",
						text: [
							`Matches for ${JSON.stringify(input.query)} under ${JSON.stringify(path)}: ${result.matches.length}${result.truncated ? " (truncated)" : ""}`,
							...result.matches.map(
								(match) =>
									`- ${JSON.stringify(match.path)}:${match.line}: ${sanitizeOutputText(match.text)}`,
							),
						].join("\n"),
					},
				],
				details: {
					stage: "completed",
					path,
					resultCount: result.matches.length,
					truncated: result.truncated,
				},
			};
		},
	};
}
