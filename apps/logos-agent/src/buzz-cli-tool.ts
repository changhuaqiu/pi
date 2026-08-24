import { spawn } from "node:child_process";
import type {
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

export interface BuzzCliRequest {
	args: string[];
	stdin?: string;
}

export interface BuzzCliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
}

export interface BuzzCliOperations {
	run(request: BuzzCliRequest, signal?: AbortSignal): Promise<BuzzCliResult>;
}

export interface BuzzCliToolDetails {
	stage: "validating" | "running" | "completed";
	command: string;
	exitCode?: number;
	truncated?: boolean;
	durationMs?: number;
}

const buzzCliSchema = Type.Object(
	{
		args: Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
			minItems: 1,
			maxItems: 64,
			description: [
				"Arguments passed directly to the fixed buzz executable, without a shell.",
				"Start with a Buzz command group such as messages, channels, repos, issues, or pr.",
			].join(" "),
		}),
		stdin: Type.Optional(
			Type.String({
				maxLength: 65_536,
				description:
					"Optional UTF-8 stdin. Prefer --content - plus stdin for multiline Buzz messages.",
			}),
		),
	},
	{ additionalProperties: false },
);

type BuzzCliInput = Static<typeof buzzCliSchema>;

const buzzCliValidator = Compile(buzzCliSchema);
const maxOutputBytes = 64 * 1024;
const timeoutMs = 30_000;

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	const error = new Error("Buzz CLI operation aborted");
	error.name = "AbortError";
	throw error;
}

function parseBuzzCliInput(input: Readonly<Record<string, unknown>>): BuzzCliRequest {
	if (!buzzCliValidator.Check(input)) {
		throw new Error("buzz_cli arguments failed execution-time validation");
	}
	const parsed: BuzzCliInput = input;
	if (parsed.args.some((argument) => argument.includes("\0"))) {
		throw new Error("buzz_cli arguments cannot contain NUL bytes");
	}
	const totalBytes = parsed.args.reduce(
		(total, argument) => total + Buffer.byteLength(argument, "utf8"),
		0,
	);
	if (totalBytes > 32 * 1024) {
		throw new Error("buzz_cli arguments exceed the 32768-byte limit");
	}
	return {
		args: [...parsed.args],
		...(parsed.stdin === undefined ? {} : { stdin: parsed.stdin }),
	};
}

function createBuzzCliEnvironment(): NodeJS.ProcessEnv {
	const allowedKeys = new Set([
		"APPDATA",
		"BUZZ_API_TOKEN",
		"BUZZ_AUTH_TAG",
		"BUZZ_GIT_ORIGIN_AGENT_NAME",
		"BUZZ_GIT_ORIGIN_CHANNEL_ID",
		"BUZZ_PRIVATE_KEY",
		"BUZZ_RELAY_URL",
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
	return Object.fromEntries(
		Object.entries(process.env).filter(
			([key, value]) => value !== undefined && allowedKeys.has(key.toUpperCase()),
		),
	);
}

function sanitizeOutput(value: string): string {
	return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
		if (character === "\n" || character === "\t") return character;
		const codePoint = character.codePointAt(0);
		return codePoint === undefined
			? ""
			: `\\u${codePoint.toString(16).padStart(4, "0")}`;
	});
}

function appendBounded(
	chunks: Buffer[],
	chunk: Buffer,
	currentBytes: number,
): { bytes: number; truncated: boolean } {
	const remaining = maxOutputBytes - currentBytes;
	if (remaining <= 0) return { bytes: currentBytes, truncated: true };
	chunks.push(chunk.subarray(0, remaining));
	return {
		bytes: currentBytes + Math.min(chunk.length, remaining),
		truncated: chunk.length > remaining,
	};
}

