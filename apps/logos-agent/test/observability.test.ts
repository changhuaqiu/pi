import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	SpanStatusCode,
	type NodeTracerProvider,
} from "@arizeai/phoenix-otel";
import {
	createLogosAgentObservability,
	serializeObservabilityValue,
	summarizeProcessedTokenUsage,
	type LogosAgentTurnResult,
} from "../src/observability.ts";

const workspaceRoot = "C:\\workspace";

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

test("captured observability values redact credentials without hiding token limits", () => {
	const serialized = serializeObservabilityValue({
		apiKey: "secret-value-123456",
		authorization: "Bearer abcdefghijklmnop",
		message:
			"Basic abcdefghijklmnop token=x ghp_abcdefghijklmnopqrstuv AKIAABCDEFGHIJKLMNOP",
		cookie: "session=secret",
		max_completion_tokens: 4096,
	}, workspaceRoot);

	assert.equal(serialized.includes("secret-value-123456"), false);
	assert.equal(serialized.includes("abcdefghijklmnop"), false);
	assert.equal(serialized.includes("ghp_abcdefghijklmnopqrstuv"), false);
	assert.equal(serialized.includes("AKIAABCDEFGHIJKLMNOP"), false);
	assert.equal(serialized.includes("session=secret"), false);
	assert.match(serialized, /"max_completion_tokens":4096/);
});

test("captured observability values are bounded and tolerate cycles", () => {
	const cyclic: Record<string, unknown> = { content: "x".repeat(40_000) };
	cyclic.self = cyclic;
	const serialized = serializeObservabilityValue(cyclic, workspaceRoot);

	assert.ok(serialized.length < 33_000);
	assert.match(serialized, /\[truncated \d+ chars\]$/);
});

test("processed token usage includes cache traffic", () => {
	const message = assistantMessage("ok");
	message.usage = {
		...message.usage,
		input: 90,
		cacheRead: 57_600,
		cacheWrite: 10,
		output: 256,
		totalTokens: 346,
	};

	assert.deepEqual(summarizeProcessedTokenUsage(message.usage), {
		newInput: 90,
		cacheRead: 57_600,
		cacheWrite: 10,
		output: 256,
		processedTotal: 57_956,
	});
});

test("disabled observability executes a turn exactly once", async () => {
	const observability = createLogosAgentObservability(undefined, workspaceRoot);
	let calls = 0;
	const result = await observability.runTurn("hello", async () => {
		calls += 1;
		return { message: assistantMessage("ok"), outcome: "ok" };
	});

	assert.equal(calls, 1);
	assert.equal(result.message.content[0]?.type, "text");
	await observability.shutdown();
});

interface RecordedStatus {
	code: number;
	message?: string;
}

function createFaultInjectingProvider(options: {
	throwAfterCallback?: boolean;
	forceFlushError?: Error;
	getTracerError?: Error;
} = {}): {
	provider: NodeTracerProvider;
	statuses: RecordedStatus[];
	attributes: Record<string, unknown>;
	shutdownCalls(): number;
} {
	const statuses: RecordedStatus[] = [];
	const attributes: Record<string, unknown> = {};
	let shutdownCount = 0;
	const span = {
		setAttribute: (key: string, value: unknown) => {
			attributes[key] = value;
			return span;
		},
		setAttributes: (values: Record<string, unknown>) => {
			Object.assign(attributes, values);
			return span;
		},
		setStatus: (status: RecordedStatus) => {
			statuses.push(status);
			return span;
		},
		recordException: () => {},
		end: () => {},
	};
	const tracer = {
		startSpan: (_name: string, spanOptions?: unknown) => {
			const optionsRecord = spanOptions as {
				attributes?: Record<string, unknown>;
			};
			Object.assign(attributes, optionsRecord.attributes ?? {});
			return span;
		},
		startActiveSpan: (
			_name: string,
			spanOptions: unknown,
			callback: (activeSpan: typeof span) => Promise<LogosAgentTurnResult>,
		) => {
			const optionsRecord = spanOptions as {
				attributes?: Record<string, unknown>;
			};
			Object.assign(attributes, optionsRecord.attributes ?? {});
			const result = callback(span);
			if (options.throwAfterCallback) throw new Error("telemetry invocation failed");
			return result;
		},
	};
	const provider = {
		getTracer: () => {
			if (options.getTracerError) throw options.getTracerError;
			return tracer;
		},
		forceFlush: async () => {
			if (options.forceFlushError) throw options.forceFlushError;
		},
		shutdown: async () => {
			shutdownCount += 1;
		},
	} as unknown as NodeTracerProvider;
	return { provider, statuses, attributes, shutdownCalls: () => shutdownCount };
}

