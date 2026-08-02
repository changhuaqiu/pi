import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import type {
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { normalizeRelativePath } from "./read-only-tools.ts";
import { redactSensitiveText } from "./tool-security.ts";
import { rejectLinkedDirectorySegments } from "./workspace-mutation-paths.ts";

export type ControlledCommandOperation = "npm_install" | "npm_run";
export type ControlledCommandMode = "foreground" | "service";

export interface ControlledCommandScript {
	name: string;
	command: string;
}

export interface ControlledCommandApprovalSummary {
	operation: ControlledCommandOperation;
	command: string;
	cwd: string;
	mode: ControlledCommandMode;
	timeoutMs: number;
	startupWaitMs: number;
	scripts?: readonly ControlledCommandScript[];
	risks: readonly string[];
}

export interface ControlledCommandPlan extends ControlledCommandApprovalSummary {
	executable: string;
	args: readonly string[];
	lexicalCwd: string;
	resolvedCwd: string;
	packageJsonPath: string;
	packageJsonHash: string;
}

export interface ControlledCommandResult {
	operation: ControlledCommandOperation;
	command: string;
	cwd: string;
	mode: ControlledCommandMode;
	status: "exited" | "running" | "timed_out" | "stopped";
	exitCode?: number;
	processId?: string;
	osPid?: number;
	stdout: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
	urls: string[];
}

export interface ControlledCommandProcessSummary {
	processId: string;
	command: string;
	cwd: string;
	status: "running" | "exited" | "timed_out" | "stopped" | "failed";
	osPid?: number;
	exitCode?: number;
	errorMessage?: string;
	startedAt: string;
	durationMs: number;
	truncated: boolean;
	urls: string[];
	stdout?: string;
	stderr?: string;
}

export interface ControlledCommandOutputEvent {
	stream: "stdout" | "stderr";
	text: string;
	stdoutBytes: number;
	stderrBytes: number;
	truncated: boolean;
}

export interface ControlledCommandManager {
	prepare(input: Record<string, unknown>, signal?: AbortSignal): Promise<ControlledCommandPlan>;
	approve(toolCallId: string, plan: ControlledCommandPlan): void;
	executeApproved(
		toolCallId: string,
		signal?: AbortSignal,
		onOutput?: (event: ControlledCommandOutputEvent) => void,
	): Promise<ControlledCommandResult>;
	listProcesses(): ControlledCommandProcessSummary[];
	getProcess(processId: string): ControlledCommandProcessSummary;
	stopProcess(processId: string, signal?: AbortSignal): Promise<ControlledCommandProcessSummary>;
	shutdown(): Promise<void>;
}

export interface ControlledCommandToolDetails {
	stage: "running" | "completed";
	operation: ControlledCommandOperation;
	command: string;
	cwd: string;
	mode: ControlledCommandMode;
	status?: ControlledCommandResult["status"];
	stream?: ControlledCommandOutputEvent["stream"];
	stdoutBytes?: number;
	stderrBytes?: number;
	truncated?: boolean;
	exitCode?: number;
	processId?: string;
	osPid?: number;
	durationMs?: number;
	urls?: string[];
}

export interface CommandStatusToolDetails {
	stage: "completed";
	processCount: number;
	processId?: string;
	status?: ControlledCommandProcessSummary["status"];
}

export interface StopCommandToolDetails {
	stage: "completed";
	processId: string;
	status: ControlledCommandProcessSummary["status"];
	exitCode?: number;
	durationMs: number;
}

const commandArgumentSchema = Type.String({
	minLength: 1,
	maxLength: 500,
	description: "One literal argument passed without shell parsing",
});

const runCommandSchema = Type.Object(
	{
		operation: Type.Union([
			Type.Literal("npm_install"),
			Type.Literal("npm_run"),
		]),
		cwd: Type.Optional(
			Type.String({
				maxLength: 500,
				description:
					"Workspace-relative project directory; defaults to the workspace root",
			}),
		),
		lifecycleScripts: Type.Optional(
			Type.Boolean({
				description:
					"Only for npm_install. Allow dependency lifecycle scripts; defaults to false and materially increases risk.",
			}),
		),
		script: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 100,
				pattern: "^[A-Za-z0-9:_-]+$",
				description: "Required for npm_run. Exact package.json script name.",
			}),
		),
		args: Type.Optional(
			Type.Array(commandArgumentSchema, {
				maxItems: 32,
				description: "Only for npm_run.",
			}),
		),
		mode: Type.Optional(
			Type.Union([Type.Literal("foreground"), Type.Literal("service")], {
				description:
					"Only for npm_run. Foreground waits for exit; service remains managed.",
			}),
		),
		timeoutMs: Type.Optional(
			Type.Integer({
				minimum: 1_000,
				maximum: 1_800_000,
				description:
					"Maximum runtime. npm_install is additionally limited to 300000.",
			}),
		),
		startupWaitMs: Type.Optional(
			Type.Integer({
				minimum: 250,
				maximum: 30_000,
				description:
					"Only for npm_run service mode. Startup observation window; defaults to 3000.",
			}),
		),
	},
	{ additionalProperties: false },
);

