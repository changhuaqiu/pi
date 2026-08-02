import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { getToolPath } from "../../../packages/coding-agent/src/utils/tools-manager.ts";

export type ReadOnlyToolName = "list_files" | "read_file" | "grep";

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
	complete: boolean;
	nextStartLine?: number;
}

export type GrepOutputMode = "content" | "files" | "count";

export interface WorkspaceGrepRequest {
	pattern: string;
	path: string;
	glob?: string;
	outputMode: GrepOutputMode;
	context: number;
	caseInsensitive: boolean;
	literal: boolean;
	maxResults: number;
	offset: number;
}

export type WorkspaceGrepEntry =
	| {
			kind: "content";
			path: string;
			line: number;
			text: string;
			before: string[];
			after: string[];
	  }
	| { kind: "file"; path: string }
	| { kind: "count"; path: string; count: number };

export interface WorkspaceGrepResult {
	entries: WorkspaceGrepEntry[];
	truncated: boolean;
	filesScanned: number;
	nextOffset?: number;
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
	grep(request: WorkspaceGrepRequest, signal?: AbortSignal): Promise<WorkspaceGrepResult>;
}

export interface ReadOnlyToolDetails {
	stage: "validating" | "scanning" | "completed";
	path: string;
	resultCount?: number;
	truncated?: boolean;
	startLine?: number;
	endLine?: number;
	totalLines?: number;
	complete?: boolean;
	nextStartLine?: number;
	filesScanned?: number;
	nextOffset?: number;
	outputMode?: GrepOutputMode;
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

const grepSchema = Type.Object(
	{
		pattern: Type.String({
			description: "ripgrep regular expression to search for, or literal text when literal=true",
			minLength: 1,
			maxLength: 500,
		}),
		path: Type.Optional(Type.String({ description: "Workspace-relative file or directory", maxLength: 500 })),
		glob: Type.Optional(Type.String({
			description: "Optional ripgrep path glob, for example **/*.ts",
			minLength: 1,
			maxLength: 200,
		})),
		outputMode: Type.Optional(Type.Union([
			Type.Literal("content"),
			Type.Literal("files"),
			Type.Literal("count"),
		])),
		context: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
		caseInsensitive: Type.Optional(Type.Boolean()),
		literal: Type.Optional(Type.Boolean({
			description: "Treat pattern as literal text instead of a regular expression",
		})),
		maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
		offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
	},
	{ additionalProperties: false },
);

type ListFilesInput = Static<typeof listFilesSchema>;
type ReadFileInput = Static<typeof readFileSchema>;
type GrepInput = Static<typeof grepSchema>;

const listFilesValidator = Compile(listFilesSchema);
const readFileValidator = Compile(readFileSchema);
const grepValidator = Compile(grepSchema);
const blockedSegments = new Set([
	".aws",
	".azure",
	".data",
	".git",
	".gnupg",
	".kube",
	".ssh",
	"node_modules",
]);
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
const maxReadOutputCharacters = 64 * 1024;
const maxReadScanBytes = 1024 * 1024;
const maxSearchFileBytes = 512 * 1024;
const maxSearchFiles = 2_000;
const maxSearchLineLength = 500;
const maxSearchDurationMs = 30_000;
const maxGrepOffset = 10_000;
const maxGrepOutputBytes = 48 * 1024;

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
			lower.startsWith(".logos-agent-edit-") ||
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
		lower.startsWith(".logos-agent-edit-") ||
		lower.startsWith(".env.") ||
		lower.endsWith(".pem") ||
		lower.endsWith(".key")
	);
}