function terminateChild(child: ReturnType<typeof spawn>): void {
	if (child.pid !== undefined && process.platform !== "win32") {
		try {
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {
			// Fall back to the direct child below.
		}
	}
	child.kill("SIGKILL");
}

export function createNodeBuzzCliOperations(
	options: { command?: string; cwd: string },
): BuzzCliOperations {
	const command = options.command ?? "buzz";
	return {
		async run(request, signal) {
			throwIfAborted(signal);
			const executionSignal = signal
				? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
				: AbortSignal.timeout(timeoutMs);
			const startedAt = Date.now();
			return await new Promise<BuzzCliResult>((resolvePromise, rejectPromise) => {
				const stdoutChunks: Buffer[] = [];
				const stderrChunks: Buffer[] = [];
				let stdoutBytes = 0;
				let stderrBytes = 0;
				let stdoutTruncated = false;
				let stderrTruncated = false;
				let settled = false;
				const child = spawn(command, request.args, {
					cwd: options.cwd,
					detached: process.platform !== "win32",
					env: createBuzzCliEnvironment(),
					shell: false,
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				});
				const finishError = (error: unknown): void => {
					if (settled) return;
					settled = true;
					executionSignal.removeEventListener("abort", handleAbort);
					rejectPromise(error instanceof Error ? error : new Error(String(error)));
				};
				const handleAbort = (): void => {
					terminateChild(child);
					try {
						throwIfAborted(signal);
						finishError(new Error(`Buzz CLI timed out after ${timeoutMs}ms`));
					} catch (error) {
						finishError(error);
					}
				};
				executionSignal.addEventListener("abort", handleAbort, { once: true });
				if (executionSignal.aborted) handleAbort();
				child.stdout.on("data", (chunk: Buffer) => {
					const appended = appendBounded(stdoutChunks, chunk, stdoutBytes);
					stdoutBytes = appended.bytes;
					stdoutTruncated ||= appended.truncated;
				});
				child.stderr.on("data", (chunk: Buffer) => {
					const appended = appendBounded(stderrChunks, chunk, stderrBytes);
					stderrBytes = appended.bytes;
					stderrTruncated ||= appended.truncated;
				});
				child.once("error", finishError);
				child.stdin.on("error", () => {
					// A killed child can close stdin before the buffered write completes.
				});
				child.once("close", (code) => {
					if (settled) return;
					settled = true;
					executionSignal.removeEventListener("abort", handleAbort);
					resolvePromise({
						exitCode: code ?? -1,
						stdout: sanitizeOutput(Buffer.concat(stdoutChunks).toString("utf8")),
						stderr: sanitizeOutput(Buffer.concat(stderrChunks).toString("utf8")),
						truncated: stdoutTruncated || stderrTruncated,
						durationMs: Date.now() - startedAt,
					});
				});
				if (request.stdin === undefined) child.stdin.end();
				else child.stdin.end(request.stdin, "utf8");
			});
		},
	};
}

function emitUpdate(
	onUpdate: AgentToolUpdateCallback<BuzzCliToolDetails> | undefined,
	details: BuzzCliToolDetails,
	signal?: AbortSignal,
): void {
	throwIfAborted(signal);
	onUpdate?.({
		content: [{ type: "text", text: `buzz_cli: ${details.stage}` }],
		details,
	});
	throwIfAborted(signal);
}

export function createBuzzCliTool(
	operations: BuzzCliOperations,
): AgentTool<typeof buzzCliSchema, BuzzCliToolDetails> {
	return {
		name: "buzz_cli",
		label: "operate Buzz",
		description: [
			"Run the fixed Buzz CLI without a shell.",
			"Use this to read Buzz state and to publish every requested answer, result, blocker, or question",
			"back to the originating Buzz channel. Pass multiline message bodies with --content - and stdin.",
		].join(" "),
		parameters: buzzCliSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal, onUpdate) {
			const request = parseBuzzCliInput(rawInput);
			const command = `buzz ${request.args[0]}`;
			emitUpdate(onUpdate, { stage: "validating", command }, signal);
			emitUpdate(onUpdate, { stage: "running", command }, signal);
			const result = await operations.run(request, signal);
			throwIfAborted(signal);
			const output = [
				`Buzz CLI exited with code ${result.exitCode} in ${result.durationMs}ms${
					result.truncated ? " (output truncated)" : ""
				}.`,
				result.stdout ? `stdout:\n${result.stdout}` : "stdout: (empty)",
				result.stderr ? `stderr:\n${result.stderr}` : "stderr: (empty)",
			].join("\n");
			return {
				content: [{ type: "text", text: output }],
				details: {
					stage: "completed",
					command,
					exitCode: result.exitCode,
					truncated: result.truncated,
					durationMs: result.durationMs,
				},
			} satisfies AgentToolResult<BuzzCliToolDetails>;
		},
	};
}