const commandStatusSchema = Type.Object(
	{
		processId: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 100,
				description: "Managed process id. Omit to list all managed processes.",
			}),
		),
	},
	{ additionalProperties: false },
);

const stopCommandSchema = Type.Object(
	{
		processId: Type.String({
			minLength: 1,
			maxLength: 100,
			description: "Managed process id returned by run_command",
		}),
	},
	{ additionalProperties: false },
);

type RunCommandInput = Static<typeof runCommandSchema>;
type CommandStatusInput = Static<typeof commandStatusSchema>;
type StopCommandInput = Static<typeof stopCommandSchema>;

const runCommandValidator = Compile(runCommandSchema);
const commandStatusValidator = Compile(commandStatusSchema);
const stopCommandValidator = Compile(stopCommandSchema);
const maxOutputBytesPerStream = 32 * 1024;
const maxPackageJsonBytes = 1024 * 1024;
const maxScriptCommandCharacters = 8 * 1024;
const maxManagedProcesses = 4;
const maxManagedProcessHistory = 20;
const discoveredUrlPattern =
	/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|[A-Za-z0-9.-]+)(?::\d{1,5})?(?:\/[^\s"'<>]*)?/giu;

interface ParsedCommandInput {
	operation: ControlledCommandOperation;
	cwd: string;
	mode: ControlledCommandMode;
	timeoutMs: number;
	startupWaitMs: number;
	lifecycleScripts: boolean;
	script?: string;
	args: string[];
}

interface CapturedStream {
	chunks: Buffer[];
	bytes: number;
	truncated: boolean;
	decoder: StringDecoder;
	pendingText: string;
}

interface RunningProcess {
	id: string;
	plan: ControlledCommandPlan;
	child: ChildProcessByStdio<null, Readable, Readable>;
	startedAt: number;
	stdout: CapturedStream;
	stderr: CapturedStream;
	urls: Set<string>;
	status: ControlledCommandProcessSummary["status"];
	exitCode?: number;
	errorMessage?: string;
	terminationTarget?: "stopped" | "timed_out";
	terminationPromise?: Promise<void>;
	lifetimeTimer?: NodeJS.Timeout;
	closePromise: Promise<void>;
	resolveClose(): void;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
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
			!pathFromRoot.startsWith("../") &&
			!isAbsolute(pathFromRoot))
	);
}

function quoteDisplayArgument(value: string): string {
	return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)
		? value
		: JSON.stringify(value);
}

function displayCommand(args: readonly string[]): string {
	return ["npm", ...args].map(quoteDisplayArgument).join(" ");
}

function parseRunCommandInput(input: Record<string, unknown>): ParsedCommandInput {
	if (!runCommandValidator.Check(input)) {
		throw new Error("run_command arguments failed execution-time validation");
	}
	const parsed: RunCommandInput = input;
	const cwd = normalizeRelativePath(parsed.cwd ?? ".");
	if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(cwd)) {
		throw new Error("Command cwd cannot contain Unicode control or formatting characters");
	}
	if (parsed.operation === "npm_install") {
		if (
			parsed.script !== undefined ||
			parsed.args !== undefined ||
			parsed.mode !== undefined ||
			parsed.startupWaitMs !== undefined ||
			(parsed.timeoutMs !== undefined && parsed.timeoutMs > 300_000)
		) {
			throw new Error("run_command arguments failed execution-time validation");
		}
		return {
			operation: parsed.operation,
			cwd,
			mode: "foreground",
			timeoutMs: parsed.timeoutMs ?? 300_000,
			startupWaitMs: 0,
			lifecycleScripts: parsed.lifecycleScripts ?? false,
			args: [],
		};
	}
	if (
		parsed.script === undefined ||
		parsed.lifecycleScripts !== undefined ||
		(parsed.startupWaitMs !== undefined && parsed.mode !== "service")
	) {
		throw new Error("run_command arguments failed execution-time validation");
	}
	for (const argument of parsed.args ?? []) {
		if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u0000]/u.test(argument)) {
			throw new Error("Command arguments cannot contain control or formatting characters");
		}
	}
	if (parsed.script.startsWith("-")) {
		throw new Error("package.json script names cannot begin with a hyphen");
	}
	const mode = parsed.mode ?? "foreground";
	return {
		operation: parsed.operation,
		cwd,
		mode,
		timeoutMs:
			parsed.timeoutMs ?? (mode === "service" ? 1_800_000 : 300_000),
		startupWaitMs: mode === "service" ? parsed.startupWaitMs ?? 3_000 : 0,
		lifecycleScripts: false,
		script: parsed.script,
		args: [...(parsed.args ?? [])],
	};
}

export function parseCommandStatusInput(
	input: Record<string, unknown>,
): CommandStatusInput {
	if (!commandStatusValidator.Check(input)) {
		throw new Error("command_status arguments failed execution-time validation");
	}
	return input as CommandStatusInput;
}

export function parseStopCommandInput(
	input: Record<string, unknown>,
): StopCommandInput {
	if (!stopCommandValidator.Check(input)) {
		throw new Error("stop_command arguments failed execution-time validation");
	}
	return input as StopCommandInput;
}