async function resolveWorkspacePath(root: string, inputPath: string, signal?: AbortSignal): Promise<string> {
	throwIfAborted(signal);
	const normalized = normalizeRelativePath(inputPath);
	const lexicalRoot = resolve(root);
	const lexicalTarget = resolve(lexicalRoot, normalized);
	if (!isWithinRoot(lexicalRoot, lexicalTarget)) throw new Error("Path escapes the workspace root");
	const resolvedRoot = await realpath(lexicalRoot);
	throwIfAborted(signal);
	let resolvedTarget = resolvedRoot;
	for (const segment of normalized === "." ? [] : normalized.split("/")) {
		resolvedTarget = resolve(resolvedTarget, segment);
		if (!isWithinRoot(resolvedRoot, resolvedTarget)) throw new Error("Resolved path escapes the workspace root");
		const stats = await lstat(resolvedTarget);
		throwIfAborted(signal);
		if (stats.isSymbolicLink()) throw new Error("Symbolic links are not readable");
	}
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

function sanitizeOutputText(value: string): string {
	return value.replace(
		/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

interface NativeGrepMatch {
	path: string;
	line: number;
	text: string;
}

interface NativeGrepScan {
	matches: NativeGrepMatch[];
	matchedFiles: string[];
	matchCounts: Map<string, number>;
	filesScanned: number;
	truncated: boolean;
}

interface NativeGrepAccumulator {
	matches: NativeGrepMatch[];
	matchedFiles: string[];
	matchCounts: Map<string, number>;
	seenFiles: Set<string>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function readRipgrepText(value: unknown): { text?: string; bytes?: string } {
	const record = asRecord(value);
	if (typeof record?.text === "string") return { text: record.text };
	if (typeof record?.bytes === "string") return { bytes: record.bytes };
	return {};
}

function toSafeGrepPath(resolvedRoot: string, discoveredPath: string): { absolute: string; display: string } | undefined {
	const absolute = resolve(resolvedRoot, discoveredPath);
	if (!isWithinRoot(resolvedRoot, absolute)) return undefined;
	const display = toDisplayPath(resolvedRoot, absolute);
	try {
		normalizeRelativePath(display);
	} catch {
		return undefined;
	}
	return { absolute, display };
}

function buildGrepDiscoveryArgs(start: string, request: WorkspaceGrepRequest): string[] {
	const args = [
		"--files",
		"--null",
		"--no-config",
		"--sort",
		"path",
		"--hidden",
	];
	if (request.glob !== undefined) args.push("--glob", request.glob);
	for (const segment of blockedSegments) args.push("--glob", `!**/${segment}/**`);
	for (const fileName of blockedFileNames) args.push("--glob", `!**/${fileName}`);
	args.push(
		"--glob",
		"!**/.logos-agent-edit-*",
		"--glob",
		"!**/.env.*",
		"--glob",
		"!**/*.pem",
		"--glob",
		"!**/*.key",
		"--",
		start,
	);
	return args;
}

async function discoverNativeGrepFiles(
	rgPath: string,
	resolvedRoot: string,
	start: string,
	request: WorkspaceGrepRequest,
	deadline: number,
	signal?: AbortSignal,
): Promise<{ files: string[]; truncated: boolean }> {
	throwIfAborted(signal);
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(rgPath, buildGrepDiscoveryArgs(start, request), {
			cwd: resolvedRoot,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const files: string[] = [];
		let pending = Buffer.alloc(0);
		let stderr = "";
		let aborted = false;
		let truncated = false;
		let stoppedByLimit = false;
		let parseFailure: Error | undefined;
		let settled = false;

		const stop = () => {
			if (!child.killed) child.kill();
		};
		const onAbort = () => {
			aborted = true;
			stop();
		};
		const timeout = setTimeout(() => {
			truncated = true;
			stoppedByLimit = true;
			stop();
		}, Math.max(1, deadline - Date.now()));
		const cleanup = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		};
		const rejectOnce = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			rejectPromise(error);
		};
		const resolveOnce = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolvePromise({ files, truncated });
		};
		const acceptPath = (rawPath: Buffer) => {
			if (rawPath.length === 0 || stoppedByLimit) return;
			const decodedPath = rawPath.toString("utf8");
			if (!Buffer.from(decodedPath, "utf8").equals(rawPath)) {
				parseFailure = new Error("ripgrep returned a non-UTF-8 path, which this workspace adapter cannot represent safely");
				stop();
				return;
			}
			const safePath = toSafeGrepPath(resolvedRoot, decodedPath);
			if (safePath === undefined) return;
			if (files.length >= maxSearchFiles) {
				truncated = true;
				stoppedByLimit = true;
				stop();
				return;
			}
			files.push(safePath.absolute);
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 16 * 1024) stderr += chunk.toString("utf8");
		});
		child.stdout.on("data", (chunk: Buffer) => {
			pending = Buffer.concat([pending, chunk]);
			let separator = pending.indexOf(0);
			while (separator >= 0) {
				acceptPath(pending.subarray(0, separator));
				pending = pending.subarray(separator + 1);
				separator = pending.indexOf(0);
			}
		});
		child.on("error", (error) => rejectOnce(new Error(`Failed to run ripgrep: ${error.message}`)));
		child.on("close", (code) => {
			if (aborted) {
				const error = new Error("Operation aborted");
				error.name = "AbortError";
				rejectOnce(error);
				return;
			}
			acceptPath(pending);
			if (parseFailure !== undefined) {
				rejectOnce(parseFailure);
				return;
			}
			if (!stoppedByLimit && code !== 0 && code !== 1) {
				rejectOnce(new Error(`ripgrep file discovery failed: ${stderr.trim() || `exit code ${code}`}`));
				return;
			}
			resolveOnce();
		});
	});
}

