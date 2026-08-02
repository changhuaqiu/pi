import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readdir, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { normalizeRelativePath } from "./read-only-tools.ts";

const maxGitResultBytes = 64 * 1024;
const maxGitErrorBytes = 8 * 1024;
const gitToolTimeoutMs = 15_000;

export type GitToolName = "git_status" | "git_diff" | "git_log" | "git_show" | "git_blame";

export interface GitCommandOutput {
	stdout: string;
	truncated: boolean;
}

export interface GitOperations {
	run(args: readonly string[], signal?: AbortSignal): Promise<GitCommandOutput>;
}

export interface GitToolProgress {
	stage: "validating" | "running" | "completed";
	operation: GitToolName;
	path?: string;
	resultCount?: number;
	truncated?: boolean;
}

export interface GitStatusEntry {
	path: string;
	previousPath?: string;
	index: string;
	worktree: string;
}

export interface GitStatusDetails {
	branch: string;
	staged: GitStatusEntry[];
	unstaged: GitStatusEntry[];
	untracked: string[];
	truncated: boolean;
}

export interface GitDiffDetails {
	diff: string;
	truncated: boolean;
}

export interface GitLogEntry {
	hash: string;
	hashAbbrev: string;
	author: string;
	date: string;
	message: string;
}

export interface GitLogDetails {
	entries: GitLogEntry[];
	truncated: boolean;
}

export interface GitShowDetails {
	commit: GitLogEntry;
	diff: string;
	truncated: boolean;
}

export interface GitBlameLine {
	line: number;
	hash: string;
	hashAbbrev: string;
	author: string;
	date: string;
	content: string;
}

export interface GitBlameDetails {
	lines: GitBlameLine[];
	truncated: boolean;
}

const gitStatusSchema = Type.Object(
	{
		path: Type.Optional(
			Type.String({ description: "Workspace-relative path to limit status to", maxLength: 500 }),
		),
	},
	{ additionalProperties: false },
);

const gitDiffSchema = Type.Object(
	{
		path: Type.Optional(
			Type.String({ description: "Workspace-relative path to limit the diff", maxLength: 500 }),
		),
		staged: Type.Optional(
			Type.Boolean({ description: "Show staged changes instead of unstaged changes" }),
		),
		from: Type.Optional(
			Type.String({
				description: "Source commit or revision; with no `to`, compare it to the working tree",
				maxLength: 100,
			}),
		),
		to: Type.Optional(
			Type.String({ description: "Target commit or revision; requires `from`", maxLength: 100 }),
		),
	},
	{ additionalProperties: false },
);

const gitLogSchema = Type.Object(
	{
		maxCount: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 100, description: "Maximum entries; defaults to 20" }),
		),
		path: Type.Optional(
			Type.String({ description: "Workspace-relative path to filter history", maxLength: 500 }),
		),
		author: Type.Optional(Type.String({ description: "Author name or email filter", maxLength: 200 })),
		since: Type.Optional(Type.String({ description: "Git-compatible starting date", maxLength: 50 })),
	},
	{ additionalProperties: false },
);

const gitShowSchema = Type.Object(
	{
		commit: Type.String({ description: "Commit hash or revision to show", minLength: 1, maxLength: 100 }),
		path: Type.Optional(
			Type.String({ description: "Workspace-relative path to limit the output", maxLength: 500 }),
		),
	},
	{ additionalProperties: false },
);

const gitBlameSchema = Type.Object(
	{
		path: Type.String({ description: "Workspace-relative file path", minLength: 1, maxLength: 500 }),
		startLine: Type.Optional(Type.Integer({ minimum: 1, description: "First line, one-based" })),
		maxLines: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 500, description: "Maximum lines; defaults to 50" }),
		),
	},
	{ additionalProperties: false },
);

type GitStatusInput = Static<typeof gitStatusSchema>;
type GitDiffInput = Static<typeof gitDiffSchema>;
type GitLogInput = Static<typeof gitLogSchema>;
type GitShowInput = Static<typeof gitShowSchema>;
type GitBlameInput = Static<typeof gitBlameSchema>;