function createCommandEnvironment(): NodeJS.ProcessEnv {
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
				([key, value]) =>
					value !== undefined && allowedKeys.has(key.toUpperCase()),
			),
		),
		CI: process.env.CI ?? "1",
		NO_COLOR: "1",
		LOGOS_AGENT_CONTROLLED_COMMAND: "1",
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

async function resolveNpmCli(workspaceRoot: string): Promise<string> {
	const executableDirectory = dirname(process.execPath);
	const candidates = [
		process.env.npm_execpath,
		join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
		join(
			executableDirectory,
			"..",
			"lib",
			"node_modules",
			"npm",
			"bin",
			"npm-cli.js",
		),
	].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) {
		try {
			const resolved = await realpath(candidate);
			if (
				basename(resolved).toLowerCase() === "npm-cli.js" &&
				(await lstat(resolved)).isFile() &&
				!isWithinRoot(workspaceRoot, resolved)
			) {
				return resolved;
			}
		} catch {
			// Try the next trusted Node installation candidate.
		}
	}
	throw new Error("A trusted npm CLI could not be resolved outside the workspace");
}

async function wrapWindowsCommandInJob(
	validationRoot: string,
	executable: string,
	args: readonly string[],
	cwd: string,
): Promise<{ executable: string; args: string[]; cwd: string }> {
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
	const powershell = await realpath(
		join(
			systemRoot,
			"System32",
			"WindowsPowerShell",
			"v1.0",
			"powershell.exe",
		),
	);
	const appRoot = await realpath(join(validationRoot, "apps", "logos-agent"));
	const runner = await realpath(join(appRoot, "src", "windows-job-runner.ps1"));
	if (
		!isAbsolute(powershell) ||
		isWithinRoot(validationRoot, powershell) ||
		!isWithinRoot(appRoot, runner)
	) {
		throw new Error("Windows controlled-command runner paths failed scope validation");
	}
	const payload = Buffer.from(
		JSON.stringify({
			command: executable,
			arguments: args.map(quoteWindowsArgument).join(" "),
			cwd,
			environment: createCommandEnvironment(),
		}),
		"utf8",
	).toString("base64");
	return {
		executable: powershell,
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
		cwd: validationRoot,
	};
}

function appendBoundedChunk(stream: CapturedStream, chunk: Buffer): Buffer {
	const remaining = maxOutputBytesPerStream - stream.bytes;
	if (remaining <= 0) {
		stream.truncated = true;
		return Buffer.alloc(0);
	}
	const accepted = chunk.subarray(0, remaining);
	stream.chunks.push(accepted);
	stream.bytes += accepted.length;
	stream.truncated ||= chunk.length > remaining;
	return accepted;
}