function partitionGrepFiles(files: string[]): string[][] {
	const batches: string[][] = [];
	let batch: string[] = [];
	let characters = 0;
	for (const file of files) {
		if (batch.length > 0 && characters + file.length + 1 > 12_000) {
			batches.push(batch);
			batch = [];
			characters = 0;
		}
		batch.push(file);
		characters += file.length + 1;
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}

async function validateNativeGrepPattern(
	rgPath: string,
	resolvedRoot: string,
	start: string,
	request: WorkspaceGrepRequest,
	deadline: number,
	signal?: AbortSignal,
): Promise<void> {
	if (request.literal) return;
	throwIfAborted(signal);
	const args = ["--no-config", "--glob", "!*", "--glob", "!**/*"];
	if (request.caseInsensitive) args.push("--ignore-case");
	args.push("--", request.pattern, start);

	await new Promise<void>((resolvePromise, rejectPromise) => {
		const child = spawn(rgPath, args, { cwd: resolvedRoot, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		let aborted = false;
		let timedOut = false;
		let settled = false;
		const stop = () => {
			if (!child.killed) child.kill();
		};
		const onAbort = () => {
			aborted = true;
			stop();
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			stop();
		}, Math.max(1, deadline - Date.now()));
		const cleanup = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		};
		const rejectOnce = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			rejectPromise(error);
		};
		const resolveOnce = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolvePromise();
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 16 * 1024) stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => rejectOnce(new Error(`Failed to run ripgrep: ${error.message}`)));
		child.on("close", (code) => {
			if (aborted) {
				const error = new Error("Operation aborted");
				error.name = "AbortError";
				rejectOnce(error);
				return;
			}
			if (timedOut) {
				rejectOnce(new Error("ripgrep pattern validation timed out"));
				return;
			}
			if (code !== 0 && code !== 1) {
				const message = stderr.trim() || `ripgrep exited with code ${code}`;
				rejectOnce(new Error(`Invalid grep regular expression: ${message}`));
				return;
			}
			resolveOnce();
		});
	});
}