test("observability adds a durable TaskRun correlation after promotion", async () => {
	const fake = createFaultInjectingProvider();
	const observability = createLogosAgentObservability(
		{ endpoint: "http://collector.invalid" },
		workspaceRoot,
		() => fake.provider,
	);
	await observability.runTurn(
		"hello",
		async () => {
			observability.linkTaskRun("run-1");
			return { message: assistantMessage("ok"), outcome: "ok" };
		},
		{ executionId: "execution-1" },
	);

	assert.equal(fake.attributes["logos_agent.execution_id"], "execution-1");
	assert.equal(fake.attributes["logos_agent.run_id"], "run-1");
	await observability.shutdown();
});

test("enabled observability does not repeat or reject a turn when tracer invocation fails", async () => {
	const fake = createFaultInjectingProvider({ throwAfterCallback: true });
	const observability = createLogosAgentObservability(
		{ endpoint: "http://collector.invalid", captureContent: true },
		workspaceRoot,
		() => fake.provider,
	);
	let calls = 0;
	const originalWarn = console.warn;
	console.warn = () => {};
	let result: LogosAgentTurnResult;
	try {
		result = await observability.runTurn("hello", async () => {
			calls += 1;
			return { message: assistantMessage("ok"), outcome: "ok" };
		});
	} finally {
		console.warn = originalWarn;
	}

	assert.equal(calls, 1);
	assert.equal(result.outcome, "ok");
	await observability.shutdown();
});

test("enabled observability propagates a failed turn exactly once when tracer invocation also fails", async () => {
	const fake = createFaultInjectingProvider({ throwAfterCallback: true });
	const observability = createLogosAgentObservability(
		{ endpoint: "http://collector.invalid" },
		workspaceRoot,
		() => fake.provider,
	);
	let calls = 0;
	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		await assert.rejects(
			observability.runTurn("hello", async () => {
				calls += 1;
				throw new Error("turn failed");
			}),
			/turn failed/,
		);
	} finally {
		console.warn = originalWarn;
	}

	assert.equal(calls, 1);
	await observability.shutdown();
});

test("observability releases a registered provider when tracer initialization fails", async () => {
	const fake = createFaultInjectingProvider({ getTracerError: new Error("tracer failed") });
	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		const observability = createLogosAgentObservability(
			{ endpoint: "http://collector.invalid" },
			workspaceRoot,
			() => fake.provider,
		);
		await Promise.resolve();
		assert.equal(fake.shutdownCalls(), 1);
		await observability.shutdown();
	} finally {
		console.warn = originalWarn;
	}
});

test("enabled observability marks failed completion and always shuts down provider", async () => {
	const fake = createFaultInjectingProvider({ forceFlushError: new Error("flush failed") });
	const observability = createLogosAgentObservability(
		{ endpoint: "http://collector.invalid" },
		workspaceRoot,
		() => fake.provider,
	);
	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		await observability.runTurn("hello", async () => ({
			message: assistantMessage("incomplete"),
			outcome: "error",
		}));
		await observability.shutdown();
	} finally {
		console.warn = originalWarn;
	}

	assert.equal(fake.statuses.some((status) => status.code === SpanStatusCode.ERROR), true);
	assert.equal(fake.shutdownCalls(), 1);
});
