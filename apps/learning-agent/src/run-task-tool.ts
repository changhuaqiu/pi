import { spawn } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

export type RunTaskName = "learning_agent_test" | "learning_agent_typecheck";
export type RunTaskToolName = "run_task";

export interface RunTaskApprovalSummary {
	task: RunTaskName;
	label: string;
	command: string;
	cwd: string;
	timeoutMs: number;
}

export interface RunTaskResult {
	task: RunTaskName;
	exitCode: number;
	stdout: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
}

export interface RunTaskOperations {
	run(task: RunTaskName, signal?: AbortSignal): Promise<RunTaskResult>;
}

export interface RunTaskToolDetails {
	stage: "validating" | "running" | "completed";
	task: RunTaskName;
	exitCode?: number;
	truncated?: boolean;
	durationMs?: number;
}

const runTaskSchema = Type.Object(
	{
		task: Type.Union(
			[Type.Literal("learning_agent_test"), Type.Literal("learning_agent_typecheck")],
			{ description: "Fixed validation task to execute after explicit user approval" },
		),
	},
	{ additionalProperties: false },
);

type RunTaskInput = Static<typeof runTaskSchema>;

const runTaskValidator = Compile(runTaskSchema);
const taskTimeoutMs = 60_000;
const maxStreamBytes = 32 * 1024;

const taskSummaries: Record<RunTaskName, RunTaskApprovalSummary> = {
	learning_agent_test: {
		task: "learning_agent_test",
		label: "Learning Agent tests",
		command: "node --import tsx --test test/*.test.ts",
		cwd: "apps/learning-agent",
		timeoutMs: taskTimeoutMs,
	},
	learning_agent_typecheck: {
		task: "learning_agent_typecheck",
		label: "Learning Agent typecheck",
		command:
			"node node_modules/typescript/bin/tsc --noEmit -p apps/learning-agent/tsconfig.json",
		cwd: ".",
		timeoutMs: taskTimeoutMs,
	},
};

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	throw error;
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

function isWithinRoot(root: string, target: string): boolean {
	const pathFromRoot = relative(root, target);
	return (
		pathFromRoot === "" ||
		(pathFromRoot !== ".." &&
			!pathFromRoot.startsWith(`..${sep}`) &&
			!pathFromRoot.startsWith("../") &&
			!isAbsolute(pathFromRoot))
	);
}

function createTaskEnvironment(): NodeJS.ProcessEnv {
	const allowedKeys = new Set([
		"APPDATA",
		"CI",
		"COMSPEC",
		"HOME",
		"LOCALAPPDATA",
		"NO_COLOR",
		"PATH",
		"PATHEXT",
		"SYSTEMROOT",
		"TEMP",
		"TMP",
		"TMPDIR",
		"USERPROFILE",
		"WINDIR",
	]);
	return {
		...Object.fromEntries(
		Object.entries(process.env).filter(
			([key, value]) => value !== undefined && allowedKeys.has(key.toUpperCase()),
		),
		),
		LEARNING_AGENT_FIXED_TASK: "1",
	};
}

function quoteWindowsArgument(value: string): string {
	if (value.length === 0) return '""';
	if (!/[\s"]/u.test(value)) return value;
	let result = '"';
	let backslashes = 0;
	for (const character of value) {
		if (character === "\\") {
			backslashes += 1;
			continue;
		}
		if (character === '"') {
			result += `${"\\".repeat(backslashes * 2 + 1)}"`;
			backslashes = 0;
			continue;
		}
		result += `${"\\".repeat(backslashes)}${character}`;
		backslashes = 0;
	}
	return `${result}${"\\".repeat(backslashes * 2)}"`;
}

async function wrapWindowsTaskInJob(
	resolvedRoot: string,
	appRoot: string,
	command: string,
	args: string[],
	cwd: string,
): Promise<{ command: string; args: string[]; cwd: string }> {
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
	const powershell = await realpath(
		join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
	);
	const runner = await realpath(join(appRoot, "src", "windows-job-runner.ps1"));
	if (
		!isAbsolute(powershell) ||
		isWithinRoot(resolvedRoot, powershell) ||
		!isWithinRoot(appRoot, runner)
	) {
		throw new Error("Windows task runner paths failed scope validation");
	}
	const payload = Buffer.from(
		JSON.stringify({
			command,
			arguments: args.map(quoteWindowsArgument).join(" "),
			cwd,
			environment: createTaskEnvironment(),
		}),
		"utf8",
	).toString("base64");
	return {
		command: powershell,
		args: [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			runner,
			"-Payload",
			payload,
		],
		cwd: resolvedRoot,
	};
}

function appendBoundedChunk(
	chunks: Buffer[],
	chunk: Buffer,
	currentBytes: number,
): { bytes: number; truncated: boolean } {
	const remaining = maxStreamBytes - currentBytes;
	if (remaining <= 0) return { bytes: currentBytes, truncated: true };
	const accepted = chunk.subarray(0, remaining);
	chunks.push(accepted);
	return {
		bytes: currentBytes + accepted.length,
		truncated: chunk.length > remaining,
	};
}

function decodeCapturedOutput(chunks: Buffer[], truncated: boolean): string {
	const buffer = Buffer.concat(chunks);
	if (!truncated || buffer.length === 0) return buffer.toString("utf8");
	let sequenceStart = buffer.length - 1;
	while (sequenceStart > 0 && (buffer[sequenceStart]! & 0xc0) === 0x80) {
		sequenceStart -= 1;
	}
	const leadingByte = buffer[sequenceStart]!;
	const expectedBytes =
		(leadingByte & 0x80) === 0
			? 1
			: (leadingByte & 0xe0) === 0xc0
				? 2
				: (leadingByte & 0xf0) === 0xe0
					? 3
					: (leadingByte & 0xf8) === 0xf0
						? 4
						: 1;
	const completeEnd =
		buffer.length - sequenceStart < expectedBytes ? sequenceStart : buffer.length;
	return buffer.subarray(0, completeEnd).toString("utf8");
}

async function terminateProcessTree(
	pid: number | undefined,
	killDirectChild: () => void,
): Promise<void> {
	if (pid === undefined) return;
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already exited.
			}
		}
		return;
	}
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
	const killedTree = await new Promise<boolean>((resolvePromise) => {
		let settled = false;
		const finish = (result: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolvePromise(result);
		};
		const killer = spawn(
			join(systemRoot, "System32", "taskkill.exe"),
			["/PID", String(pid), "/T", "/F"],
			{
				env: createTaskEnvironment(),
				stdio: "ignore",
				windowsHide: true,
			},
		);
		const timeout = setTimeout(() => {
			killer.kill("SIGKILL");
			finish(false);
		}, 2_000);
		killer.once("error", () => finish(false));
		killer.once("close", (code) => finish(code === 0));
	});
	if (!killedTree) killDirectChild();
}