async function searchNativeGrepBatch(
	rgPath: string,
	resolvedRoot: string,
	files: string[],
	request: WorkspaceGrepRequest,
	accumulator: NativeGrepAccumulator,
	deadline: number,
	signal?: AbortSignal,
): Promise<{ stopped: boolean; truncated: boolean }> {
	throwIfAborted(signal);
	const args = ["--json", "--line-number", "--color=never", "--no-config", "--sort", "path", "--max-filesize", String(maxSearchFileBytes)];
	if (request.caseInsensitive) args.push("--ignore-case");
	if (request.literal) args.push("--fixed-strings");
	args.push("--", request.pattern, ...files);

	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(rgPath, args, { cwd: resolvedRoot, stdio: ["ignore", "pipe", "pipe"] });
		const lines = createInterface({ input: child.stdout });
		let stderr = "";
		let aborted = false;
		let stopped = false;
		let truncated = false;
		let parseFailure: Error | undefined;
		let settled = false;
		const stop = () => {
			if (!child.killed) child.kill();
		};
		const onAbort = () => {
			aborted = true;
			stop();
		};
		const timeout = setTimeout(() => {
			stopped = true;
			truncated = true;
			stop();
		}, Math.max(1, deadline - Date.now()));
		const cleanup = () => {
			clearTimeout(timeout);
			lines.close();
			signal?.removeEventListener("abort", onAbort);
		};
		const rejectOnce = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			rejectPromise(error);
		};
		const resolveOnce = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolvePromise({ stopped, truncated });
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 16 * 1024) stderr += chunk.toString("utf8");
		});
		lines.on("line", (line) => {
			if (stopped) return;
			let event: Record<string, unknown> | undefined;
			try {
				event = asRecord(JSON.parse(line));
			} catch {
				return;
			}
			if (event?.type !== "match") return;
			const data = asRecord(event.data);
			if (data === undefined) return;
			const pathValue = readRipgrepText(data.path);
			if (pathValue.bytes !== undefined) {
				parseFailure = new Error("ripgrep returned a non-UTF-8 path, which this workspace adapter cannot represent safely");
				stop();
				return;
			}
			if (pathValue.text === undefined) return;
			const safePath = toSafeGrepPath(resolvedRoot, pathValue.text);
			const lineNumber = data.line_number;
			const lineValue = readRipgrepText(data.lines);
			if (safePath === undefined || typeof lineNumber !== "number") return;
			const text = lineValue.text !== undefined
				? lineValue.text.replace(/\r?\n$/, "").slice(0, maxSearchLineLength)
				: lineValue.bytes !== undefined
					? `[non-UTF-8 content; base64-prefix=${lineValue.bytes.slice(0, maxSearchLineLength - 40)}${lineValue.bytes.length > maxSearchLineLength - 40 ? "..." : ""}]`
					: undefined;
			if (text === undefined) return;
			if (!accumulator.seenFiles.has(safePath.display)) {
				accumulator.seenFiles.add(safePath.display);
				accumulator.matchedFiles.push(safePath.display);
			}
			accumulator.matchCounts.set(safePath.display, (accumulator.matchCounts.get(safePath.display) ?? 0) + 1);
			if (request.outputMode !== "content") return;
			accumulator.matches.push({ path: safePath.display, line: lineNumber, text });
			if (accumulator.matches.length > request.offset + request.maxResults) {
				stopped = true;
				truncated = true;
				stop();
			}
		});
		child.on("error", (error) => rejectOnce(new Error(`Failed to run ripgrep: ${error.message}`)));
		child.on("close", (code) => {
			if (aborted) {
				const error = new Error("Operation aborted");
				error.name = "AbortError";
				rejectOnce(error);
				return;
			}
			if (parseFailure !== undefined) {
				rejectOnce(parseFailure);
				return;
			}
			if (!stopped && code !== 0 && code !== 1) {
				const message = stderr.trim() || `ripgrep exited with code ${code}`;
				const prefix = message.includes("regex parse error") ? "Invalid grep regular expression" : "ripgrep search failed";
				rejectOnce(new Error(`${prefix}: ${message}`));
				return;
			}
			resolveOnce();
		});
	});
}