const gitStatusValidator = Compile(gitStatusSchema);
const gitDiffValidator = Compile(gitDiffSchema);
const gitLogValidator = Compile(gitLogSchema);
const gitShowValidator = Compile(gitShowSchema);
const gitBlameValidator = Compile(gitBlameSchema);
const gitRevision = /^[A-Za-z0-9][A-Za-z0-9._/@{}~^+-]*$/;
const sensitivePathspecExclusions = [
	":(glob,exclude,icase)**/.git",
	":(glob,exclude,icase)**/.git/**",
	":(glob,exclude,icase)**/.data",
	":(glob,exclude,icase)**/.data/**",
	":(glob,exclude,icase)**/node_modules",
	":(glob,exclude,icase)**/node_modules/**",
	":(glob,exclude,icase)**/.logos-agent-edit-*",
	":(glob,exclude,icase)**/.logos-agent-edit-*/**",
	":(glob,exclude,icase)**/.env",
	":(glob,exclude,icase)**/.env.*",
	":(glob,exclude,icase)**/.netrc",
	":(glob,exclude,icase)**/.npmrc",
	":(glob,exclude,icase)**/.pypirc",
	":(glob,exclude,icase)**/*.key",
	":(glob,exclude,icase)**/*.pem",
	":(glob,exclude,icase)**/credentials",
	":(glob,exclude,icase)**/credentials.json",
	":(glob,exclude,icase)**/id_dsa",
	":(glob,exclude,icase)**/id_ecdsa",
	":(glob,exclude,icase)**/id_ed25519",
	":(glob,exclude,icase)**/id_rsa",
] as const;

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	throw error;
}

function createExecutionSignal(signal?: AbortSignal): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(gitToolTimeoutMs);
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function waitForPromise<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	throwIfAborted(signal);
	return await new Promise<T>((resolvePromise, rejectPromise) => {
		const handleAbort = (): void => {
			try {
				throwIfAborted(signal);
			} catch (error) {
				rejectPromise(error);
			}
		};
		signal.addEventListener("abort", handleAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", handleAbort);
				resolvePromise(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", handleAbort);
				rejectPromise(error);
			},
		);
	});
}

function sanitizeOutputText(value: string): string {
	return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
		if (character === "\n" || character === "\t") return character;
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined) return "";
		return codePoint <= 0xffff
			? `\\u${codePoint.toString(16).padStart(4, "0")}`
			: `\\u{${codePoint.toString(16)}}`;
	});
}

function truncateUtf8(value: string, maxBytes: number): GitCommandOutput {
	const buffer = Buffer.from(value, "utf8");
	if (buffer.length <= maxBytes) return { stdout: value, truncated: false };
	return {
		stdout: buffer.subarray(0, maxBytes).toString("utf8"),
		truncated: true,
	};
}

function boundedSanitizedText(value: string, alreadyTruncated = false): GitCommandOutput {
	const bounded = truncateUtf8(sanitizeOutputText(value), maxGitResultBytes);
	return { stdout: bounded.stdout, truncated: alreadyTruncated || bounded.truncated };
}

function boundedToolContent(value: string, alreadyTruncated: boolean): GitCommandOutput {
	const suffix = "\n[output truncated]";
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	const bounded = truncateUtf8(value, Math.max(0, maxGitResultBytes - suffixBytes));
	const truncated = alreadyTruncated || bounded.truncated;
	return {
		stdout: `${bounded.stdout}${truncated ? suffix : ""}`,
		truncated,
	};
}

function appendSafePathspec(args: string[], path: string | undefined): void {
	args.push("--", `:(literal)${path ?? "."}`, ...sensitivePathspecExclusions);
}