function decodeCapturedOutput(stream: CapturedStream): string {
	const buffer = Buffer.concat(stream.chunks);
	if (!stream.truncated || buffer.length === 0) return buffer.toString("utf8");
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

function sanitizeOutputText(value: string, workspaceRoot: string): string {
	const terminalSafe = value.replace(
		/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
		(character) => {
			if (character === "\n" || character === "\t") return character;
			const codePoint = character.codePointAt(0);
			if (codePoint === undefined) return "";
			return codePoint <= 0xffff
				? `\\u${codePoint.toString(16).padStart(4, "0")}`
				: `\\u{${codePoint.toString(16)}}`;
		},
	);
	return redactSensitiveText(terminalSafe, workspaceRoot);
}

function collectUrls(target: Set<string>, text: string): void {
	for (const match of text.matchAll(discoveredUrlPattern)) {
		const url = match[0];
		if (target.size >= 20) return;
		target.add(url);
	}
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
				env: createCommandEnvironment(),
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

function processSummary(
	process: RunningProcess,
	includeOutput: boolean,
	workspaceRoot: string,
): ControlledCommandProcessSummary {
	return {
		processId: process.id,
		command: process.plan.command,
		cwd: process.plan.cwd,
		status: process.status,
		...(process.child.pid === undefined ? {} : { osPid: process.child.pid }),
		...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
		...(process.errorMessage === undefined
			? {}
			: { errorMessage: process.errorMessage }),
		startedAt: new Date(process.startedAt).toISOString(),
		durationMs: Date.now() - process.startedAt,
		truncated: process.stdout.truncated || process.stderr.truncated,
		urls: [...process.urls],
		...(includeOutput
			? {
					stdout: sanitizeOutputText(
						decodeCapturedOutput(process.stdout),
						workspaceRoot,
					),
					stderr: sanitizeOutputText(
						decodeCapturedOutput(process.stderr),
						workspaceRoot,
					),
				}
			: {}),
	};
}

export function commandPlanApprovalSummary(
	plan: ControlledCommandPlan,
): ControlledCommandApprovalSummary {
	return {
		operation: plan.operation,
		command: plan.command,
		cwd: plan.cwd,
		mode: plan.mode,
		timeoutMs: plan.timeoutMs,
		startupWaitMs: plan.startupWaitMs,
		...(plan.scripts === undefined
			? {}
			: { scripts: plan.scripts.map((script) => ({ ...script })) }),
		risks: [...plan.risks],
	};
}

export function createNodeControlledCommandManager(
	workspaceRoot: string,
	validationRoot: string,
	options?: {
		terminateProcessTree?: (
			pid: number | undefined,
			killDirectChild: () => void,
		) => Promise<void>;
	},
): ControlledCommandManager {
	const approvedPlans = new Map<string, ControlledCommandPlan>();
	const processes = new Map<string, RunningProcess>();
	const activeProcesses = new Set<RunningProcess>();
	const resolvedWorkspacePromise = realpath(resolve(workspaceRoot));
	const resolvedValidationPromise = realpath(resolve(validationRoot));
	const terminate = options?.terminateProcessTree ?? terminateProcessTree;

	const validatePlanState = async (
		plan: ControlledCommandPlan,
		signal?: AbortSignal,
	): Promise<void> => {
		throwIfAborted(signal);
		const [resolvedWorkspace, resolvedCwd, packageJsonPath, executable] =
			await Promise.all([
				resolvedWorkspacePromise,
				realpath(plan.lexicalCwd),
				realpath(plan.packageJsonPath),
				realpath(plan.executable),
			]);
		throwIfAborted(signal);
		if (
			!isWithinRoot(resolvedWorkspace, resolvedCwd) ||
			resolvedCwd !== plan.resolvedCwd ||
			!isWithinRoot(resolvedCwd, packageJsonPath) ||
			packageJsonPath !== plan.packageJsonPath ||
			executable !== plan.executable
		) {
			throw new Error("Controlled command paths changed after approval");
		}
		await rejectLinkedDirectorySegments(
			resolvedWorkspace,
			plan.lexicalCwd,
			signal,
		);
		const packageStat = await lstat(packageJsonPath);
		if (!packageStat.isFile() || packageStat.isSymbolicLink()) {
			throw new Error("package.json must remain a regular non-symbolic file");
		}
		const packageJson = await readFile(packageJsonPath);
		if (
			createHash("sha256").update(packageJson).digest("hex") !==
			plan.packageJsonHash
		) {
			throw new Error("package.json changed after command approval");
		}
	};

	const startProcess = async (
		plan: ControlledCommandPlan,
		onOutput?: (event: ControlledCommandOutputEvent) => void,
	): Promise<RunningProcess> => {
		const validationRootPath = await resolvedValidationPromise;
		let executable = process.execPath;
		let args = [plan.executable, ...plan.args];
		let cwd = plan.resolvedCwd;
		if (process.platform === "win32") {
			const wrapped = await wrapWindowsCommandInJob(
				validationRootPath,
				executable,
				args,
				cwd,
			);
			executable = wrapped.executable;
			args = wrapped.args;
			cwd = wrapped.cwd;
		}
		const child = spawn(executable, args, {
			cwd,
			detached: process.platform !== "win32",
			env: createCommandEnvironment(),
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let resolveClose = (): void => {};
		const closePromise = new Promise<void>((resolvePromise) => {
			resolveClose = resolvePromise;
		});
		const running: RunningProcess = {
			id: randomUUID(),
			plan,
			child,
			startedAt: Date.now(),
			stdout: {
				chunks: [],
				bytes: 0,
				truncated: false,
				decoder: new StringDecoder("utf8"),
				pendingText: "",
			},
			stderr: {
				chunks: [],
				bytes: 0,
				truncated: false,
				decoder: new StringDecoder("utf8"),
				pendingText: "",
			},
			urls: new Set(),
			status: "running",
			closePromise,
			resolveClose,
		};
		activeProcesses.add(running);
		let spawned = false;
		child.once("spawn", () => {
			spawned = true;
		});
		const handleChunk = (
			streamName: ControlledCommandOutputEvent["stream"],
			chunk: Buffer,
		): void => {
			const stream =
				streamName === "stdout" ? running.stdout : running.stderr;
			const accepted = appendBoundedChunk(stream, chunk);
			if (accepted.length === 0) return;
			stream.pendingText += stream.decoder.write(accepted);
			const lastNewline = stream.pendingText.lastIndexOf("\n");
			if (lastNewline < 0) return;
			const completeText = stream.pendingText.slice(0, lastNewline + 1);
			stream.pendingText = stream.pendingText.slice(lastNewline + 1);
			const safeText = sanitizeOutputText(completeText, workspaceRoot);
			collectUrls(running.urls, safeText);
			if (safeText) {
				onOutput?.({
					stream: streamName,
					text: safeText,
					stdoutBytes: running.stdout.bytes,
					stderrBytes: running.stderr.bytes,
					truncated:
						running.stdout.truncated || running.stderr.truncated,
				});
			}
		};
		child.stdout.on("data", (chunk: Buffer) => handleChunk("stdout", chunk));
		child.stderr.on("data", (chunk: Buffer) => handleChunk("stderr", chunk));
		child.on("error", (error) => {
			running.errorMessage = error.message;
			if (!spawned) running.status = "failed";
		});
		child.once("close", (code) => {
			activeProcesses.delete(running);
			const stdoutTail =
				running.stdout.pendingText + running.stdout.decoder.end();
			const stderrTail =
				running.stderr.pendingText + running.stderr.decoder.end();
			if (stdoutTail) {
				const safeText = sanitizeOutputText(stdoutTail, workspaceRoot);
				collectUrls(running.urls, safeText);
				onOutput?.({
					stream: "stdout",
					text: safeText,
					stdoutBytes: running.stdout.bytes,
					stderrBytes: running.stderr.bytes,
					truncated:
						running.stdout.truncated || running.stderr.truncated,
				});
			}
			if (stderrTail) {
				const safeText = sanitizeOutputText(stderrTail, workspaceRoot);
				collectUrls(running.urls, safeText);
				onOutput?.({
					stream: "stderr",
					text: safeText,
					stdoutBytes: running.stdout.bytes,
					stderrBytes: running.stderr.bytes,
					truncated:
						running.stdout.truncated || running.stderr.truncated,
				});
			}
			running.stdout.pendingText = "";
			running.stderr.pendingText = "";
			if (running.status === "running") {
				running.status = running.terminationTarget ?? "exited";
			}
			running.exitCode = code ?? -1;
			if (running.lifetimeTimer) clearTimeout(running.lifetimeTimer);
			running.resolveClose();
		});
		return running;
	};

	const stopRunningProcess = async (
		running: RunningProcess,
		status: "stopped" | "timed_out",
	): Promise<void> => {
		if (running.status !== "running") return;
		if (running.terminationPromise) {
			await running.terminationPromise;
			return;
		}
		running.terminationTarget = status;
		const terminationPromise = (async () => {
			try {
				await terminate(running.child.pid, () => {
					running.child.kill("SIGKILL");
				});
				await Promise.race([
					running.closePromise,
					new Promise<void>((_, rejectPromise) => {
						const timeout = setTimeout(() => {
							rejectPromise(
								new Error(
									"Controlled command did not terminate within 2 seconds",
								),
							);
						}, 2_000);
						timeout.unref();
					}),
				]);
				running.errorMessage = undefined;
			} catch (error) {
				running.terminationTarget = undefined;
				running.errorMessage =
					error instanceof Error ? error.message : String(error);
				throw error;
			} finally {
				running.terminationPromise = undefined;
			}
		})();
		running.terminationPromise = terminationPromise;
		await terminationPromise;
	};

	const terminateWithRetries = async (
		running: RunningProcess,
		status: "stopped" | "timed_out",
	): Promise<void> => {
		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				await stopRunningProcess(running, status);
				return;
			} catch (error) {
				lastError = error;
				if (running.status !== "running") {
					running.errorMessage = undefined;
					return;
				}
				await new Promise<void>((resolvePromise) => {
					const timeout = setTimeout(resolvePromise, 100);
					timeout.unref();
				});
			}
		}
		throw lastError instanceof Error
			? lastError
			: new Error("Controlled command process-tree termination failed");
	};

	const pruneProcessHistory = (): void => {
		while (processes.size >= maxManagedProcessHistory) {
			const oldestCompleted = [...processes.values()]
				.filter((process) => process.status !== "running")
				.sort((left, right) => left.startedAt - right.startedAt)[0];
			if (!oldestCompleted) return;
			processes.delete(oldestCompleted.id);
		}
	};

	return {
		async prepare(rawInput, signal) {
			throwIfAborted(signal);
			const input = parseRunCommandInput(rawInput);
			const resolvedWorkspace = await resolvedWorkspacePromise;
			const lexicalCwd = resolve(resolvedWorkspace, input.cwd);
			if (!isWithinRoot(resolvedWorkspace, lexicalCwd)) {
				throw new Error("Command cwd escapes the workspace");
			}
			await rejectLinkedDirectorySegments(
				resolvedWorkspace,
				lexicalCwd,
				signal,
			);
			const resolvedCwd = await realpath(lexicalCwd);
			if (!isWithinRoot(resolvedWorkspace, resolvedCwd)) {
				throw new Error("Command cwd escapes the workspace");
			}
			if (!(await lstat(resolvedCwd)).isDirectory()) {
				throw new Error("Command cwd must be an existing directory");
			}
			const lexicalPackageJsonPath = join(resolvedCwd, "package.json");
			const lexicalPackageStat = await lstat(lexicalPackageJsonPath);
			if (
				!lexicalPackageStat.isFile() ||
				lexicalPackageStat.isSymbolicLink()
			) {
				throw new Error("package.json must be a regular non-symbolic file");
			}
			const packageJsonPath = await realpath(lexicalPackageJsonPath);
			if (!isWithinRoot(resolvedCwd, packageJsonPath)) {
				throw new Error("package.json escapes the command cwd");
			}
			const packageStat = await lstat(packageJsonPath);
			if (!packageStat.isFile() || packageStat.isSymbolicLink()) {
				throw new Error("package.json must be a regular non-symbolic file");
			}
			if (packageStat.size > maxPackageJsonBytes) {
				throw new Error("package.json exceeds the 1 MiB safety limit");
			}
			const packageJson = await readFile(packageJsonPath);
			let manifest: unknown;
			try {
				manifest = JSON.parse(packageJson.toString("utf8"));
			} catch {
				throw new Error("package.json is not valid JSON");
			}
			if (
				typeof manifest !== "object" ||
				manifest === null ||
				Array.isArray(manifest)
			) {
				throw new Error("package.json must contain an object");
			}
			const scripts =
				"scripts" in manifest &&
				typeof manifest.scripts === "object" &&
				manifest.scripts !== null &&
				!Array.isArray(manifest.scripts)
					? (manifest.scripts as Record<string, unknown>)
					: {};
			const getScript = (name: string): unknown =>
				Object.hasOwn(scripts, name) ? scripts[name] : undefined;
			let npmArgs: string[];
			let approvedScripts: ControlledCommandScript[] | undefined;
			const risks = [
				"executes a local project command",
				"concurrent external replacement during launch is unsupported",
			];
			if (input.operation === "npm_install") {
				npmArgs = ["install", "--no-audit", "--no-fund"];
				if (!input.lifecycleScripts) npmArgs.push("--ignore-scripts");
				risks.push("may access the network", "writes dependencies and lockfiles");
				if (input.lifecycleScripts) {
					risks.push("dependency lifecycle scripts are enabled");
				}
			} else {
				const requestedScriptName = input.script!;
				const requestedScript = getScript(requestedScriptName);
				if (
					typeof requestedScript !== "string" ||
					!requestedScript.trim()
				) {
					throw new Error(
						`package.json does not define the requested script: ${input.script}`,
					);
				}
				if (requestedScript.length > maxScriptCommandCharacters) {
					throw new Error(
						"Requested package.json script exceeds the 8192 character review limit",
					);
				}
				approvedScripts = [];
				for (const scriptName of [
					`pre${requestedScriptName}`,
					requestedScriptName,
					`post${requestedScriptName}`,
				]) {
					const command = getScript(scriptName);
					if (command === undefined) continue;
					if (
						typeof command !== "string" ||
						!command.trim() ||
						command.length > maxScriptCommandCharacters
					) {
						throw new Error(
							`package.json script ${scriptName} is invalid or exceeds the 8192 character review limit`,
						);
					}
					approvedScripts.push({ name: scriptName, command });
				}
				npmArgs = ["run", input.script!, "--", ...input.args];
				risks.push(
					"the package.json script can read or write files and access the network",
				);
				if (input.mode === "service") {
					risks.push("starts a managed long-running process");
				}
			}
			const executable = await resolveNpmCli(resolvedWorkspace);
			throwIfAborted(signal);
			return {
				operation: input.operation,
				command: displayCommand(npmArgs),
				cwd: input.cwd,
				mode: input.mode,
				timeoutMs: input.timeoutMs,
				startupWaitMs: input.startupWaitMs,
				...(approvedScripts === undefined ? {} : { scripts: approvedScripts }),
				risks,
				executable,
				args: npmArgs,
				lexicalCwd,
				resolvedCwd,
				packageJsonPath,
				packageJsonHash: createHash("sha256")
					.update(packageJson)
					.digest("hex"),
			};
		},
		approve(toolCallId, plan) {
			approvedPlans.set(toolCallId, structuredClone(plan));
		},
		async executeApproved(toolCallId, signal, onOutput) {
			const plan = approvedPlans.get(toolCallId);
			approvedPlans.delete(toolCallId);
			if (!plan) {
				throw new Error("run_command requires a matching approved command plan");
			}
			await validatePlanState(plan, signal);
			if (
				plan.mode === "service" &&
				[...processes.values()].filter(
					(process) => process.status === "running",
				).length >= maxManagedProcesses
			) {
				throw new Error(
					`At most ${maxManagedProcesses} managed commands may run concurrently`,
				);
			}
			const running = await startProcess(plan, onOutput);
			try {
				await validatePlanState(plan, signal);
			} catch (error) {
				await terminateWithRetries(running, "stopped");
				throw error;
			}
			const abort = async (): Promise<never> => {
				await terminateWithRetries(running, "stopped");
				throwIfAborted(signal);
				throw new Error("Controlled command aborted");
			};
			if (signal?.aborted) return await abort();
			let abortListener: (() => void) | undefined;
			const abortPromise = new Promise<never>((_, rejectPromise) => {
				abortListener = () => {
					void abort().catch(rejectPromise);
				};
				signal?.addEventListener("abort", abortListener, { once: true });
			});
			if (plan.mode === "service") {
				const startupTimer = new Promise<"running">((resolvePromise) => {
					const timeout = setTimeout(
						() => resolvePromise("running"),
						plan.startupWaitMs,
					);
					timeout.unref();
					running.closePromise.finally(() => clearTimeout(timeout));
				});
				const lifetimeTimer = new Promise<"timed_out">(
					(resolvePromise, rejectPromise) => {
						const remainingMs = Math.max(
							0,
							plan.timeoutMs - (Date.now() - running.startedAt),
						);
						const timeout = setTimeout(() => {
							void terminateWithRetries(running, "timed_out").then(
								() => resolvePromise("timed_out"),
								rejectPromise,
							);
						}, remainingMs);
						timeout.unref();
						running.lifetimeTimer = timeout;
						running.closePromise.finally(() => clearTimeout(timeout));
					},
				);
				const startupStatus = await Promise.race([
					running.closePromise.then(() => "exited" as const),
					startupTimer,
					lifetimeTimer,
					abortPromise,
				]);
				if (abortListener) {
					signal?.removeEventListener("abort", abortListener);
				}
				throwIfAborted(signal);
				if (running.status === "failed") {
					throw new Error(
						`Controlled command failed to start: ${running.errorMessage ?? "unknown spawn error"}`,
					);
				}
				if (startupStatus === "running" && running.status === "running") {
					pruneProcessHistory();
					processes.set(running.id, running);
					return {
						operation: plan.operation,
						command: plan.command,
						cwd: plan.cwd,
						mode: plan.mode,
						status: "running",
						processId: running.id,
						...(running.child.pid === undefined
							? {}
							: { osPid: running.child.pid }),
						stdout: sanitizeOutputText(
							decodeCapturedOutput(running.stdout),
							workspaceRoot,
						),
						stderr: sanitizeOutputText(
							decodeCapturedOutput(running.stderr),
							workspaceRoot,
						),
						truncated:
							running.stdout.truncated || running.stderr.truncated,
						durationMs: Date.now() - running.startedAt,
						urls: [...running.urls],
					};
				}
			} else {
				let timedOut = false;
				const timeoutPromise = new Promise<"timed_out">(
					(resolvePromise, rejectPromise) => {
					const remainingMs = Math.max(
						0,
						plan.timeoutMs - (Date.now() - running.startedAt),
					);
					const timeout = setTimeout(() => {
						timedOut = true;
						void terminateWithRetries(running, "timed_out").then(
							() => resolvePromise("timed_out"),
							rejectPromise,
						);
					}, remainingMs);
					timeout.unref();
					running.closePromise.finally(() => clearTimeout(timeout));
				},
				);
				await Promise.race([
					running.closePromise,
					timeoutPromise,
					abortPromise,
				]);
				if (abortListener) {
					signal?.removeEventListener("abort", abortListener);
				}
				throwIfAborted(signal);
				if (timedOut && running.status === "running") {
					await terminateWithRetries(running, "timed_out");
				}
			}
			if (running.status === "failed") {
				throw new Error(
					`Controlled command failed to start: ${running.errorMessage ?? "unknown spawn error"}`,
				);
			}
			return {
				operation: plan.operation,
				command: plan.command,
				cwd: plan.cwd,
				mode: plan.mode,
				status:
					running.status === "timed_out"
						? "timed_out"
						: running.status === "stopped"
							? "stopped"
							: "exited",
				...(running.exitCode === undefined
					? {}
					: { exitCode: running.exitCode }),
				stdout: sanitizeOutputText(
					decodeCapturedOutput(running.stdout),
					workspaceRoot,
				),
				stderr: sanitizeOutputText(
					decodeCapturedOutput(running.stderr),
					workspaceRoot,
				),
				truncated:
					running.stdout.truncated || running.stderr.truncated,
				durationMs: Date.now() - running.startedAt,
				urls: [...running.urls],
			};
		},
		listProcesses() {
			return [...processes.values()]
				.map((process) => processSummary(process, false, workspaceRoot))
				.sort((left, right) =>
					right.startedAt.localeCompare(left.startedAt),
				);
		},
		getProcess(processId) {
			const process = processes.get(processId);
			if (!process) {
				throw new Error(`Managed command was not found: ${processId}`);
			}
			return processSummary(process, true, workspaceRoot);
		},
		async stopProcess(processId, signal) {
			throwIfAborted(signal);
			const process = processes.get(processId);
			if (!process) {
				throw new Error(`Managed command was not found: ${processId}`);
			}
			await terminateWithRetries(process, "stopped");
			throwIfAborted(signal);
			return processSummary(process, true, workspaceRoot);
		},
		async shutdown() {
			approvedPlans.clear();
			const results = await Promise.allSettled(
				[...activeProcesses].map(
					async (process) =>
						await terminateWithRetries(process, "stopped"),
				),
			);
			const failures = results
				.filter(
					(result): result is PromiseRejectedResult =>
						result.status === "rejected",
				)
				.map((result) => result.reason);
			if (failures.length > 0) {
				throw new AggregateError(
					failures,
					"One or more managed commands could not be terminated",
				);
			}
		},
	};
}

function emitCommandUpdate(
	onUpdate: AgentToolUpdateCallback<ControlledCommandToolDetails> | undefined,
	details: ControlledCommandToolDetails,
	text: string,
	signal?: AbortSignal,
): void {
	if (signal?.aborted) return;
	onUpdate?.({
		content: [{ type: "text", text }],
		details,
	});
}

function commandResultText(result: ControlledCommandResult): string {
	return [
		`${result.command} ${result.status}${result.exitCode === undefined ? "" : ` with exit code ${result.exitCode}`} in ${result.durationMs}ms${result.truncated ? " (output truncated)" : ""}.`,
		...(result.processId ? [`Managed process: ${result.processId}`] : []),
		...(result.urls.length > 0
			? [
					`Detected URLs:\n${result.urls.map((url) => `- ${url}`).join("\n")}`,
				]
			: []),
		result.stdout ? `stdout:\n${result.stdout}` : "stdout: (empty)",
		result.stderr ? `stderr:\n${result.stderr}` : "stderr: (empty)",
	].join("\n");
}

export function createRunCommandTool(
	manager: ControlledCommandManager,
): AgentTool<typeof runCommandSchema, ControlledCommandToolDetails> {
	return {
		name: "run_command",
		label: "run controlled project command",
		description:
			"Run a structured npm install or package.json script after policy review. No shell command string, pipeline, redirection, environment override, or arbitrary executable is accepted. Commands can run in the foreground or as bounded managed services.",
		parameters: runCommandSchema,
		executionMode: "sequential",
		async execute(toolCallId, rawInput, signal, onUpdate) {
			if (!runCommandValidator.Check(rawInput)) {
				throw new Error("run_command arguments failed execution-time validation");
			}
			const input = rawInput as RunCommandInput;
			const operation = input.operation;
			const cwd = normalizeRelativePath(input.cwd ?? ".");
			const mode =
				operation === "npm_run"
					? input.mode ?? "foreground"
					: "foreground";
			const result = await manager.executeApproved(
				toolCallId,
				signal,
				(event) => {
					emitCommandUpdate(
						onUpdate,
						{
							stage: "running",
							operation,
							command:
								operation === "npm_run"
									? `npm run ${input.script}`
									: "npm install",
							cwd,
							mode,
							stream: event.stream,
							stdoutBytes: event.stdoutBytes,
							stderrBytes: event.stderrBytes,
							truncated: event.truncated,
						},
						`${event.stream}:\n${event.text}`,
						signal,
					);
				},
			);
			throwIfAborted(signal);
			return {
				content: [{ type: "text", text: commandResultText(result) }],
				details: {
					stage: "completed",
					operation: result.operation,
					command: result.command,
					cwd: result.cwd,
					mode: result.mode,
					status: result.status,
					...(result.exitCode === undefined
						? {}
						: { exitCode: result.exitCode }),
					...(result.processId === undefined
						? {}
						: { processId: result.processId }),
					...(result.osPid === undefined ? {} : { osPid: result.osPid }),
					truncated: result.truncated,
					durationMs: result.durationMs,
					urls: result.urls,
				},
			} satisfies AgentToolResult<ControlledCommandToolDetails>;
		},
	};
}

function processSummaryText(
	process: ControlledCommandProcessSummary,
): string {
	return [
		`${process.processId} ${process.status} ${process.command}`,
		`cwd: ${process.cwd}`,
		`duration: ${process.durationMs}ms${process.exitCode === undefined ? "" : `; exit code: ${process.exitCode}`}${process.truncated ? "; output truncated" : ""}`,
		...(process.urls.length > 0
			? [`URLs:\n${process.urls.map((url) => `- ${url}`).join("\n")}`]
			: []),
		...(process.errorMessage
			? [`termination error: ${process.errorMessage}`]
			: []),
		...(process.stdout === undefined
			? []
			: [
					process.stdout
						? `stdout:\n${process.stdout}`
						: "stdout: (empty)",
				]),
		...(process.stderr === undefined
			? []
			: [
					process.stderr
						? `stderr:\n${process.stderr}`
						: "stderr: (empty)",
				]),
	].join("\n");
}

export function createCommandStatusTool(
	manager: ControlledCommandManager,
): AgentTool<typeof commandStatusSchema, CommandStatusToolDetails> {
	return {
		name: "command_status",
		label: "inspect managed project commands",
		description:
			"List managed project commands or inspect one command's status, detected URLs, and bounded captured output. This tool does not start or stop processes.",
		parameters: commandStatusSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal) {
			const input = parseCommandStatusInput(rawInput);
			throwIfAborted(signal);
			const processes = input.processId
				? [manager.getProcess(input.processId)]
				: manager.listProcesses();
			return {
				content: [
					{
						type: "text",
						text:
							processes.length === 0
								? "No managed project commands."
								: processes.map(processSummaryText).join("\n\n"),
					},
				],
				details: {
					stage: "completed",
					processCount: processes.length,
					...(input.processId === undefined
						? {}
						: {
								processId: input.processId,
								status: processes[0]!.status,
							}),
				},
			};
		},
	};
}

export function createStopCommandTool(
	manager: ControlledCommandManager,
): AgentTool<typeof stopCommandSchema, StopCommandToolDetails> {
	return {
		name: "stop_command",
		label: "stop managed project command",
		description:
			"Terminate one managed project command and its process tree after explicit approval.",
		parameters: stopCommandSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal) {
			const input = parseStopCommandInput(rawInput);
			const process = await manager.stopProcess(input.processId, signal);
			return {
				content: [{ type: "text", text: processSummaryText(process) }],
				details: {
					stage: "completed",
					processId: process.processId,
					status: process.status,
					...(process.exitCode === undefined
						? {}
						: { exitCode: process.exitCode }),
					durationMs: process.durationMs,
				},
			};
		},
	};
}