async function runNativeGrep(
	resolvedRoot: string,
	start: string,
	request: WorkspaceGrepRequest,
	signal?: AbortSignal,
): Promise<NativeGrepScan> {
	throwIfAborted(signal);
	const rgPath = getToolPath("rg");
	if (!rgPath) throw new Error("ripgrep (rg) is unavailable; install rg before using grep");
	const deadline = Date.now() + maxSearchDurationMs;
	const discovery = await discoverNativeGrepFiles(rgPath, resolvedRoot, start, request, deadline, signal);
	if (discovery.files.length === 0) {
		await validateNativeGrepPattern(rgPath, resolvedRoot, start, request, deadline, signal);
	}
	const accumulator: NativeGrepAccumulator = {
		matches: [],
		matchedFiles: [],
		matchCounts: new Map(),
		seenFiles: new Set(),
	};
	let truncated = discovery.truncated;
	for (const files of partitionGrepFiles(discovery.files)) {
		if (Date.now() >= deadline) {
			truncated = true;
			break;
		}
		const batch = await searchNativeGrepBatch(rgPath, resolvedRoot, files, request, accumulator, deadline, signal);
		truncated ||= batch.truncated;
		if (batch.stopped) break;
	}
	return {
		matches: accumulator.matches,
		matchedFiles: accumulator.matchedFiles,
		matchCounts: accumulator.matchCounts,
		filesScanned: discovery.files.length,
		truncated,
	};
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
			const scannedText = scanned.buffer.toString("utf8");
			const lastCompleteLineBreak = scanned.truncated ? scannedText.lastIndexOf("\n") : -1;
			const completeText = scanned.truncated
				? lastCompleteLineBreak >= 0
					? scannedText.slice(0, lastCompleteLineBreak)
					: ""
				: scannedText;
			const allLines = scanned.truncated && completeText.length === 0 ? [] : completeText.split(/\r?\n/);
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
				if (line.length > remaining) {
					if (selected.length === 0) {
						throw new Error(
							`Line ${startIndex + 1} exceeds the ${maxReadOutputCharacters}-character read_file output limit`,
						);
					}
					break;
				}
				selected.push(line);
				outputCharacters += separatorLength + line.length;
			}
			const truncated =
				scanned.truncated ||
				startIndex + selected.length < allLines.length ||
				selected.length < candidates.length;
			const endLine = selected.length > 0 ? startIndex + selected.length : undefined;
			const totalLines = scanned.truncated ? undefined : allLines.length;
			const complete =
				!scanned.truncated &&
				startIndex === 0 &&
				endLine === totalLines &&
				!truncated;
			return {
				path: toDisplayPath(resolvedRoot, target),
				startLine: selected.length > 0 ? startIndex + 1 : startLine,
				endLine,
				totalLines,
				lineCount: selected.length,
				text: selected.join("\n"),
				truncated,
				complete,
				...(endLine !== undefined && endLine < allLines.length
					? { nextStartLine: endLine + 1 }
					: {}),
			};
		},

		async grep(request, signal) {
			const resolvedRoot = await realpath(root);
			throwIfAborted(signal);
			const start = await resolveWorkspacePath(root, request.path, signal);
			const stats = await lstat(start);
			throwIfAborted(signal);
			if (!stats.isFile() && !stats.isDirectory()) throw new Error("Search path must be a file or directory");
			const scan = await runNativeGrep(resolvedRoot, start, request, signal);
			throwIfAborted(signal);
			const available = request.outputMode === "content"
				? scan.matches
				: scan.matchedFiles;
			const selected = available.slice(request.offset, request.offset + request.maxResults);
			const pageOverflow = scan.truncated || available.length > request.offset + selected.length;
			const entries: WorkspaceGrepEntry[] = [];
			if (request.outputMode === "content") {
				const fileCache = new Map<string, string[]>();
				for (const match of selected as NativeGrepMatch[]) {
					let lines = fileCache.get(match.path);
					if (lines === undefined && request.context > 0) {
						try {
							const content = await readBoundedTextFile(resolve(resolvedRoot, match.path), maxSearchFileBytes, signal);
							lines = content.buffer.toString("utf8").split(/\r?\n/);
						} catch {
							lines = [];
						}
						fileCache.set(match.path, lines);
					}
					const lineIndex = match.line - 1;
					entries.push({
						kind: "content",
						path: match.path,
						line: match.line,
						text: match.text.slice(0, maxSearchLineLength),
						before: (lines ?? [])
							.slice(Math.max(0, lineIndex - request.context), lineIndex)
							.map((line) => line.slice(0, maxSearchLineLength)),
						after: (lines ?? [])
							.slice(lineIndex + 1, lineIndex + 1 + request.context)
							.map((line) => line.slice(0, maxSearchLineLength)),
					});
				}
			} else {
				for (const path of selected as string[]) {
					entries.push(request.outputMode === "files"
						? { kind: "file", path }
						: { kind: "count", path, count: scan.matchCounts.get(path) ?? 0 });
				}
			}
			return {
				entries,
				truncated: pageOverflow || (stats.isFile() && stats.size > maxSearchFileBytes),
				filesScanned: scan.filesScanned,
				...(pageOverflow ? { nextOffset: request.offset + entries.length } : {}),
			};
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
			"Read a bounded range from one text file using a workspace-relative path. The result reports exact coverage, complete, and nextStartLine; never treat a partial range as the full file. Binary, credential, dependency, session, and Git metadata files are blocked.",
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
							`${JSON.stringify(result.path)}:${result.startLine}-${result.endLine ?? "none"} of ${result.totalLines ?? "unknown total"}; coverage=${result.complete ? "complete" : "partial"}${result.nextStartLine === undefined ? "" : `; nextStartLine=${result.nextStartLine}`}`,
							numberedLines,
						].join("\n"),
					},
				],
				details: {
					stage: "completed",
					path: result.path,
					resultCount: result.lineCount,
					truncated: result.truncated,
					startLine: result.startLine,
					...(result.endLine === undefined ? {} : { endLine: result.endLine }),
					...(result.totalLines === undefined ? {} : { totalLines: result.totalLines }),
					complete: result.complete,
					...(result.nextStartLine === undefined
						? {}
						: { nextStartLine: result.nextStartLine }),
				},
			} satisfies AgentToolResult<ReadOnlyToolDetails>;
		},
	};
}