function isWithinRoot(root: string, target: string): boolean {
	const pathFromRoot = relative(root, target);
	return (
		pathFromRoot === "" ||
		(pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
	);
}

async function validateGitWorkspace(workspaceRoot: string): Promise<string> {
	const resolvedRoot = await realpath(resolve(workspaceRoot));
	const gitDirectory = join(resolvedRoot, ".git");
	let gitDirectoryStats;
	try {
		gitDirectoryStats = await lstat(gitDirectory);
	} catch {
		throw new Error("Git tools require the workspace root to contain a local .git directory");
	}
	if (!gitDirectoryStats.isDirectory() || gitDirectoryStats.isSymbolicLink()) {
		throw new Error("Git tools require the workspace root to contain a local .git directory");
	}
	const resolvedGitDirectory = await realpath(gitDirectory);
	if (!isWithinRoot(resolvedRoot, resolvedGitDirectory)) {
		throw new Error("The workspace Git directory escapes the workspace root");
	}
	const directories = [resolvedGitDirectory];
	let entriesScanned = 0;
	while (directories.length > 0) {
		const directory = directories.pop();
		if (!directory) break;
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			entriesScanned += 1;
			if (entriesScanned > 100_000) {
				throw new Error("The workspace Git metadata is too large to validate safely");
			}
			const entryPath = join(directory, entry.name);
			const relativeEntryPath = relative(resolvedGitDirectory, entryPath).replaceAll("\\", "/");
			if (
				relativeEntryPath.toLowerCase() === "commondir" ||
				relativeEntryPath.toLowerCase() === "objects/info/alternates" ||
				relativeEntryPath.toLowerCase() === "objects/info/http-alternates"
			) {
				throw new Error("External Git metadata redirects are not allowed");
			}
			if (entry.isSymbolicLink()) {
				throw new Error("Links inside Git metadata are not allowed");
			}
			if (!entry.isDirectory()) continue;
			const resolvedDirectory = await realpath(entryPath);
			if (!isWithinRoot(resolvedGitDirectory, resolvedDirectory)) {
				throw new Error("A Git metadata directory escapes the workspace root");
			}
			directories.push(resolvedDirectory);
		}
	}
	return resolvedRoot;
}

async function resolveGitExecutable(resolvedRoot: string): Promise<string> {
	const executableName = process.platform === "win32" ? "git.exe" : "git";
	for (const entry of (process.env.PATH ?? "").split(delimiter)) {
		const directory = entry.trim().replace(/^"(.*)"$/, "$1");
		if (!directory || !isAbsolute(directory)) continue;
		const candidate = join(directory, executableName);
		try {
			await access(candidate, constants.X_OK);
			const resolvedCandidate = await realpath(candidate);
			if (!isWithinRoot(resolvedRoot, resolvedCandidate)) return resolvedCandidate;
		} catch {
			// Try the next absolute PATH entry.
		}
	}
	throw new Error("Git executable was not found in an absolute PATH directory outside the workspace");
}

function createGitEnvironment(workspaceRoot: string): NodeJS.ProcessEnv {
	const environment = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
	);
	return {
		...environment,
		GIT_CEILING_DIRECTORIES: workspaceRoot,
		GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_PAGER: "cat",
		GIT_TERMINAL_PROMPT: "0",
		NoDefaultCurrentDirectoryInExePath: "1",
	};
}

function formatGitError(error: unknown, workspaceRoot: string): Error {
	if (error instanceof Error && error.name === "AbortError") return error;
	let message = error instanceof Error ? error.message : String(error);
	if (typeof error === "object" && error !== null && "stderr" in error) {
		const stderr = (error as { stderr?: unknown }).stderr;
		if (typeof stderr === "string" && stderr.trim()) message = stderr.trim();
	}
	message = sanitizeOutputText(message)
		.replaceAll(workspaceRoot, "<workspace>")
		.replaceAll(workspaceRoot.replaceAll("\\", "/"), "<workspace>")
		.slice(0, 1_000);
	return new Error(`Git command failed: ${message}`);
}

