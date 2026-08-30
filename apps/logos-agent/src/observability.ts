import {
	getLLMAttributes,
	MimeType,
	OpenInferenceSpanKind,
	register,
	SemanticConventions,
	SpanStatusCode,
	type NodeTracerProvider,
	type RegisterParams,
	type Tracer,
} from "@arizeai/phoenix-otel";
import type {
	AgentHarness,
	AgentTool,
	PromptTemplate,
	Skill,
} from "../../../packages/agent/src/index.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	redactSensitiveText,
	redactSensitiveValue,
} from "./tool-security.ts";

const MAX_CAPTURED_CONTENT_LENGTH = 32_000;

type ObservabilitySpan = ReturnType<Tracer["startSpan"]>;

export interface LogosAgentObservabilityConfig {
	endpoint?: string;
	projectName?: string;
	captureContent?: boolean;
}

export interface LogosAgentObservability {
	instrument<TTool extends AgentTool>(
		harness: AgentHarness<Skill, PromptTemplate, TTool>,
	): () => void;
	runTurn(
		input: string,
		operation: () => Promise<LogosAgentTurnResult>,
		context?: { executionId?: string },
	): Promise<LogosAgentTurnResult>;
	linkTaskRun(runId: string): void;
	shutdown(): Promise<void>;
}

export interface LogosAgentTurnResult {
	message: AssistantMessage;
	outcome: "ok" | "error" | "aborted";
}

export interface ProcessedTokenUsage {
	newInput: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	processedTotal: number;
}

export function summarizeProcessedTokenUsage(
	usage: AssistantMessage["usage"],
): ProcessedTokenUsage {
	return {
		newInput: usage.input,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		output: usage.output,
		processedTotal:
			usage.input + usage.cacheRead + usage.cacheWrite + usage.output,
	};
}

function bounded(value: string): string {
	if (value.length <= MAX_CAPTURED_CONTENT_LENGTH) return value;
	return `${value.slice(0, MAX_CAPTURED_CONTENT_LENGTH)}\n[truncated ${value.length - MAX_CAPTURED_CONTENT_LENGTH} chars]`;
}

export function serializeObservabilityValue(value: unknown, workspaceRoot: string): string {
	return bounded(serializeUnbounded(value, workspaceRoot));
}

function serializeUnbounded(value: unknown, workspaceRoot: string): string {
	try {
		return JSON.stringify(redactSensitiveValue(value, workspaceRoot)) ?? "null";
	} catch {
		return "[unserializable]";
	}
}