export function describeRunTask(task: RunTaskName): RunTaskApprovalSummary {
	return { ...taskSummaries[task] };
}

export function parseRunTaskInput(input: Record<string, unknown>): RunTaskName {
	if (!runTaskValidator.Check(input)) {
		throw new Error("run_task arguments failed execution-time validation");
	}
	return (input as RunTaskInput).task;
}

export function createNodeRunTaskOperations(
	workspaceRoot: string,
	options?: {
		terminateProcessTree?: (
			pid: number | undefined,
			killDirectChild: () => void,
		) => Promise<void>;
	},
): RunTaskOperations {
	return {
		async run(task, signal) {
			throwIfAborted(signal);
			const executionSignal = signal
				? AbortSignal.any([signal, AbortSignal.timeout(taskTimeoutMs)])
				: AbortSignal.timeout(taskTimeoutMs);
			const resolvedRoot = await realpath(resolve(workspaceRoot));
			throwIfAborted(executionSignal);
			const appRoot = await realpath(join(resolvedRoot, "apps", "learning-agent"));
			if (!isWithinRoot(resolvedRoot, appRoot)) {
				throw new Error("Learning Agent task cwd escapes the workspace");
			}
			let command: string;
			let args: string[];
			let cwd: string;
			if (task === "learning_agent_test") {
				const testRoot = await realpath(join(appRoot, "test"));
				if (!isWithinRoot(appRoot, testRoot)) {
					throw new Error("Learning Agent test directory escapes the application root");
				}
				const testFiles = (await readdir(testRoot, { withFileTypes: true }))
					.filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
					.sort((left, right) => left.name.localeCompare(right.name))
					.map((entry) => join("test", entry.name));
				const tsxPath = await realpath(fileURLToPath(import.meta.resolve("tsx")));
				if (!isWithinRoot(resolvedRoot, tsxPath)) {
					throw new Error("Learning Agent test loader escapes the workspace");
				}
				command = process.execPath;
				args = ["--import", pathToFileURL(tsxPath).href, "--test", ...testFiles];
				cwd = appRoot;
			} else {
				const tscPath = await realpath(
					join(resolvedRoot, "node_modules", "typescript", "bin", "tsc"),
				);
				const tsconfigPath = await realpath(
					join(appRoot, "tsconfig.json"),
				);
				if (!isWithinRoot(resolvedRoot, tscPath) || !isWithinRoot(appRoot, tsconfigPath)) {
					throw new Error("Learning Agent typecheck files escape the workspace");
				}
				command = process.execPath;
				args = [
					tscPath,
					"--noEmit",
					"-p",
					tsconfigPath,
				];
				cwd = resolvedRoot;
			}
			throwIfAborted(executionSignal);
			if (process.platform === "win32") {
				const wrapped = await wrapWindowsTaskInJob(
					resolvedRoot,
					appRoot,
					command,
					args,
					cwd,
				);
				command = wrapped.command;
				args = wrapped.args;
				cwd = wrapped.cwd;
			}
			throwIfAborted(executionSignal);
			const startedAt = Date.now();
			return await new Promise<RunTaskResult>((resolvePromise, rejectPromise) => {
				const stdoutChunks: Buffer[] = [];
				const stderrChunks: Buffer[] = [];
				let stdoutBytes = 0;
				let stderrBytes = 0;
				let stdoutTruncated = false;
				let stderrTruncated = false;
				let settled = false;
				let termination: Promise<void> | undefined;
				const child = spawn(command, args, {
					cwd,
					detached: process.platform !== "win32",
					env: createTaskEnvironment(),
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
				const handleAbort = (): void => {
					if (!termination) {
						const terminate = options?.terminateProcessTree ?? terminateProcessTree;
						termination = terminate(child.pid, () => {
							child.kill("SIGKILL");
						})
							.catch(() => {
								child.kill("SIGKILL");
							})
							.then(async () => {
								if (child.exitCode !== null || child.signalCode !== null) return;
								await new Promise<void>((resolveExit, rejectExit) => {
									const finish = (): void => {
										clearTimeout(timeout);
										child.removeListener("exit", finish);
										resolveExit();
									};
									const timeout = setTimeout(() => {
										child.removeListener("exit", finish);
										rejectExit(
											new Error("Fixed task wrapper did not terminate within 2 seconds"),
										);
									}, 2_000);
									child.once("exit", finish);
								});
							});
						void termination.then(
							() => {
								if (settled) return;
								settled = true;
								executionSignal.removeEventListener("abort", handleAbort);
								try {
									throwIfAborted(executionSignal);
									rejectPromise(
										new Error("Task termination completed without an abort reason"),
									);
								} catch (error) {
									rejectPromise(error);
								}
							},
							(error: unknown) => {
								if (settled) return;
								settled = true;
								executionSignal.removeEventListener("abort", handleAbort);
								rejectPromise(error);
							},
						);
					}
				};
				executionSignal.addEventListener("abort", handleAbort, { once: true });
				if (executionSignal.aborted) handleAbort();
				child.stdout.on("data", (chunk: Buffer) => {
					const appended = appendBoundedChunk(stdoutChunks, chunk, stdoutBytes);
					stdoutBytes = appended.bytes;
					stdoutTruncated ||= appended.truncated;
				});
				child.stderr.on("data", (chunk: Buffer) => {
					const appended = appendBoundedChunk(stderrChunks, chunk, stderrBytes);
					stderrBytes = appended.bytes;
					stderrTruncated ||= appended.truncated;
				});
				child.once("error", (error) => {
					if (settled) return;
					if (executionSignal.aborted) {
						handleAbort();
						return;
					}
					settled = true;
					executionSignal.removeEventListener("abort", handleAbort);
					rejectPromise(error);
				});
				child.once("close", (code) => {
					if (settled) return;
					if (executionSignal.aborted) {
						handleAbort();
						return;
					}
					settled = true;
					executionSignal.removeEventListener("abort", handleAbort);
					resolvePromise({
						task,
						exitCode: code ?? -1,
						stdout: sanitizeOutputText(
							decodeCapturedOutput(stdoutChunks, stdoutTruncated),
						),
						stderr: sanitizeOutputText(
							decodeCapturedOutput(stderrChunks, stderrTruncated),
						),
						truncated: stdoutTruncated || stderrTruncated,
						durationMs: Date.now() - startedAt,
					});
				});
			});
		},
	};
}

function emitUpdate(
	onUpdate: AgentToolUpdateCallback<RunTaskToolDetails> | undefined,
	details: RunTaskToolDetails,
	signal?: AbortSignal,
): void {
	throwIfAborted(signal);
	onUpdate?.({
		content: [{ type: "text", text: `run_task: ${details.stage}` }],
		details,
	});
	throwIfAborted(signal);
}

export function createRunTaskTool(
	operations: RunTaskOperations,
): AgentTool<typeof runTaskSchema, RunTaskToolDetails> {
	return {
		name: "run_task",
		label: "run validation task",
		description:
			"Run one fixed Learning Agent validation task after explicit user approval. This tool does not accept command strings, arguments, cwd, environment variables, or arbitrary executables.",
		parameters: runTaskSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal, onUpdate) {
			if (!runTaskValidator.Check(rawInput)) {
				throw new Error("run_task arguments failed execution-time validation");
			}
			const input: RunTaskInput = rawInput;
			emitUpdate(onUpdate, { stage: "validating", task: input.task }, signal);
			emitUpdate(onUpdate, { stage: "running", task: input.task }, signal);
			const result = await operations.run(input.task, signal);
			throwIfAborted(signal);
			const output = [
				`${describeRunTask(input.task).label} exited with code ${result.exitCode} in ${result.durationMs}ms${result.truncated ? " (output truncated)" : ""}.`,
				result.stdout ? `stdout:\n${result.stdout}` : "stdout: (empty)",
				result.stderr ? `stderr:\n${result.stderr}` : "stderr: (empty)",
			].join("\n");
			return {
				content: [{ type: "text", text: output }],
				details: {
					stage: "completed",
					task: input.task,
					exitCode: result.exitCode,
					truncated: result.truncated,
					durationMs: result.durationMs,
				},
			} satisfies AgentToolResult<RunTaskToolDetails>;
		},
	};
}