export function createNodeGitOperations(workspaceRoot: string): GitOperations {
	let resolvedRootPromise: Promise<string> | undefined;
	let gitExecutablePromise: Promise<string> | undefined;
	const getResolvedRoot = (): Promise<string> => {
		resolvedRootPromise ??= validateGitWorkspace(workspaceRoot);
		return resolvedRootPromise;
	};
	const getGitExecutable = async (): Promise<string> => {
		if (!gitExecutablePromise) {
			const resolvedRoot = await getResolvedRoot();
			gitExecutablePromise = resolveGitExecutable(resolvedRoot);
		}
		return gitExecutablePromise;
	};
	return {
		async run(args, signal) {
			throwIfAborted(signal);
			try {
				const executionSignal = createExecutionSignal(signal);
				const [resolvedRoot, gitExecutable] = await waitForPromise(
					Promise.all([getResolvedRoot(), getGitExecutable()]),
					executionSignal,
				);
				throwIfAborted(executionSignal);
				return await new Promise<GitCommandOutput>((resolve, reject) => {
					const stdoutChunks: Buffer[] = [];
					const stderrChunks: Buffer[] = [];
					let stdoutBytes = 0;
					let stderrBytes = 0;
					let truncated = false;
					let settled = false;
					const child = spawn(
						gitExecutable,
						[
							`--git-dir=${join(resolvedRoot, ".git")}`,
							`--work-tree=${resolvedRoot}`,
							"--no-replace-objects",
							"-c",
							"core.fsmonitor=false",
							"-c",
							"log.showSignature=false",
							...args,
						],
						{
						cwd: resolvedRoot,
						env: createGitEnvironment(resolvedRoot),
						signal: executionSignal,
						stdio: ["ignore", "pipe", "pipe"],
						windowsHide: true,
						},
					);
					child.stdout.on("data", (chunk: Buffer) => {
						const remaining = maxGitResultBytes - stdoutBytes;
						if (remaining > 0) {
							const accepted = chunk.subarray(0, remaining);
							stdoutChunks.push(accepted);
							stdoutBytes += accepted.length;
						}
						if (chunk.length > Math.max(0, remaining)) truncated = true;
					});
					child.stderr.on("data", (chunk: Buffer) => {
						const remaining = maxGitErrorBytes - stderrBytes;
						if (remaining <= 0) return;
						const accepted = chunk.subarray(0, remaining);
						stderrChunks.push(accepted);
						stderrBytes += accepted.length;
					});
					child.once("error", (error) => {
						if (settled) return;
						settled = true;
						reject(error);
					});
					child.once("close", (code) => {
						if (settled) return;
						settled = true;
						try {
							throwIfAborted(executionSignal);
							if (code !== 0) {
								const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
								throw new Error(stderr || `git exited with code ${code ?? "unknown"}`);
							}
							resolve({
								stdout: Buffer.concat(stdoutChunks).toString("utf8"),
								truncated,
							});
						} catch (error) {
							reject(error);
						}
					});
				});
			} catch (error) {
				throw formatGitError(error, workspaceRoot);
			}
		},
	};
}

function normalizePath(path: string | undefined): string | undefined {
	if (path === undefined) return undefined;
	return normalizeRelativePath(path);
}

function normalizeRevision(value: string, field: string): string {
	if (!gitRevision.test(value)) throw new Error(`${field} is not a safe Git revision`);
	return value;
}

function normalizeFilter(value: string | undefined, field: string): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!trimmed || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(trimmed)) {
		throw new Error(`${field} contains unsupported characters`);
	}
	return trimmed;
}

function emitUpdate(
	operation: GitToolName,
	onUpdate: AgentToolUpdateCallback<GitToolProgress> | undefined,
	details: GitToolProgress,
	signal?: AbortSignal,
): void {
	throwIfAborted(signal);
	onUpdate?.({
		content: [{ type: "text", text: `${operation}: ${details.stage}` }],
		details,
	});
	throwIfAborted(signal);
}

function statusText(details: GitStatusDetails): string {
	const lines = [
		`Git status on ${details.branch}${details.truncated ? " (truncated)" : ""}`,
		`Staged: ${details.staged.length}; unstaged: ${details.unstaged.length}; untracked: ${details.untracked.length}`,
		...details.staged.map((entry) => `- staged ${entry.index}: ${JSON.stringify(entry.path)}`),
		...details.unstaged.map((entry) => `- unstaged ${entry.worktree}: ${JSON.stringify(entry.path)}`),
		...details.untracked.map((path) => `- untracked: ${JSON.stringify(path)}`),
	];
	return lines.join("\n");
}

function parseBranchName(value: string): string {
	for (const prefix of ["No commits yet on ", "Initial commit on "]) {
		if (value.startsWith(prefix)) return value.slice(prefix.length) || "(unknown)";
	}
	if (value === "HEAD (no branch)") return "HEAD (detached)";
	return value.split("...")[0]?.split(" ")[0] || "(unknown)";
}