function assistantText(message: AssistantMessage, workspaceRoot: string): string {
	return bounded(
		redactSensitiveText(message.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n"), workspaceRoot),
	);
}

function toolResultText(message: {
	content: Array<{ type: string; text?: string }>;
}, workspaceRoot: string): string {
	return bounded(
		redactSensitiveText(message.content
			.filter((item) => item.type === "text" && typeof item.text === "string")
			.map((item) => item.text ?? "")
			.join("\n"), workspaceRoot),
	);
}

class PhoenixLogosAgentObservability implements LogosAgentObservability {
	private readonly provider: NodeTracerProvider;
	private readonly tracer: Tracer;
	private readonly captureContent: boolean;
	private readonly workspaceRoot: string;
	private activeTurnSpan?: ObservabilitySpan;
	private activeProviderSpan?: ObservabilitySpan;
	private activeTurnTokens?: ProcessedTokenUsage;
	private activeExecutionId?: string;
	private activeRunId?: string;
	private readonly toolSpans = new Map<string, ObservabilitySpan>();
	private warningEmitted = false;

	constructor(
		provider: NodeTracerProvider,
		captureContent: boolean,
		workspaceRoot: string,
	) {
		this.provider = provider;
		this.tracer = provider.getTracer("logos-agent", "0.1.0");
		this.captureContent = captureContent;
		this.workspaceRoot = workspaceRoot;
	}

	instrument<TTool extends AgentTool>(
		harness: AgentHarness<Skill, PromptTemplate, TTool>,
	): () => void {
		const disposeBeforeRequest = harness.on("before_provider_request", (event) => {
			return this.observe(() => {
				this.finishProviderSpan("superseded by next provider request");
				const span = this.tracer.startSpan("logos-agent.provider", {
					attributes: {
						[SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.LLM,
						[SemanticConventions.SESSION_ID]: event.sessionId,
						[SemanticConventions.LLM_PROVIDER]: event.model.provider,
						[SemanticConventions.LLM_SYSTEM]: event.model.api,
						[SemanticConventions.LLM_MODEL_NAME]: event.model.id,
						...(this.activeExecutionId === undefined
							? {}
							: { "logos_agent.execution_id": this.activeExecutionId }),
						...(this.activeRunId === undefined
							? {}
							: { "logos_agent.run_id": this.activeRunId }),
					},
				});
				this.activeProviderSpan = span;
				this.activeTurnSpan?.setAttribute(SemanticConventions.SESSION_ID, event.sessionId);
				return undefined;
			});
		});
		const disposePayload = harness.on("before_provider_payload", (event) => {
			return this.observe(() => {
				const span = this.activeProviderSpan;
				if (!span) return undefined;
				const completePayload = serializeUnbounded(event.payload, this.workspaceRoot);
				const payload = bounded(completePayload);
				span.setAttributes({
					"logos_agent.provider.payload_bytes": Buffer.byteLength(completePayload),
					"logos_agent.provider.payload_truncated": payload.length !== completePayload.length,
				});
				if (this.captureContent) {
					span.setAttributes({
						[SemanticConventions.INPUT_VALUE]: payload,
						[SemanticConventions.INPUT_MIME_TYPE]: MimeType.JSON,
					});
				}
				return undefined;
			});
		});
		const disposeAfterResponse = harness.on("after_provider_response", (event) => {
			return this.observe(() => {
				this.activeProviderSpan?.setAttribute("http.response.status_code", event.status);
				return undefined;
			});
		});
		const unsubscribe = harness.subscribe((event) => {
			this.observe(() => {
				if (event.type === "tool_execution_start") {
					const span = this.tracer.startSpan(`tool.${event.toolName}`, {
						attributes: {
							[SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
							[SemanticConventions.TOOL_NAME]: event.toolName,
							"logos_agent.tool_call_id": event.toolCallId,
							...(this.activeExecutionId === undefined
								? {}
								: { "logos_agent.execution_id": this.activeExecutionId }),
							...(this.activeRunId === undefined
								? {}
								: { "logos_agent.run_id": this.activeRunId }),
							...(this.captureContent
								? {
									[SemanticConventions.INPUT_VALUE]: serializeObservabilityValue(
										event.args,
										this.workspaceRoot,
									),
									[SemanticConventions.INPUT_MIME_TYPE]: MimeType.JSON,
								}
								: {}),
						},
					});
					this.toolSpans.set(event.toolCallId, span);
					return;
				}
				if (event.type === "tool_execution_end") {
					const span = this.toolSpans.get(event.toolCallId);
					if (event.isError) {
						span?.setAttribute("error.type", "tool_error");
						span?.setStatus({ code: SpanStatusCode.ERROR, message: "Tool execution failed" });
					}
					return;
				}
				if (event.type === "message_end" && event.message.role === "assistant") {
					this.completeProviderSpan(event.message);
					return;
				}
				if (event.type === "message_end" && event.message.role === "toolResult") {
					const span = this.toolSpans.get(event.message.toolCallId);
					if (!span) return;
					if (this.captureContent) {
						span.setAttributes({
							[SemanticConventions.OUTPUT_VALUE]: toolResultText(
								event.message,
								this.workspaceRoot,
							),
							[SemanticConventions.OUTPUT_MIME_TYPE]: MimeType.TEXT,
						});
					}
					span.setAttribute("logos_agent.tool.is_error", event.message.isError);
					if (!event.message.isError) span.setStatus({ code: SpanStatusCode.OK });
					span.end();
					this.toolSpans.delete(event.message.toolCallId);
					return;
				}
				if (event.type === "abort" || event.type === "agent_end") {
					this.finishOpenChildSpans(event.type);
				}
			});
		});
		return () => {
			disposeBeforeRequest();
			disposePayload();
			disposeAfterResponse();
			unsubscribe();
			this.observe(() => this.finishOpenChildSpans("harness detached"));
		};
	}

	async runTurn(
		input: string,
		operation: () => Promise<LogosAgentTurnResult>,
		context: { executionId?: string } = {},
	): Promise<LogosAgentTurnResult> {
		let operationPromise: Promise<LogosAgentTurnResult> | undefined;
		let operationFailed = false;
		let operationFailure: unknown;
		try {
			return await this.tracer.startActiveSpan(
				"logos-agent.turn",
				{
					attributes: {
						[SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
						...(context.executionId === undefined
							? {}
							: { "logos_agent.execution_id": context.executionId }),
						...(this.captureContent
							? {
								[SemanticConventions.INPUT_VALUE]: bounded(
									redactSensitiveText(input, this.workspaceRoot),
								),
								[SemanticConventions.INPUT_MIME_TYPE]: MimeType.TEXT,
							}
							: {}),
					},
				},
				(span) => {
					this.activeTurnSpan = span;
					this.activeExecutionId = context.executionId;
					this.activeTurnTokens = {
						newInput: 0,
						cacheRead: 0,
						cacheWrite: 0,
						output: 0,
						processedTotal: 0,
					};
					operationPromise = operation();
					const callbackPromise = (async () => {
						try {
							const result = await operationPromise;
							this.observe(() => {
								if (this.captureContent) {
									span.setAttributes({
										[SemanticConventions.OUTPUT_VALUE]: assistantText(
											result.message,
											this.workspaceRoot,
										),
										[SemanticConventions.OUTPUT_MIME_TYPE]: MimeType.TEXT,
									});
								}
								if (result.outcome !== "ok") {
									span.setStatus({
										code: SpanStatusCode.ERROR,
										message: result.message.errorMessage ?? result.outcome,
									});
								} else {
									span.setStatus({ code: SpanStatusCode.OK });
								}
							});
							return result;
						} catch (error) {
							operationFailed = true;
							operationFailure = error;
							this.observe(() => {
								span.recordException(error instanceof Error ? error : String(error));
								span.setStatus({
									code: SpanStatusCode.ERROR,
									message: error instanceof Error ? error.message : String(error),
								});
							});
							throw error;
						} finally {
							this.observe(() => {
								this.finishOpenChildSpans("turn completed");
								span.end();
							});
							if (this.activeTurnSpan === span) this.activeTurnSpan = undefined;
							if (this.activeExecutionId === context.executionId) {
								this.activeExecutionId = undefined;
							}
							this.activeRunId = undefined;
							this.activeTurnTokens = undefined;
						}
					})();
					void callbackPromise.catch(() => {});
					return callbackPromise;
				},
			);
		} catch (error) {
			if (operationFailed) throw operationFailure;
			if (operationPromise) {
				this.warn(error);
				return await operationPromise;
			}
			this.warn(error);
			try {
				return await operation();
			} finally {
				this.activeRunId = undefined;
			}
		}
	}

	linkTaskRun(runId: string): void {
		this.activeRunId = runId;
		this.observe(() => {
			this.activeTurnSpan?.setAttribute("logos_agent.run_id", runId);
			this.activeProviderSpan?.setAttribute("logos_agent.run_id", runId);
			for (const span of this.toolSpans.values()) {
				span.setAttribute("logos_agent.run_id", runId);
			}
		});
	}

	async shutdown(): Promise<void> {
		this.observe(() => this.finishOpenChildSpans("observability shutdown"));
		try {
			await this.provider.forceFlush();
		} catch (error) {
			this.warn(error);
		}
		try {
			await this.provider.shutdown();
		} catch (error) {
			this.warn(error);
		}
	}

	private observe<TResult>(operation: () => TResult): TResult | undefined {
		try {
			return operation();
		} catch (error) {
			this.warn(error);
			return undefined;
		}
	}

	private warn(error: unknown): void {
		if (this.warningEmitted) return;
		this.warningEmitted = true;
		console.warn(
			`Logos Agent observability error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	private completeProviderSpan(message: AssistantMessage): void {
		const span = this.activeProviderSpan;
		if (!span) return;
		span.setAttributes(
			getLLMAttributes({
				provider: message.provider,
				system: message.api,
				modelName: message.responseModel ?? message.model,
				tokenCount: {
					prompt: message.usage.input,
					completion: message.usage.output,
					total: message.usage.totalTokens,
					promptDetails: {
						cacheRead: message.usage.cacheRead,
						cacheWrite: message.usage.cacheWrite,
					},
				},
				...(this.captureContent
					? {
						outputMessages: [{
							role: "assistant",
							content: assistantText(message, this.workspaceRoot),
						}],
					}
					: {}),
			}),
		);
		const tokens = summarizeProcessedTokenUsage(message.usage);
		span.setAttributes({
			"logos_agent.llm.stop_reason": message.stopReason,
			"logos_agent.llm.cost.total": message.usage.cost.total,
			"logos_agent.llm.tokens.reasoning": message.usage.reasoning ?? 0,
			"logos_agent.llm.tokens.new_input": tokens.newInput,
			"logos_agent.llm.tokens.cache_read": tokens.cacheRead,
			"logos_agent.llm.tokens.cache_write": tokens.cacheWrite,
			"logos_agent.llm.tokens.output": tokens.output,
			"logos_agent.llm.tokens.processed_total": tokens.processedTotal,
		});
		if (this.activeTurnTokens) {
			this.activeTurnTokens.newInput += tokens.newInput;
			this.activeTurnTokens.cacheRead += tokens.cacheRead;
			this.activeTurnTokens.cacheWrite += tokens.cacheWrite;
			this.activeTurnTokens.output += tokens.output;
			this.activeTurnTokens.processedTotal += tokens.processedTotal;
			this.activeTurnSpan?.setAttributes({
				"logos_agent.turn.tokens.new_input": this.activeTurnTokens.newInput,
				"logos_agent.turn.tokens.cache_read": this.activeTurnTokens.cacheRead,
				"logos_agent.turn.tokens.cache_write": this.activeTurnTokens.cacheWrite,
				"logos_agent.turn.tokens.output": this.activeTurnTokens.output,
				"logos_agent.turn.tokens.processed_total": this.activeTurnTokens.processedTotal,
			});
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: message.errorMessage ?? message.stopReason,
			});
		} else {
			span.setStatus({ code: SpanStatusCode.OK });
		}
		span.end();
		this.activeProviderSpan = undefined;
	}

	private finishProviderSpan(message: string): void {
		if (!this.activeProviderSpan) return;
		this.activeProviderSpan.setStatus({ code: SpanStatusCode.ERROR, message });
		this.activeProviderSpan.end();
		this.activeProviderSpan = undefined;
	}

	private finishOpenChildSpans(message: string): void {
		this.finishProviderSpan(message);
		for (const span of this.toolSpans.values()) {
			span.setStatus({ code: SpanStatusCode.ERROR, message });
			span.end();
		}
		this.toolSpans.clear();
	}
}

const disabledObservability: LogosAgentObservability = {
	instrument: () => () => {},
	runTurn: async (_input, operation, _context) => await operation(),
	linkTaskRun: () => {},
	shutdown: async () => {},
};

export function createLogosAgentObservability(
	config: LogosAgentObservabilityConfig | undefined,
	workspaceRoot: string,
	registerProvider: (params: RegisterParams) => NodeTracerProvider = register,
): LogosAgentObservability {
	const endpoint = config?.endpoint?.trim();
	if (!endpoint) return disabledObservability;
	let provider: NodeTracerProvider | undefined;
	try {
		provider = registerProvider({
			url: endpoint,
			projectName: config?.projectName?.trim() || "logos-agent",
			batch: true,
			global: true,
		});
		return new PhoenixLogosAgentObservability(
			provider,
			config?.captureContent ?? false,
			workspaceRoot,
		);
	} catch (error) {
		if (provider) {
			void provider.shutdown().catch((shutdownError: unknown) => {
				console.warn(
					`Logos Agent observability cleanup error: ${shutdownError instanceof Error ? shutdownError.message : String(shutdownError)}`,
				);
			});
		}
		console.warn(
			`Logos Agent observability disabled: ${error instanceof Error ? error.message : String(error)}`,
		);
		return disabledObservability;
	}
}