function formatGrepEntry(entry: WorkspaceGrepEntry): string[] {
	if (entry.kind === "file") return [JSON.stringify(entry.path)];
	if (entry.kind === "count") return [`${JSON.stringify(entry.path)}: ${entry.count}`];
	const lines = entry.before.map((line, index) => {
		const lineNumber = entry.line - entry.before.length + index;
		return `  ${JSON.stringify(entry.path)}-${lineNumber}- ${sanitizeOutputText(line)}`;
	});
	lines.push(`${JSON.stringify(entry.path)}:${entry.line}: ${sanitizeOutputText(entry.text)}`);
	lines.push(...entry.after.map((line, index) =>
		`  ${JSON.stringify(entry.path)}-${entry.line + index + 1}- ${sanitizeOutputText(line)}`,
	));
	return lines;
}

function formatGrepPage(
	pattern: string,
	path: string,
	offset: number,
	result: WorkspaceGrepResult,
): {
	text: string;
	resultCount: number;
	truncated: boolean;
	nextOffset?: number;
} {
	const header = `Grep ${JSON.stringify(pattern)} under ${JSON.stringify(path)}`;
	const lines: string[] = [];
	let resultCount = 0;
	for (const entry of result.entries) {
		const entryLines = formatGrepEntry(entry);
		const candidate = [header, ...lines, ...entryLines].join("\n");
		if (Buffer.byteLength(candidate, "utf8") > maxGrepOutputBytes - 512) break;
		lines.push(...entryLines);
		resultCount += 1;
	}
	const hasMore = resultCount < result.entries.length || result.nextOffset !== undefined;
	const candidateOffset = offset + resultCount;
	const nextOffset = hasMore && resultCount > 0 && candidateOffset <= maxGrepOffset
		? candidateOffset
		: undefined;
	const summary = `${header}: ${resultCount}${result.truncated || hasMore ? " (truncated)" : ""}`;
	const notice = hasMore && resultCount === 0
		? "First result exceeds the page budget; narrow path or glob, reduce context, or use files/count output."
		: nextOffset !== undefined
		? `More results available; continue with offset=${nextOffset}.`
		: hasMore
			? "Pagination limit reached; narrow pattern, path, or glob."
			: undefined;
	return {
		text: [summary, ...lines, ...(notice === undefined ? [] : [notice])].join("\n"),
		resultCount,
		truncated: result.truncated || hasMore,
		...(nextOffset === undefined ? {} : { nextOffset }),
	};
}

export function createGrepTool(
	operations: ReadOnlyWorkspaceOperations,
): AgentTool<typeof grepSchema, ReadOnlyToolDetails> {
	return {
		name: "grep",
		label: "grep",
		description:
			"Search workspace text with native ripgrep regular-expression and glob semantics, or literal text with literal=true. Respects ignore files and enforces workspace path, sensitive-file, duration, result, and output bounds. Supports content/file/count output, context lines, case control, and offset pagination. Use grep for exact text and regex evidence; use CodeGraph tools only for indexed symbol structure and relationships.",
		parameters: grepSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal, onUpdate) {
			if (!grepValidator.Check(rawInput)) {
				throw new Error("grep arguments failed execution-time validation");
			}
			const input: GrepInput = rawInput;
			const path = input.path ?? ".";
			emitUpdate("grep", onUpdate, { stage: "validating", path }, signal);
			emitUpdate("grep", onUpdate, { stage: "scanning", path }, signal);
			const result = await operations.grep({
				pattern: input.pattern,
				path,
				...(input.glob === undefined ? {} : { glob: input.glob }),
				outputMode: input.outputMode ?? "content",
				context: input.context ?? 0,
				caseInsensitive: input.caseInsensitive ?? false,
				literal: input.literal ?? false,
				maxResults: input.maxResults ?? 50,
				offset: input.offset ?? 0,
			}, signal);
			throwIfAborted(signal);
			const page = formatGrepPage(input.pattern, path, input.offset ?? 0, result);
			return {
				content: [
					{
						type: "text",
						text: page.text,
					},
				],
				details: {
					stage: "completed",
					path,
					resultCount: page.resultCount,
					truncated: page.truncated,
					filesScanned: result.filesScanned,
					...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
					outputMode: input.outputMode ?? "content",
				},
			};
		},
	};
}