function parseStatus(output: GitCommandOutput): GitStatusDetails {
	const records = output.stdout.split("\0");
	let branch = "(unknown)";
	const staged: GitStatusEntry[] = [];
	const unstaged: GitStatusEntry[] = [];
	const untracked: string[] = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index]!;
		if (!record) continue;
		if (record.startsWith("## ")) {
			branch = parseBranchName(record.slice(3));
			continue;
		}
		if (record.startsWith("?? ")) {
			untracked.push(sanitizeOutputText(record.slice(3)));
			continue;
		}
		if (record.length < 4 || record[2] !== " ") continue;
		const indexStatus = record[0] ?? " ";
		const worktreeStatus = record[1] ?? " ";
		const path = sanitizeOutputText(record.slice(3));
		let previousPath: string | undefined;
		if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
			previousPath = sanitizeOutputText(records[index + 1] ?? "");
			index += 1;
		}
		const entry = { path, previousPath, index: indexStatus, worktree: worktreeStatus };
		if (indexStatus !== " " && indexStatus !== "?") staged.push(entry);
		if (worktreeStatus !== " " && worktreeStatus !== "?") unstaged.push(entry);
	}
	return { branch, staged, unstaged, untracked, truncated: output.truncated };
}

function parseLog(output: GitCommandOutput): GitLogEntry[] {
	const fields = output.stdout.split("\0");
	const entries: GitLogEntry[] = [];
	for (let index = 0; index + 4 < fields.length; index += 5) {
		const hash = fields[index]?.trim() ?? "";
		if (!hash) continue;
		entries.push({
			hash,
			hashAbbrev: fields[index + 1]?.trim() ?? "",
			author: sanitizeOutputText(fields[index + 2]?.trim() ?? ""),
			date: fields[index + 3]?.trim() ?? "",
			message: sanitizeOutputText(fields[index + 4]?.trim() ?? ""),
		});
	}
	return entries;
}

function parseBlame(output: GitCommandOutput): GitBlameLine[] {
	const result: GitBlameLine[] = [];
	let hash = "";
	let finalLine = 0;
	let author = "";
	let date = "";
	for (const line of output.stdout.split("\n")) {
		const header = /^([0-9a-f]{40})\s+\d+\s+(\d+)(?:\s+\d+)?$/.exec(line);
		if (header) {
			hash = header[1] ?? "";
			finalLine = Number.parseInt(header[2] ?? "0", 10);
			author = "";
			date = "";
		} else if (line.startsWith("author ")) {
			author = sanitizeOutputText(line.slice(7));
		} else if (line.startsWith("author-time ")) {
			const timestamp = Number.parseInt(line.slice(12), 10);
			date = timestamp > 0 ? new Date(timestamp * 1_000).toISOString() : "";
		} else if (line.startsWith("\t")) {
			result.push({
				line: finalLine,
				hash,
				hashAbbrev: hash.slice(0, 8),
				author,
				date,
				content: sanitizeOutputText(line.slice(1)),
			});
		}
	}
	return result;
}

const logFormat = "--format=%H%x00%h%x00%an%x00%aI%x00%s%x00";

export function createGitStatusTool(
	operations: GitOperations,
): AgentTool<typeof gitStatusSchema, GitStatusDetails | GitToolProgress> {
	return {
		name: "git_status",
		label: "git status",
		description:
			"Show a bounded read-only snapshot of the current branch, staged changes, unstaged changes, and untracked files.",
		parameters: gitStatusSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal, onUpdate) {
			if (!gitStatusValidator.Check(rawInput)) {
				throw new Error("git_status arguments failed execution-time validation");
			}
			const executionSignal = createExecutionSignal(signal);
			const input: GitStatusInput = rawInput;
			const path = normalizePath(input.path);
			emitUpdate(
				"git_status",
				onUpdate,
				{ stage: "validating", operation: "git_status", path },
				executionSignal,
			);
			const args = ["status", "--porcelain=v1", "-z", "--branch", "--ignore-submodules=all"];
			appendSafePathspec(args, path);
			emitUpdate(
				"git_status",
				onUpdate,
				{ stage: "running", operation: "git_status", path },
				executionSignal,
			);
			const details = parseStatus(await operations.run(args, executionSignal));
			throwIfAborted(executionSignal);
			const content = boundedToolContent(statusText(details), details.truncated);
			details.truncated = content.truncated;
			return {
				content: [{ type: "text", text: content.stdout }],
				details,
			} satisfies AgentToolResult<GitStatusDetails>;
		},
	};
}

export function createGitDiffTool(
	operations: GitOperations,
): AgentTool<typeof gitDiffSchema, GitDiffDetails | GitToolProgress> {
	return {
		name: "git_diff",
		label: "git diff",
		description:
			"Show a bounded read-only patch for the working tree, index, or an explicit pair of safe Git revisions.",
		parameters: gitDiffSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal, onUpdate) {
			if (!gitDiffValidator.Check(rawInput)) {
				throw new Error("git_diff arguments failed execution-time validation");
			}
			const executionSignal = createExecutionSignal(signal);
			const input: GitDiffInput = rawInput;
			if (input.staged && (input.from || input.to)) {
				throw new Error("git_diff staged cannot be combined with from or to");
			}
			if (input.to && !input.from) throw new Error("git_diff to requires from");
			const path = normalizePath(input.path);
			const from = input.from ? normalizeRevision(input.from, "git_diff from") : undefined;
			const to = input.to ? normalizeRevision(input.to, "git_diff to") : undefined;
			emitUpdate(
				"git_diff",
				onUpdate,
				{ stage: "validating", operation: "git_diff", path },
				executionSignal,
			);
			const args = [
				"diff",
				"--patch",
				"--minimal",
				"--no-ext-diff",
				"--no-textconv",
				"--ignore-submodules=all",
			];
			if (input.staged) args.push("--cached");
			if (from) args.push(from);
			if (to) args.push(to);
			appendSafePathspec(args, path);
			emitUpdate(
				"git_diff",
				onUpdate,
				{ stage: "running", operation: "git_diff", path },
				executionSignal,
			);
			const output = await operations.run(args, executionSignal);
			throwIfAborted(executionSignal);
			const sanitized = boundedSanitizedText(output.stdout, output.truncated);
			const content = boundedToolContent(
				`Git diff${sanitized.truncated ? " (truncated)" : ""}:\n${sanitized.stdout || "(no changes)"}`,
				sanitized.truncated,
			);
			const details = { diff: sanitized.stdout, truncated: content.truncated };
			return {
				content: [{ type: "text", text: content.stdout }],
				details,
			};
		},
	};
}

export function createGitLogTool(
	operations: GitOperations,
): AgentTool<typeof gitLogSchema, GitLogDetails | GitToolProgress> {
	return {
		name: "git_log",
		label: "git log",
		description: "Show bounded read-only commit history with optional path, author, and date filters.",
		parameters: gitLogSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal, onUpdate) {
			if (!gitLogValidator.Check(rawInput)) {
				throw new Error("git_log arguments failed execution-time validation");
			}
			const executionSignal = createExecutionSignal(signal);
			const input: GitLogInput = rawInput;
			const maxCount = input.maxCount ?? 20;
			const path = normalizePath(input.path);
			const author = normalizeFilter(input.author, "git_log author");
			const since = normalizeFilter(input.since, "git_log since");
			emitUpdate(
				"git_log",
				onUpdate,
				{ stage: "validating", operation: "git_log", path },
				executionSignal,
			);
			const args = ["log", `--max-count=${maxCount + 1}`, logFormat];
			if (author) args.push(`--author=${author}`);
			if (since) args.push(`--since=${since}`);
			appendSafePathspec(args, path);
			emitUpdate(
				"git_log",
				onUpdate,
				{ stage: "running", operation: "git_log", path },
				executionSignal,
			);
			const output = await operations.run(args, executionSignal);
			throwIfAborted(executionSignal);
			const parsed = parseLog(output);
			const details = {
				entries: parsed.slice(0, maxCount),
				truncated: output.truncated || parsed.length > maxCount,
			};
			const content = boundedToolContent(
				[
					`Git log: ${details.entries.length}${details.truncated ? " (truncated)" : ""}`,
					...details.entries.map(
						(entry) =>
							`${entry.hashAbbrev} ${entry.date} ${JSON.stringify(entry.author)} ${entry.message}`,
					),
				].join("\n"),
				details.truncated,
			);
			details.truncated = content.truncated;
			return {
				content: [{ type: "text", text: content.stdout }],
				details,
			};
		},
	};
}

export function createGitShowTool(
	operations: GitOperations,
): AgentTool<typeof gitShowSchema, GitShowDetails | GitToolProgress> {
	return {
		name: "git_show",
		label: "git show",
		description: "Show bounded read-only metadata and patch content for one safe Git revision.",
		parameters: gitShowSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal, onUpdate) {
			if (!gitShowValidator.Check(rawInput)) {
				throw new Error("git_show arguments failed execution-time validation");
			}
			const executionSignal = createExecutionSignal(signal);
			const input: GitShowInput = rawInput;
			const revision = normalizeRevision(input.commit, "git_show commit");
			const path = normalizePath(input.path);
			emitUpdate(
				"git_show",
				onUpdate,
				{ stage: "validating", operation: "git_show", path },
				executionSignal,
			);
			const resolved = await operations.run(
				["rev-parse", "--verify", `${revision}^{commit}`],
				executionSignal,
			);
			const commitHash = resolved.stdout.trim();
			if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commitHash)) {
				throw new Error(`Commit not found: ${revision}`);
			}
			emitUpdate(
				"git_show",
				onUpdate,
				{ stage: "running", operation: "git_show", path },
				executionSignal,
			);
			const metadataOutput = await operations.run(
				["log", "--max-count=1", logFormat, commitHash],
				executionSignal,
			);
			const commit = parseLog(metadataOutput)[0];
			if (!commit) throw new Error(`Commit not found: ${revision}`);
			const args = [
				"show",
				"--patch",
				"--minimal",
				"--no-ext-diff",
				"--no-textconv",
				"--ignore-submodules=all",
				"--format=",
				commitHash,
			];
			appendSafePathspec(args, path);
			const diffOutput = await operations.run(args, executionSignal);
			throwIfAborted(executionSignal);
			const sanitizedDiff = boundedSanitizedText(diffOutput.stdout, diffOutput.truncated);
			const details = {
				commit,
				diff: sanitizedDiff.stdout,
				truncated: metadataOutput.truncated || sanitizedDiff.truncated,
			};
			const content = boundedToolContent(
				[
					`${commit.hashAbbrev} ${commit.date} ${JSON.stringify(commit.author)} ${commit.message}`,
					`Patch${details.truncated ? " (truncated)" : ""}:`,
					details.diff || "(no patch)",
				].join("\n"),
				details.truncated,
			);
			details.truncated = content.truncated;
			return {
				content: [{ type: "text", text: content.stdout }],
				details,
			};
		},
	};
}

export function createGitBlameTool(
	operations: GitOperations,
): AgentTool<typeof gitBlameSchema, GitBlameDetails | GitToolProgress> {
	return {
		name: "git_blame",
		label: "git blame",
		description: "Show bounded read-only line authorship for a workspace-relative file.",
		parameters: gitBlameSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal, onUpdate) {
			if (!gitBlameValidator.Check(rawInput)) {
				throw new Error("git_blame arguments failed execution-time validation");
			}
			const executionSignal = createExecutionSignal(signal);
			const input: GitBlameInput = rawInput;
			const path = normalizePath(input.path);
			if (!path || path === ".") throw new Error("git_blame requires a file path");
			const startLine = input.startLine ?? 1;
			const maxLines = input.maxLines ?? 50;
			const range = `${startLine},${startLine + maxLines - 1}`;
			emitUpdate(
				"git_blame",
				onUpdate,
				{ stage: "validating", operation: "git_blame", path },
				executionSignal,
			);
			emitUpdate(
				"git_blame",
				onUpdate,
				{ stage: "running", operation: "git_blame", path },
				executionSignal,
			);
			const output = await operations.run(
				["blame", "--line-porcelain", "--no-textconv", "-L", range, "--", `:(literal)${path}`],
				executionSignal,
			);
			throwIfAborted(executionSignal);
			const details = { lines: parseBlame(output), truncated: output.truncated };
			const content = boundedToolContent(
				[
					`Git blame ${JSON.stringify(path)}: ${details.lines.length}${details.truncated ? " (truncated)" : ""}`,
					...details.lines.map(
						(line) =>
							`${line.line} ${line.hashAbbrev} ${JSON.stringify(line.author)} ${line.date}: ${line.content}`,
					),
				].join("\n"),
				details.truncated,
			);
			details.truncated = content.truncated;
			return {
				content: [{ type: "text", text: content.stdout }],
				details,
			};
		},
	};
}
