import { mkdir } from "node:fs/promises";
import { join } from "node:path";
// The globally linked bin runs this TypeScript file directly with Node. Import the
// workspace source explicitly so runtime behavior cannot lag behind an unbuilt dist/.
import {
	AgentHarness,
	type AgentHarnessEvent,
	type AgentMessage,
	estimateContextTokens,
	JsonlSessionRepo,
	type JsonlSessionMetadata,
	type PromptTemplate,
	type Session,
	type SessionTreeEntry,
	type Skill,
	type ThinkingLevel,
} from "../../../packages/agent/src/index.ts";
import { NodeExecutionEnv } from "../../../packages/agent/src/node.ts";
import {
	type AssistantMessage,
	createModels,
	type Model,
	type Models,
	type TextContent,
	type ThinkingContent,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
	type UserQuestion,
	type UserQuestionAction,
	UserQuestionCoordinator,
	type UserQuestionRequest,
	type UserQuestionResolution,
	type UserQuestionResponse,
} from "./ask-user-tool.ts";
import {
	type CodeIntelligenceProvider,
	createCodeGraphProvider,
	createCodeGraphSyncCoordinator,
	createCodeGraphWorkspaceManager,
	createNodeCodeGraphCommandRunner,
	type CodeGraphSyncCoordinator,
	type CodeGraphWorkspaceManager,
	type CodeGraphWorkspaceOperationResult,
	type CodeGraphWorkspaceStatus,
} from "./code-intelligence.ts";
import { codeAgentSystemPrompt } from "./code-agent-prompt.ts";
import {
	buildCacheOperationsReport,
	CACHE_OBSERVATION_CUSTOM_TYPE,
	type CacheObservationEnvironment,
	CacheObservationTracker,
	cacheStructureHash,
	cacheTelemetryAvailable,
	collectCacheObservations,
	compareCacheReleases,
	type CacheOperationsReport,
	type CacheReleaseComparison,
	computeCacheStats,
	type LogosAgentCacheStats,
} from "./cache-stats.ts";
import {
	createControlledEditManager,
	createNodeControlledEditOperations,
} from "./controlled-edit-tools.ts";
import {
	createNodeControlledCommandManager,
	type ControlledCommandManager,
} from "./controlled-command-tools.ts";
import {
	createNodeWorkspaceDirectoryOperations,
} from "./directory-tools.ts";
import { ApprovalCoordinator, type ApprovalRequest } from "./edit-approval.ts";
import {
	createNodeWorkspaceInfoOperations,
} from "./workspace-info.ts";
import {
	createNodeReadOnlyWorkspaceOperations,
} from "./read-only-tools.ts";
import {
	createNodeGitOperations,
} from "./git-tools.ts";
import {
	createNodeRunTaskOperations,
} from "./run-task-tool.ts";
import {
	type ToolAuditRecord,
} from "./tool-security.ts";
import {
	createGenericLogosApprovalSubject,
	createLogosToolDescriptors,
	governLogosApprovalSubject,
	type LogosApprovalSubject,
	type LogosTool,
} from "./logos-tools.ts";
import {
	InMemoryToolPermissionStore,
	ToolSystem,
	type ToolCapabilityKind,
	type ToolPermission,
	type ToolPolicyInfo,
} from "./tool-system.ts";
import {
	buildBaseSystemPrompt,
	loadWorkspaceInstructions,
} from "./workspace-instructions.ts";
import { createConfiguredWebSearchOperations } from "./web-search-tool.ts";
import { SessionTaskRunJournal } from "./session-task-run-journal.ts";
import {
	previewAssurance,
	TaskRunController,
	type TaskRunAssurance,
	type TaskRunEvidence,
	type TaskRunManifest,
	type TaskRunState,
	type TaskRunUpdate,
} from "./task-run.ts";
import {
	type CompletionContinuationReason,
	isInternalContinuationPrompt,
	isSuccessfulTaskCompletionResult,
	runTaskCompletionLoop,
	TaskCompletionTracker,
	taskCompletionToolName,
	turnCompletionContinuationPrompt,
	turnLengthContinuationPrompt,
} from "./task-completion-tool.ts";
import {
	type ReflectionGuidanceInput,
	type ReflectionGuidanceSummary,
	TaskDeliberationController,
} from "./task-deliberation-tool.ts";
import {
	isNormalTurnComplete,
	TurnTaskLifecycle,
} from "./turn-task-lifecycle.ts";
import {
	createContextManager,
	summarizeContextSnapshot,
	type ContextSnapshotSummary,
} from "./context-manager.ts";
import {
	createLogosAgentObservability,
	type LogosAgentObservability,
	type LogosAgentObservabilityConfig,
	type LogosAgentTurnResult,
} from "./observability.ts";

export type LogosAgentEvent =
	| AgentHarnessEvent
	| { type: "audit"; record: ToolAuditRecord }
	| { type: "context_snapshot"; snapshot: ContextSnapshotSummary }
	| { type: "cache_observation_error"; message: string }
	| {
			type: "task_completion_retry";
			attempt: number;
			maxAttempts: number;
			reason: "completion" | "length";
			mode: "turn" | "task";
		  }
	| { type: "task_run_update"; run: TaskRunState };
export type { LogosApprovalSubject } from "./logos-tools.ts";
export type LogosApprovalOutcome = "approved" | "rejected" | "failed";
export type LogosAgentUiEvent =
	| LogosAgentEvent
	| { type: "approval_request"; request: ApprovalRequest<LogosApprovalSubject> }
	| {
			type: "approval_resolved";
			requestId: string;
			subjectKind: LogosApprovalSubject["kind"];
			outcome: LogosApprovalOutcome;
	  }
	| { type: "question_request"; request: UserQuestionRequest }
	| {
			type: "question_resolved";
			requestId: string;
			outcome: UserQuestionResolution["kind"] | "cancel";
	  };
type LogosHarness = AgentHarness<Skill, PromptTemplate, LogosTool>;
type TaskRunEvidenceInput = Omit<TaskRunEvidence, "id" | "recordedAt">;
interface PendingTaskRunEvidence {
	controller: TaskRunController;
	evidence: TaskRunEvidenceInput;
	idempotencyKey?: string;
}
interface LogosRuntime {
	harness: LogosHarness;
	toolSystem: ToolSystem<LogosTool, LogosApprovalSubject>;
	taskDeliberation: TaskDeliberationController;
	cacheTracker: CacheObservationTracker;
	taskRuns: TaskRunController;
	codeGraph: CodeGraphWorkspaceManager;
	codeGraphSync: CodeGraphSyncCoordinator;
	codeIntelligenceProvider: CodeIntelligenceProvider;
	createTaskRunManifest(): TaskRunManifest;
}

async function loadSystemPromptBase(
	env: NodeExecutionEnv,
	workspaceRoot: string,
): Promise<string> {
	const workspaceInstructions = await loadWorkspaceInstructions(env, workspaceRoot);
	if (workspaceInstructions.warning) {
		console.warn(`Logos Agent: ${workspaceInstructions.warning}`);
	}
	return buildBaseSystemPrompt(codeAgentSystemPrompt, workspaceInstructions.content);
}

export interface LogosAgentSessionInfo {
	id: string;
	path: string;
	messageCount: number;
}

export interface LogosAgentSessionListItem {
	id: string;
	path: string;
	messageCount: number;
	createdAt: string;
	preview: string;
}

export interface LogosAgentCompactResult {
	status: "completed" | "cancelled" | "not_needed";
	summary?: string;
	tokensBefore: number;
	tokensAfter: number;
	tokensSaved: number;
	restoreAvailable: boolean;
}

export interface LogosAgentContextInfo {
	tokenCount: number;
	contextWindow: number;
	percent: number;
}

export interface LogosAgent {
	prompt(text: string): Promise<AssistantMessage>;
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	shutdown(): Promise<void>;
	waitForIdle(): Promise<void>;
	isBusy(): boolean;
	subscribe(listener: (event: LogosAgentUiEvent) => void | Promise<void>): () => void;
	respondToApproval(requestId: string, approved: boolean): boolean;
	respondToQuestion(requestId: string, action: UserQuestionAction): UserQuestionResponse;
	getMessages(): Promise<AgentMessage[]>;
	getSessionInfo(): Promise<LogosAgentSessionInfo>;
	newSession(): Promise<LogosAgentSessionInfo>;
	getModelId(): string;
	getWorkspaceRoot(): string;
	getCodeGraphStatus(): Promise<CodeGraphWorkspaceStatus>;
	initializeCodeGraph(): Promise<CodeGraphWorkspaceOperationResult>;
	syncCodeGraph(): Promise<CodeGraphWorkspaceOperationResult>;
	listSessions(): Promise<LogosAgentSessionListItem[]>;
	switchSession(id: string): Promise<LogosAgentSessionInfo>;
	compact(options?: { force?: boolean }): Promise<LogosAgentCompactResult>;
	restoreLastCompaction(): Promise<LogosAgentContextInfo>;
	getContextInfo(): Promise<LogosAgentContextInfo>;
	getCacheStats(): Promise<LogosAgentCacheStats>;
	getCacheReport(release?: string): Promise<CacheOperationsReport>;
	compareCacheReleases(
		baselineRelease: string,
		currentRelease?: string,
	): Promise<CacheReleaseComparison>;
	getCacheRelease(): string;
	getActiveTaskRunId(): string | undefined;
	getTaskRun(id: string): Promise<TaskRunState>;
	listTaskRuns(): Promise<TaskRunState[]>;
	getToolPolicies(): ToolPolicyInfo[];
	setToolPermission(toolName: string, permission: ToolPermission | undefined): Promise<void>;
	setCapabilityPermission(
		capability: ToolCapabilityKind,
		permission: ToolPermission | undefined,
	): Promise<void>;
}

export interface LogosAgentConfig {
	workspaceRoot: string;
	validationRoot: string;
	sessionsRoot: string;
	provider: "openai" | "anthropic" | "deepseek";
	modelId: string;
	thinkingLevel?: ThinkingLevel;
	tavilyApiKey?: string;
	cacheEnvironment: CacheObservationEnvironment;
	observability?: LogosAgentObservabilityConfig;
}

export function shouldRunManualCompaction(
	context: LogosAgentContextInfo,
	force: boolean,
): boolean {
	return force || (context.contextWindow > 0 && context.tokenCount / context.contextWindow >= 0.7);
}

export function resolveLogosThinkingLevel(
	supportsReasoning: boolean,
	configured?: ThinkingLevel,
): ThinkingLevel {
	return configured ?? (supportsReasoning ? "high" : "off");
}

export interface DirectoryMutationEvidence {
	paths: string[];
	changed: string[];
	partialFailure: boolean;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isReflectionGuidanceSummary(
	value: unknown,
): value is ReflectionGuidanceSummary {
	if (typeof value !== "object" || value === null) return false;
	const summary = value as Record<string, unknown>;
	return (
		typeof summary.changeSites === "number" &&
		isStringArray(summary.changedPaths) &&
		(summary.verification === "none" ||
			summary.verification === "passed" ||
			summary.verification === "failed") &&
		isStringArray(summary.discrepancies)
	);
}

export function describeDirectoryMutationEvidence(
	details: unknown,
	isError: boolean,
): DirectoryMutationEvidence | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const detail = details as Record<string, unknown>;
	const completed = detail.stage === "completed" && !isError;
	const partialFailure = detail.stage === "failed" && isError;
	if (!completed && !partialFailure) return undefined;
	const changed = partialFailure ? detail.preserved : detail.created;
	if (
		!isStringArray(detail.paths) ||
		!isStringArray(changed) ||
		changed.length === 0
	) {
		return undefined;
	}
	return {
		paths: [...detail.paths],
		changed: [...changed],
		partialFailure,
	};
}

function createModel(config: LogosAgentConfig): { models: Models; model: Model<any> } {
	const models = createModels();
	const provider =
		config.provider === "openai"
			? openaiProvider()
			: config.provider === "anthropic"
				? anthropicProvider()
				: deepseekProvider();
	models.setProvider(provider);
	const model = models.getModel(config.provider, config.modelId);
	if (!model) throw new Error(`Unknown model: ${config.provider}/${config.modelId}`);
	return { models, model };
}

function assertCredentials(provider: LogosAgentConfig["provider"]): void {
	if (provider === "openai" && !process.env.OPENAI_API_KEY) {
		throw new Error("OPENAI_API_KEY is required for the OpenAI provider");
	}
	if (provider === "anthropic" && !process.env.ANTHROPIC_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
		throw new Error("ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY is required for the Anthropic provider");
	}
	if (provider === "deepseek" && !process.env.DEEPSEEK_API_KEY) {
		throw new Error("DEEPSEEK_API_KEY is required for the DeepSeek provider");
	}
}

export class HarnessLogosAgent implements LogosAgent {
	private readonly config: LogosAgentConfig;
	private readonly env: NodeExecutionEnv;
	private readonly repo: JsonlSessionRepo;
	private readonly models: Models;
	private readonly model: Model<any>;
	private harness: LogosHarness;
	private session: Session<JsonlSessionMetadata>;
	private busy = false;
	private transitioning = false;
	private transitionPromise?: Promise<void>;
	private readonly approval = new ApprovalCoordinator<LogosApprovalSubject>();
	private readonly questions = new UserQuestionCoordinator();
	private readonly toolPermissions = new InMemoryToolPermissionStore();
	private readonly commandManager: ControlledCommandManager;
	private toolSystem: ToolSystem<LogosTool, LogosApprovalSubject>;
	private taskDeliberation: TaskDeliberationController;
	private cacheTracker: CacheObservationTracker;
	private taskRuns: TaskRunController;
	private codeGraph: CodeGraphWorkspaceManager;
	private codeGraphSync: CodeGraphSyncCoordinator;
	private codeIntelligenceProvider: CodeIntelligenceProvider;
	private createTaskRunManifest: () => TaskRunManifest;
	private activeTaskRunId?: string;
	private readonly turnTaskLifecycle = new TurnTaskLifecycle();
	private pendingTaskRunEvidence: PendingTaskRunEvidence[] = [];
	private taskPromotionPromise?: Promise<TaskRunState>;
	private abortRequestedTaskRunId?: string;
	private taskAbortController?: AbortController;
	private promptLifecyclePromise?: Promise<void>;
	private codeGraphAbortController?: AbortController;
	private readonly taskCompletion = new TaskCompletionTracker();
	private compactionAbortController?: AbortController;
	private compactionCommitStarted = false;
	private listeners = new Set<(event: LogosAgentUiEvent) => void | Promise<void>>();
	private unsubscribeHarness: () => void = () => {};
	private observability: LogosAgentObservability;
	private uninstrumentHarness: () => void = () => {};
	private shutdownPromise?: Promise<void>;

	private constructor(
		config: LogosAgentConfig,
		env: NodeExecutionEnv,
		repo: JsonlSessionRepo,
		models: Models,
		model: Model<any>,
		session: Session<JsonlSessionMetadata>,
		systemPromptBase: string,
	) {
		this.config = config;
		this.env = env;
		this.repo = repo;
		this.models = models;
		this.model = model;
		this.session = session;
		this.observability = createLogosAgentObservability(undefined, config.workspaceRoot);
		this.commandManager = createNodeControlledCommandManager(
			config.workspaceRoot,
			config.validationRoot,
		);
		const runtime = this.buildRuntime(session, systemPromptBase);
		this.harness = runtime.harness;
		this.toolSystem = runtime.toolSystem;
		this.taskDeliberation = runtime.taskDeliberation;
		this.cacheTracker = runtime.cacheTracker;
		this.taskRuns = runtime.taskRuns;
		this.codeGraph = runtime.codeGraph;
		this.codeGraphSync = runtime.codeGraphSync;
		this.codeIntelligenceProvider = runtime.codeIntelligenceProvider;
		this.createTaskRunManifest = runtime.createTaskRunManifest;
	}

	static async create(config: LogosAgentConfig): Promise<HarnessLogosAgent> {
		assertCredentials(config.provider);
		const { models, model } = createModel(config);
		await mkdir(config.sessionsRoot, { recursive: true });
		const env = new NodeExecutionEnv({ cwd: config.workspaceRoot });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: config.sessionsRoot });
		const sessions = await repo.list({ cwd: config.workspaceRoot });
		const session = sessions[0] ? await repo.open(sessions[0]) : await repo.create({ cwd: config.workspaceRoot });
		const systemPromptBase = await loadSystemPromptBase(env, config.workspaceRoot);
		const agent = new HarnessLogosAgent(
			config,
			env,
			repo,
			models,
			model,
			session,
			systemPromptBase,
		);
		try {
			agent.enableObservability();
			await agent.hydrateCacheTracker();
			agent.attachHarness();
			return agent;
		} catch (error) {
			try {
				await agent.shutdown();
			} catch (cleanupError) {
				throw new AggregateError(
					[
						error instanceof Error ? error : new Error(String(error)),
						cleanupError instanceof Error
							? cleanupError
							: new Error(String(cleanupError)),
					],
					"Logos Agent initialization and cleanup failed",
				);
			}
			throw error;
		}
	}

	private enableObservability(): void {
		this.observability = createLogosAgentObservability(
			this.config.observability,
			this.config.workspaceRoot,
		);
		this.uninstrumentHarness = this.observability.instrument(this.harness);
	}

	private buildRuntime(
		session: Session<JsonlSessionMetadata>,
		systemPromptBase: string,
	): LogosRuntime {
		const taskRuns = new TaskRunController({
			journal: new SessionTaskRunJournal(session),
		});
		const readOperations = createNodeReadOnlyWorkspaceOperations(this.config.workspaceRoot);
		const codeGraphRunner = createNodeCodeGraphCommandRunner(
			this.config.workspaceRoot,
		);
		const codeIntelligenceProvider = createCodeGraphProvider(
			this.config.workspaceRoot,
			codeGraphRunner,
		);
		const codeGraph = createCodeGraphWorkspaceManager(
			this.config.workspaceRoot,
			codeGraphRunner,
		);
		const codeGraphSync = createCodeGraphSyncCoordinator(
			codeGraph,
			codeIntelligenceProvider,
			(error) => console.warn(`Logos Agent: automatic CodeGraph sync failed: ${error.message}`),
		);
		const gitOperations = createNodeGitOperations(this.config.workspaceRoot);
		const runTaskOperations = createNodeRunTaskOperations(this.config.validationRoot);
		const webSearchOperations = createConfiguredWebSearchOperations({
			tavilyApiKey: this.config.tavilyApiKey,
		});
		const editManager = createControlledEditManager({
			operations: createNodeControlledEditOperations(this.config.workspaceRoot),
		});
		const taskDeliberation = new TaskDeliberationController();
		const loadReflectionGuidance =
			async (): Promise<ReflectionGuidanceInput | undefined> => {
				const runId = this.activeTaskRunId;
				let run: TaskRunState | undefined;
				if (runId !== undefined) {
					try {
						run = await taskRuns.get(runId);
					} catch {
						run = undefined;
					}
				}
				const goal = this.turnTaskLifecycle.getGoal();
				if (goal === undefined && run === undefined) return undefined;
				return {
					...(goal === undefined ? {} : { goal }),
					...(run === undefined ? {} : { run }),
				};
			};
		const loadFinishTaskAssurance =
			async (): Promise<TaskRunAssurance | undefined> => {
				const runId = this.activeTaskRunId;
				if (runId === undefined) return undefined;
				try {
					const run = await taskRuns.get(runId);
					return run.status === "active" ? previewAssurance(run) : run.assurance;
				} catch {
					return undefined;
				}
			};
		const toolSystem = new ToolSystem<LogosTool, LogosApprovalSubject>({
			workspaceRoot: this.config.workspaceRoot,
			permissionStore: this.toolPermissions,
			requestApproval: async (subject) => await this.requestApproval(subject),
			createGenericApprovalSubject: createGenericLogosApprovalSubject,
			governApprovalSubject: (subject) =>
				governLogosApprovalSubject(subject, this.config.workspaceRoot),
			recordAudit: async (record) => {
				const entryId = await session.appendCustomEntry("tool_audit", record);
				await this.recordTaskRunEvidence(taskRuns, {
					kind:
						record.phase === "decision"
							? "tool_decision"
							: "tool_result",
					sourceId: record.toolCallId,
					outcome:
						record.phase === "decision"
							? record.decision === "allowed"
								? "allowed"
								: "blocked"
							: record.outcome === "completed"
								? "completed"
								: "failed",
					metadata: {
						entryId,
						toolName: record.toolName,
						...(record.phase === "decision" && record.approval !== undefined
							? { approval: record.approval }
							: {}),
						...(record.phase === "decision" && record.reason !== undefined
							? { reason: record.reason }
							: {}),
					},
				});
				await this.emit({ type: "audit", record });
			},
		});
		for (const descriptor of createLogosToolDescriptors({
			workspaceRoot: this.config.workspaceRoot,
			taskDeliberation,
			reflectionGuidance: loadReflectionGuidance,
			finishTaskAssurance: loadFinishTaskAssurance,
			userQuestionOperations: {
				ask: async (question, signal) =>
					await this.requestUserQuestion(question, signal),
			},
			workspaceInfoOperations: createNodeWorkspaceInfoOperations(this.config.workspaceRoot),
			readOperations,
			codeIntelligenceProvider,
			gitOperations,
			runTaskOperations,
			editManager,
			directoryOperations: createNodeWorkspaceDirectoryOperations(
				this.config.workspaceRoot,
			),
			commandManager: this.commandManager,
			webSearchOperations,
		})) {
			toolSystem.register(descriptor);
		}
		const contextManager = createContextManager({
			compactableToolNames: toolSystem.getCompactableToolNames(),
			compactAfterUseToolNames: toolSystem.getCompactAfterUseToolNames(),
		});
		const buildSystemPrompt = () => toolSystem.buildSystemPrompt(systemPromptBase);
		const toolsHash = () =>
			cacheStructureHash(
				toolSystem.getTools().map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
			);
		const createTaskRunManifest = (): TaskRunManifest => ({
			release: this.config.cacheEnvironment.release,
			appVersion: this.config.cacheEnvironment.appVersion,
			...(this.config.cacheEnvironment.commit === undefined
				? {}
				: { commit: this.config.cacheEnvironment.commit }),
			features: [
				...new Set([
					...this.config.cacheEnvironment.features,
					"code-intelligence",
					"task-run",
					"controlled-command",
					"deliberation",
					"provider-reasoning",
					"web-search",
					"user-question",
				]),
			].sort(),
			model: {
				api: this.model.api,
				provider: this.model.provider,
				id: this.model.id,
			},
			systemPromptHash: cacheStructureHash(buildSystemPrompt()),
			toolsHash: toolsHash(),
			policyHash: cacheStructureHash(toolSystem.getPermissionSnapshot()),
			workspaceHash: cacheStructureHash(this.config.workspaceRoot),
			budget: {
				maxDurationMs: 10 * 60_000,
				maxProviderRequests: 100,
				maxToolCalls: 200,
			},
		});
		const cacheTracker = new CacheObservationTracker(this.config.cacheEnvironment);
		const harness = new AgentHarness<Skill, PromptTemplate, LogosTool>({
			env: this.env,
			session,
			models: this.models,
			model: this.model,
			tools: toolSystem.getTools(),
			systemPrompt: buildSystemPrompt,
			thinkingLevel: resolveLogosThinkingLevel(
				this.model.reasoning,
				this.config.thinkingLevel,
			),
		});
		harness.on("context", async (event) => {
			const snapshot = contextManager.prepare(event.messages);
			await this.emit({
				type: "context_snapshot",
				snapshot: summarizeContextSnapshot(snapshot),
			});
			return {
				messages: snapshot.messages,
			};
		});
		harness.on("tool_call", async (event) => {
			const capabilities = toolSystem.getToolCapabilities(event.toolName);
			if (capabilities) {
				this.turnTaskLifecycle.observeToolCapabilities(capabilities);
				if (
					this.turnTaskLifecycle.isTask() &&
					this.activeTaskRunId === undefined
				) {
					await this.promoteActiveTurnToTask(taskRuns);
				}
			}
			this.taskCompletion.observeToolCall();
			return await toolSystem.onToolCall(event);
		});
		harness.on("tool_result", async (event) => {
			const capabilities = toolSystem.getToolCapabilities(event.toolName);
			if (capabilities) taskDeliberation.afterToolResult(capabilities);
			if (
				event.toolName === "apply_edit" &&
				!event.isError &&
				typeof event.details === "object" &&
				event.details !== null &&
				(event.details as Record<string, unknown>).stage === "completed"
			) {
				codeGraphSync.schedule();
			}
			const patch = await toolSystem.onToolResult(event);
			const details = patch?.details ?? event.details;
			const isError = patch?.isError ?? event.isError;
			const completionRecorded = isSuccessfulTaskCompletionResult(
				event.toolName,
				isError,
				details,
			);
			await this.recordSemanticToolEvidence(
				taskRuns,
				event.toolCallId,
				event.toolName,
				details,
				isError,
			);
			this.taskCompletion.observeToolResult(event.toolCallId, completionRecorded);
			return patch;
		});
		harness.on("before_provider_request", async (event) => {
			cacheTracker.beginRequest({
				sessionId: event.sessionId,
				runId: this.activeTaskRunId,
				api: event.model.api,
				provider: event.model.provider,
				model: event.model.id,
				telemetryAvailable: cacheTelemetryAvailable(event.model.api),
				systemPromptHash: cacheStructureHash(buildSystemPrompt()),
				toolsHash: toolsHash(),
				cacheRetention: event.streamOptions.cacheRetention,
				startedAt: Date.now(),
			});
			await this.recordTaskRunEvidence(taskRuns, {
				kind: "provider_request",
				sourceId: `${event.sessionId}:${Date.now()}`,
				outcome: "started",
				metadata: {
					api: event.model.api,
					provider: event.model.provider,
					model: event.model.id,
					codeContextMode: "model-visible-tools",
				},
			});
			return undefined;
		});
		return {
			harness,
			toolSystem,
			taskDeliberation,
			cacheTracker,
			taskRuns,
			codeGraph,
			codeGraphSync,
			codeIntelligenceProvider,
			createTaskRunManifest,
		};
	}

	private attachHarness(): void {
		this.unsubscribeHarness();
		this.unsubscribeHarness = this.harness.subscribe(async (event) => {
			if (event.type === "message_start" && event.message.role === "user") {
				const text = getMessageText(event.message);
				if (
					this.taskCompletion.hasPendingExternalInput() ||
					!isInternalContinuationPrompt(text)
				) {
					this.taskCompletion.observeExternalInput();
				}
			}
			if (event.type === "compaction_update" && event.phase === "committing") {
				this.compactionCommitStarted = true;
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				this.taskCompletion.observeAssistantMessage(event.message);
				const observation = this.cacheTracker.completeRequest(event.message);
				if (observation) {
					try {
						const entryId = await this.session.appendCustomEntry(
							CACHE_OBSERVATION_CUSTOM_TYPE,
							observation,
						);
						await this.recordTaskRunEvidence(
							this.taskRuns,
							{
								kind: "cache",
								sourceId: entryId,
								outcome: "completed",
								metadata: {
									cacheReadTokens: observation.usage.cacheRead,
									cacheWriteTokens: observation.usage.cacheWrite,
									inputTokens: observation.usage.input,
								},
							},
							{
								runId: observation.runId,
								idempotencyKey: `cache:${entryId}`,
							},
						);
					} catch (error) {
						await this.emit({
							type: "cache_observation_error",
							message: error instanceof Error ? error.message : String(error),
						});
					}
				}
			}
			if (
				event.type === "tool_execution_update" &&
				event.toolName === "create_directories" &&
				typeof event.partialResult.details === "object" &&
				event.partialResult.details !== null &&
				(event.partialResult.details as Record<string, unknown>).stage ===
					"failed"
			) {
				await this.recordSemanticToolEvidence(
					this.taskRuns,
					event.toolCallId,
					event.toolName,
					event.partialResult.details,
					true,
				);
			}
			await this.emit(event);
		});
	}

	private async hydrateCacheTracker(): Promise<void> {
		this.cacheTracker.hydrate(
			collectCacheObservations(await this.session.getEntries()),
		);
	}

	private async promoteActiveTurnToTask(
		controller: TaskRunController,
	): Promise<TaskRunState> {
		if (this.activeTaskRunId !== undefined) {
			return await controller.get(this.activeTaskRunId);
		}
		if (this.taskPromotionPromise) return await this.taskPromotionPromise;
		const goal = this.turnTaskLifecycle.getGoal();
		if (!goal || !this.turnTaskLifecycle.isTask()) {
			throw new Error("No active execution task is available for promotion");
		}
		const promotion = (async () => {
			const session = await this.session.getMetadata();
			const run = await controller.start({
				sessionId: session.id,
				goal,
				manifest: this.createTaskRunManifest(),
			});
			this.activeTaskRunId = run.id;
			await this.emit({ type: "task_run_update", run });
			const buffered = this.pendingTaskRunEvidence;
			this.pendingTaskRunEvidence = [];
			for (const pending of buffered) {
				if (pending.controller !== controller) continue;
				await this.recordTaskRunEvidence(
					controller,
					pending.evidence,
					{
						runId: run.id,
						...(pending.idempotencyKey === undefined
							? {}
							: { idempotencyKey: pending.idempotencyKey }),
					},
				);
			}
			return await controller.get(run.id);
		})();
		this.taskPromotionPromise = promotion;
		try {
			return await promotion;
		} finally {
			if (this.taskPromotionPromise === promotion) {
				this.taskPromotionPromise = undefined;
			}
		}
	}

	private async applyTaskRunUpdate(
		controller: TaskRunController,
		runId: string,
		update: TaskRunUpdate,
		options: { idempotencyKey?: string } = {},
	): Promise<TaskRunState> {
		const run = await controller.apply(runId, update, options);
		await this.emit({ type: "task_run_update", run });
		return run;
	}

	private async recordTaskRunEvidence(
		controller: TaskRunController,
		evidence: TaskRunEvidenceInput,
		options: { runId?: string; idempotencyKey?: string } = {},
	): Promise<TaskRunState | undefined> {
		const runId = options.runId ?? this.activeTaskRunId;
		if (runId === undefined) {
			if (this.turnTaskLifecycle.getGoal() !== undefined) {
				this.pendingTaskRunEvidence.push({
					controller,
					evidence: structuredClone(evidence),
					...(options.idempotencyKey === undefined
						? {}
						: { idempotencyKey: options.idempotencyKey }),
				});
			}
			return undefined;
		}
		const current = await controller.get(runId);
		if (current.status === "terminal") return current;
		return await this.applyTaskRunUpdate(
			controller,
			runId,
			{ type: "evidence", evidence },
			options.idempotencyKey === undefined
				? {}
				: { idempotencyKey: options.idempotencyKey },
		);
	}

	private async recordSemanticToolEvidence(
		controller: TaskRunController,
		toolCallId: string,
		toolName: string,
		details: unknown,
		isError: boolean,
	): Promise<void> {
		const runId = this.activeTaskRunId;
		if (runId === undefined || typeof details !== "object" || details === null) return;
		const detail = details as Record<string, unknown>;
		if (toolName === "web_search" && detail.stage === "completed" && !isError) {
			await this.recordTaskRunEvidence(
				controller,
				{
					kind: "network_search",
					sourceId: toolCallId,
					outcome: "completed",
					metadata: {
						provider: detail.provider,
						resultCount: detail.resultCount,
					},
				},
				{ runId, idempotencyKey: `network-search:${toolCallId}` },
			);
			return;
		}
		if (toolName === "apply_edit" && detail.stage === "completed" && !isError) {
			let run = await controller.get(runId);
			if (run.status !== "active") return;
			if (run.phase !== "execute") {
				run = await this.applyTaskRunUpdate(
					controller,
					runId,
					{ type: "phase", phase: "execute" },
					{ idempotencyKey: `phase:execute:${toolCallId}` },
				);
			}
			const subjectFingerprint = cacheStructureHash({
				previous: run.currentSubjectFingerprint,
				path: detail.path,
				previousHash: detail.previousHash,
				newHash: detail.newHash,
			});
			await this.recordTaskRunEvidence(
				controller,
				{
					kind: "change",
					sourceId: toolCallId,
					outcome: "completed",
					subjectFingerprint,
					metadata: {
						toolName,
						paths: typeof detail.path === "string" ? [detail.path] : [],
					},
				},
				{ runId, idempotencyKey: `change:${toolCallId}` },
			);
			return;
		}
		const directoryMutation =
			toolName === "create_directories"
				? describeDirectoryMutationEvidence(detail, isError)
				: undefined;
		if (directoryMutation) {
			let run = await controller.get(runId);
			if (run.status !== "active") return;
			if (run.phase !== "execute") {
				run = await this.applyTaskRunUpdate(
					controller,
					runId,
					{ type: "phase", phase: "execute" },
					{ idempotencyKey: `phase:execute:${toolCallId}` },
				);
			}
			const subjectFingerprint = cacheStructureHash({
				previous: run.currentSubjectFingerprint,
				paths: directoryMutation.paths,
				created: directoryMutation.changed,
			});
			await this.recordTaskRunEvidence(
				controller,
				{
					kind: "change",
					sourceId: toolCallId,
					outcome: "completed",
					subjectFingerprint,
					metadata: {
						toolName,
						partialFailure: directoryMutation.partialFailure,
						paths: directoryMutation.changed,
					},
				},
				{ runId, idempotencyKey: `change:${toolCallId}` },
			);
			return;
		}
		if (toolName === "reflect_task" && !isError) {
			const guidance = detail.guidance;
			await this.recordTaskRunEvidence(
				controller,
				{
					kind: "tool_result",
					sourceId: toolCallId,
					outcome: "completed",
					metadata: {
						toolName,
						decision: detail.decision,
						...(isReflectionGuidanceSummary(guidance)
							? { guidance: { ...guidance } }
							: {}),
					},
				},
				{ runId, idempotencyKey: `reflection:${toolCallId}` },
			);
			return;
		}
		if (toolName !== "run_task" || detail.stage !== "completed") return;
		let run = await controller.get(runId);
		if (run.status !== "active") return;
		if (run.phase !== "verify") {
			run = await this.applyTaskRunUpdate(
				controller,
				runId,
				{ type: "phase", phase: "verify" },
				{ idempotencyKey: `phase:verify:${toolCallId}` },
			);
		}
		const exitCode = typeof detail.exitCode === "number" ? detail.exitCode : undefined;
		await this.recordTaskRunEvidence(
			controller,
			{
				kind: "verification",
				sourceId: toolCallId,
				outcome: !isError && exitCode === 0 ? "passed" : "failed",
				...(run.currentSubjectFingerprint === undefined
					? {}
					: { subjectFingerprint: run.currentSubjectFingerprint }),
				metadata: {
					toolName,
					task: detail.task,
					exitCode,
				},
			},
			{ runId, idempotencyKey: `verification:${toolCallId}` },
		);
	}

	private async requestApproval(subject: LogosApprovalSubject): Promise<boolean> {
		const requestApproval = async (
			request: ApprovalRequest<LogosApprovalSubject>,
		): Promise<void> => {
			await this.emit({ type: "approval_request", request });
		};
		const requestHolder: { value?: ApprovalRequest<LogosApprovalSubject> } = {};
		let approved = false;
		let outcome: LogosApprovalOutcome = "failed";
		let failure: unknown;
		try {
			approved = await this.approval.request(subject, async (request) => {
				requestHolder.value = request;
				await this.recordTaskRunEvidence(
					this.taskRuns,
					{
						kind: "approval",
						sourceId: request.id,
						outcome: "started",
						metadata: { subjectKind: request.subject.kind },
					},
					{ idempotencyKey: `approval:start:${request.id}` },
				);
				if (this.activeTaskRunId !== undefined) {
					await this.applyTaskRunUpdate(
						this.taskRuns,
						this.activeTaskRunId,
						{ type: "wait", reason: "approval" },
						{ idempotencyKey: `approval:wait:${request.id}` },
					);
				}
				await requestApproval(request);
			});
			outcome = approved ? "approved" : "rejected";
		} catch (error) {
			failure = error;
		}
		const request = requestHolder.value;
		if (request && this.activeTaskRunId !== undefined) {
			try {
				const run = await this.taskRuns.get(this.activeTaskRunId);
				if (run.status === "waiting") {
					await this.applyTaskRunUpdate(
						this.taskRuns,
						this.activeTaskRunId,
						{ type: "resume" },
						{ idempotencyKey: `approval:resume:${request.id}` },
					);
				}
			} catch (error) {
				failure ??= error;
			}
		}
		if (request) {
			if (failure !== undefined) outcome = "failed";
			try {
				await this.emit({
				type: "approval_resolved",
					requestId: request.id,
					subjectKind: request.subject.kind,
					outcome,
				});
			} catch (error) {
				failure ??= error;
				outcome = "failed";
			}
			if (this.activeTaskRunId !== undefined) {
				try {
					await this.recordTaskRunEvidence(
						this.taskRuns,
						{
							kind: "approval",
							sourceId: request.id,
							outcome,
							metadata: { subjectKind: request.subject.kind },
						},
						{ idempotencyKey: `approval:resolved:${request.id}` },
					);
				} catch (error) {
					failure ??= error;
				}
			}
		}
		if (failure !== undefined) throw failure;
		return approved;
	}

	private async requestUserQuestion(
		question: UserQuestion,
		signal?: AbortSignal,
	): Promise<UserQuestionResolution> {
		let request: UserQuestionRequest | undefined;
		let questionPresented = false;
		let questionPublicationStarted = false;
		let questionResolution: Promise<void> | undefined;
		let waitingTaskRun:
			| { runId: string; requestId: string }
			| undefined;
		let taskRunResume: Promise<void> | undefined;
		let outcome: UserQuestionResolution["kind"] | "cancel" = "cancel";
		const resumeWaitingTaskRun = async (): Promise<void> => {
			if (taskRunResume) return await taskRunResume;
			const waiting = waitingTaskRun;
			if (!waiting) return;
			taskRunResume = (async () => {
				const run = await this.taskRuns.get(waiting.runId);
				if (run.status === "waiting") {
					await this.applyTaskRunUpdate(
						this.taskRuns,
						waiting.runId,
						{ type: "resume" },
						{ idempotencyKey: `question:resume:${waiting.requestId}` },
					);
				}
				waitingTaskRun = undefined;
			})();
			try {
				await taskRunResume;
			} finally {
				taskRunResume = undefined;
			}
		};
		const emitQuestionResolved = async (): Promise<void> => {
			if (!request || !questionPublicationStarted) return;
			questionResolution ??= this.emit({
				type: "question_resolved",
				requestId: request.id,
				outcome,
			});
			await questionResolution;
		};
		try {
			const resolution = await this.questions.request(
				question,
				async (pending, publicationSignal) => {
					request = pending;
					const taskRunId = this.activeTaskRunId;
					if (taskRunId !== undefined) {
						await this.applyTaskRunUpdate(
							this.taskRuns,
							taskRunId,
							{ type: "wait", reason: "user" },
							{ idempotencyKey: `question:wait:${pending.id}` },
						);
						waitingTaskRun = { runId: taskRunId, requestId: pending.id };
					}
					try {
						if (publicationSignal.aborted) {
							throw publicationSignal.reason instanceof Error
								? publicationSignal.reason
								: new Error("User question publication cancelled");
						}
						questionPublicationStarted = true;
						questionPresented = await this.emitUntilCancelled(
							{ type: "question_request", request: pending },
							publicationSignal,
						);
						if (!questionPresented) {
							throw publicationSignal.reason instanceof Error
								? publicationSignal.reason
								: new Error("User question publication cancelled");
						}
					} catch (error) {
						await resumeWaitingTaskRun();
						await emitQuestionResolved();
						throw error;
					}
				},
				signal,
			);
			outcome = resolution.kind;
			return resolution;
		} finally {
			if (request) {
				try {
					await resumeWaitingTaskRun();
				} finally {
					if (questionPresented) await emitQuestionResolved();
				}
			}
		}
	}

	private async runTransition<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
		if (this.isBusy()) throw new Error("Logos Agent is busy");
		this.transitioning = true;
		let finishTransition = () => {};
		const transitionPromise = new Promise<void>((resolve) => {
			finishTransition = resolve;
		});
		this.transitionPromise = transitionPromise;
		try {
			return await operation();
		} finally {
			this.transitioning = false;
			if (this.transitionPromise === transitionPromise) this.transitionPromise = undefined;
			finishTransition();
		}
	}

	private async emit(event: LogosAgentUiEvent): Promise<void> {
		for (const listener of this.listeners) await listener(event);
	}

	private async emitUntilCancelled(
		event: LogosAgentUiEvent,
		signal: AbortSignal,
	): Promise<boolean> {
		for (const listener of this.listeners) {
			if (signal.aborted) return false;
			await listener(event);
		}
		return !signal.aborted;
	}

	async prompt(text: string): Promise<AssistantMessage> {
		if (this.isBusy()) throw new Error("Logos Agent is busy");
		const result = await this.observability.runTurn(
			text,
			async () => await this.executePrompt(text),
		);
		return result.message;
	}

	private async executePrompt(text: string): Promise<LogosAgentTurnResult> {
		let finishPromptLifecycle = () => {};
		const promptLifecyclePromise = new Promise<void>((resolve) => {
			finishPromptLifecycle = resolve;
		});
		this.promptLifecyclePromise = promptLifecyclePromise;
		this.busy = true;
		this.taskCompletion.reset();
		this.taskDeliberation.beginTurn();
		this.codeIntelligenceProvider.beginTurn();
		this.turnTaskLifecycle.beginTurn(text);
		this.pendingTaskRunEvidence = [];
		const taskAbortController = new AbortController();
		this.taskAbortController = taskAbortController;
		try {
			const completion = await runTaskCompletionLoop(
				text,
				async (prompt) => await this.harness.prompt(prompt),
				(message) => isNormalTurnComplete(message),
				async (attempt, maxAttempts, reason) => {
					await this.emit({
						type: "task_completion_retry",
						attempt,
						maxAttempts,
						reason,
						mode: this.turnTaskLifecycle.isTask() ? "task" : "turn",
					});
				},
				taskAbortController.signal,
				(reason: CompletionContinuationReason) =>
					reason === "length"
						? turnLengthContinuationPrompt
						: turnCompletionContinuationPrompt,
			);
			if (taskAbortController.signal.aborted) {
				throw taskAbortController.signal.reason;
			}
			const { message, completed, continuationCount } = completion;
			const outcome: LogosAgentTurnResult["outcome"] =
				message.stopReason === "aborted"
					? "aborted"
					: completed
						? "ok"
						: "error";
			const runId = this.activeTaskRunId;
			if (runId !== undefined) {
				await this.applyTaskRunUpdate(
					this.taskRuns,
					runId,
					{ type: "phase", phase: "deliver" },
					{ idempotencyKey: `phase:deliver:${message.timestamp}` },
				);
				await this.recordTaskRunEvidence(
					this.taskRuns,
					{
						kind: "assistant",
						sourceId: `${message.provider}:${message.timestamp}`,
						outcome:
							completed && !taskAbortController.signal.aborted
								? "completed"
								: "failed",
						metadata: {
							model: message.model,
							stopReason: message.stopReason,
						},
					},
					{
						runId,
						idempotencyKey: `assistant:${message.provider}:${message.timestamp}`,
					},
				);
				const conclusion = outcome === "ok" ? "success" : outcome === "aborted" ? "aborted" : "failure";
				await this.applyTaskRunUpdate(
					this.taskRuns,
					runId,
					{
						type: "finish",
						conclusion,
						...(completed && !taskAbortController.signal.aborted
							? {}
							: {
									reason:
										(taskAbortController.signal.reason instanceof Error
											? taskAbortController.signal.reason.message
											: undefined) ??
										message.errorMessage ??
										(message.stopReason === "stop"
											? `Assistant stopped without finish_task after ${continuationCount} continuation attempts`
											: `Assistant stopped with ${message.stopReason}`),
								}),
					},
					{ idempotencyKey: `finish:${message.timestamp}` },
				);
			}
			return { message, outcome };
		} catch (error) {
			const runId = this.activeTaskRunId;
			if (runId !== undefined) {
				const run = await this.taskRuns.get(runId);
				if (run.status !== "terminal") {
					await this.applyTaskRunUpdate(this.taskRuns, runId, {
						type: "finish",
						conclusion:
							taskAbortController.signal.aborted ||
							this.abortRequestedTaskRunId === runId
								? "aborted"
								: "failure",
						reason: error instanceof Error ? error.message : String(error),
					});
				}
			}
			throw error;
		} finally {
			const finishingRunId = this.activeTaskRunId;
			this.taskCompletion.reset();
			if (this.taskAbortController === taskAbortController) {
				this.taskAbortController = undefined;
			}
			if (this.abortRequestedTaskRunId === finishingRunId) {
				this.abortRequestedTaskRunId = undefined;
			}
			this.activeTaskRunId = undefined;
			this.pendingTaskRunEvidence = [];
			this.turnTaskLifecycle.endTurn();
			this.busy = false;
			if (this.promptLifecyclePromise === promptLifecyclePromise) {
				this.promptLifecyclePromise = undefined;
			}
			finishPromptLifecycle();
		}
	}

	async steer(text: string): Promise<void> {
		if (!this.busy) {
			throw new Error("Logos Agent has no active turn");
		}
		const externalInputId = this.taskCompletion.beginExternalInput();
		try {
			await this.harness.steer(text);
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "invalid_state"
			) {
				this.taskCompletion.cancelExternalInput(externalInputId);
			}
			throw error;
		}
	}

	async abort(): Promise<void> {
		if (this.compactionAbortController) {
			if (!this.compactionCommitStarted) this.compactionAbortController.abort();
			await this.transitionPromise;
			return;
		}
		if (this.codeGraphAbortController) {
			this.codeGraphAbortController.abort();
			await this.transitionPromise;
			return;
		}
		this.abortRequestedTaskRunId = this.activeTaskRunId;
		this.taskAbortController?.abort(new Error("Task aborted by user"));
		this.approval.cancel();
		this.questions.cancel();
		await this.harness.abort();
		await this.promptLifecyclePromise;
	}

	async shutdown(): Promise<void> {
		this.shutdownPromise ??= this.performShutdown();
		await this.shutdownPromise;
	}

	private async performShutdown(): Promise<void> {
		const errors: Error[] = [];
		try {
			if (this.isBusy()) await this.abort();
			else {
				this.approval.cancel();
				this.questions.cancel();
			}
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		}
		try {
			await this.codeGraphSync.stop();
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		}
		try {
			await this.commandManager.shutdown();
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		}
		try {
			this.uninstrumentHarness();
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		}
		await this.observability.shutdown();
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Logos Agent shutdown failed");
	}

	async waitForIdle(): Promise<void> {
		await this.transitionPromise;
		await this.harness.waitForIdle();
		await this.promptLifecyclePromise;
		await this.codeGraphSync.waitForIdle();
	}

	isBusy(): boolean {
		return this.busy || this.transitioning;
	}

	getActiveTaskRunId(): string | undefined {
		return this.activeTaskRunId;
	}

	async getTaskRun(id: string): Promise<TaskRunState> {
		return await this.taskRuns.get(id);
	}

	async listTaskRuns(): Promise<TaskRunState[]> {
		return await this.taskRuns.list();
	}

	subscribe(listener: (event: LogosAgentUiEvent) => void | Promise<void>): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	respondToApproval(requestId: string, approved: boolean): boolean {
		return this.approval.respond(requestId, approved);
	}

	respondToQuestion(
		requestId: string,
		action: UserQuestionAction,
	): UserQuestionResponse {
		return this.questions.respond(requestId, action);
	}

	async getMessages(): Promise<AgentMessage[]> {
		return (await this.session.buildContext()).messages;
	}

	async getSessionInfo(): Promise<LogosAgentSessionInfo> {
		const metadata = await this.session.getMetadata();
		const context = await this.session.buildContext();
		return { id: metadata.id, path: metadata.path, messageCount: context.messages.length };
	}

	getModelId(): string {
		return this.model.id;
	}

	getWorkspaceRoot(): string {
		return this.config.workspaceRoot;
	}

	async getCodeGraphStatus(): Promise<CodeGraphWorkspaceStatus> {
		return await this.codeGraph.status();
	}

	async initializeCodeGraph(): Promise<CodeGraphWorkspaceOperationResult> {
		const result = await this.runCodeGraphOperation(async (signal) =>
			await this.codeGraph.initialize(signal),
		);
		if (result.status.freshness === "fresh") {
			this.codeIntelligenceProvider.markWorkspaceSynchronized?.();
		}
		return result;
	}

	async syncCodeGraph(): Promise<CodeGraphWorkspaceOperationResult> {
		const result = await this.runCodeGraphOperation(async (signal) =>
			await this.codeGraph.sync(signal),
		);
		if (result.status.freshness === "fresh") {
			this.codeIntelligenceProvider.markWorkspaceSynchronized?.();
		}
		return result;
	}

	private async runCodeGraphOperation(
		operation: (signal: AbortSignal) => Promise<CodeGraphWorkspaceOperationResult>,
	): Promise<CodeGraphWorkspaceOperationResult> {
		const controller = new AbortController();
		return await this.runTransition(async () => {
			await this.codeGraphSync.waitForIdle();
			this.codeGraphAbortController = controller;
			try {
				return await operation(controller.signal);
			} finally {
				if (this.codeGraphAbortController === controller) {
					this.codeGraphAbortController = undefined;
				}
			}
		});
	}

	async compact(options: { force?: boolean } = {}): Promise<LogosAgentCompactResult> {
		return await this.runTransition(async () => {
			const controller = new AbortController();
			this.compactionAbortController = controller;
			this.compactionCommitStarted = false;
			let before: LogosAgentContextInfo | undefined;
			try {
				before = await this.getContextInfo();
				if (controller.signal.aborted) {
					return {
						status: "cancelled",
						tokensBefore: before.tokenCount,
						tokensAfter: before.tokenCount,
						tokensSaved: 0,
						restoreAvailable: false,
					};
				}
				if (!shouldRunManualCompaction(before, options.force ?? false)) {
					return {
						status: "not_needed",
						tokensBefore: before.tokenCount,
						tokensAfter: before.tokenCount,
						tokensSaved: 0,
						restoreAvailable: false,
					};
				}
				const result = await this.harness.compact(undefined, { signal: controller.signal });
				const after = await this.getContextInfo();
				return {
					status: "completed",
					summary: result.summary,
					tokensBefore: result.tokensBefore,
					tokensAfter: after.tokenCount,
					tokensSaved: Math.max(0, result.tokensBefore - after.tokenCount),
					restoreAvailable: true,
				};
			} catch (error) {
				if (
					controller.signal.aborted ||
					(error instanceof Error && error.message === "Compaction cancelled")
				) {
					const tokenCount = before?.tokenCount ?? 0;
					return {
						status: "cancelled",
						tokensBefore: tokenCount,
						tokensAfter: tokenCount,
						tokensSaved: 0,
						restoreAvailable: false,
					};
				}
				throw error;
			} finally {
				if (this.compactionAbortController === controller) {
					this.compactionAbortController = undefined;
					this.compactionCommitStarted = false;
				}
			}
		});
	}

	async getContextInfo(): Promise<LogosAgentContextInfo> {
		const contextWindow = this.model.contextWindow;
		const context = await this.session.buildContext();
		const tokenCount = estimateContextTokens(context.messages).tokens;
		const percent = contextWindow > 0 ? Math.round((tokenCount / contextWindow) * 100) : 0;
		return { tokenCount, contextWindow, percent };
	}

	async getCacheStats(): Promise<LogosAgentCacheStats> {
		return computeCacheStats(await this.session.getEntries());
	}

	async getCacheReport(release?: string): Promise<CacheOperationsReport> {
		return buildCacheOperationsReport(
			await this.getCacheAnalyticsEntries(),
			release,
		);
	}

	async compareCacheReleases(
		baselineRelease: string,
		currentRelease = this.config.cacheEnvironment.release,
	): Promise<CacheReleaseComparison> {
		return compareCacheReleases(
			await this.getCacheAnalyticsEntries(),
			baselineRelease,
			currentRelease,
		);
	}

	getCacheRelease(): string {
		return this.config.cacheEnvironment.release;
	}

	private async getCacheAnalyticsEntries(): Promise<SessionTreeEntry[]> {
		const entries: SessionTreeEntry[] = [];
		for (const metadata of await this.repo.list({ cwd: this.config.workspaceRoot })) {
			entries.push(...(await (await this.repo.open(metadata)).getEntries()));
		}
		return entries;
	}

	getToolPolicies(): ToolPolicyInfo[] {
		return this.toolSystem.getToolPolicies();
	}

	async setToolPermission(toolName: string, permission: ToolPermission | undefined): Promise<void> {
		await this.runTransition(async () => {
			const previous = this.toolSystem.getPermissionSnapshot().tools[toolName];
			this.toolSystem.setToolPermission(toolName, permission);
			try {
				await this.applyToolPermissions();
			} catch (error) {
				this.toolSystem.setToolPermission(toolName, previous);
				throw error;
			}
		});
	}

	async setCapabilityPermission(
		capability: ToolCapabilityKind,
		permission: ToolPermission | undefined,
	): Promise<void> {
		await this.runTransition(async () => {
			const previous = this.toolSystem.getPermissionSnapshot().capabilities[capability];
			this.toolSystem.setCapabilityPermission(capability, permission);
			try {
				await this.applyToolPermissions();
			} catch (error) {
				this.toolSystem.setCapabilityPermission(capability, previous);
				throw error;
			}
		});
	}

	private async applyToolPermissions(): Promise<void> {
		const tools = this.toolSystem.getTools();
		await this.harness.setTools(tools, tools.map((tool) => tool.name));
	}

	async restoreLastCompaction(): Promise<LogosAgentContextInfo> {
		return await this.runTransition(async () => {
			const leafId = await this.session.getLeafId();
			if (!leafId) throw new Error("No compaction is available to restore");
			const leaf = await this.session.getEntry(leafId);
			if (leaf?.type !== "compaction") {
				throw new Error("Only an immediately preceding compaction can be restored");
			}
			await this.session.moveTo(leaf.parentId);
			return await this.getContextInfo();
		});
	}

	async listSessions(): Promise<LogosAgentSessionListItem[]> {
		const sessions = await this.repo.list({ cwd: this.config.workspaceRoot });
		const result: LogosAgentSessionListItem[] = [];
		for (const meta of sessions) {
			try {
				const session = await this.repo.open(meta);
				const context = await session.buildContext();
				const firstUserMessage = context.messages.find((message) => message.role === "user");
				result.push({
					id: meta.id,
					path: meta.path,
					messageCount: context.messages.length,
					createdAt: meta.createdAt,
					preview: firstUserMessage
						? getMessageText(firstUserMessage).replace(/\s+/g, " ").trim().slice(0, 120)
						: "",
				});
			} catch {
				// Skip sessions that fail to open
				result.push({
					id: meta.id,
					path: meta.path,
					messageCount: 0,
					createdAt: meta.createdAt,
					preview: "",
				});
			}
		}
		result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		return result;
	}

	private async installRuntime(
		session: Session<JsonlSessionMetadata>,
		runtime: LogosRuntime,
	): Promise<void> {
		await this.codeGraphSync.stop();
		this.unsubscribeHarness();
		this.uninstrumentHarness();
		this.session = session;
		this.harness = runtime.harness;
		this.toolSystem = runtime.toolSystem;
		this.taskDeliberation = runtime.taskDeliberation;
		this.cacheTracker = runtime.cacheTracker;
		this.taskRuns = runtime.taskRuns;
		this.codeGraph = runtime.codeGraph;
		this.codeGraphSync = runtime.codeGraphSync;
		this.codeIntelligenceProvider = runtime.codeIntelligenceProvider;
		this.createTaskRunManifest = runtime.createTaskRunManifest;
		this.uninstrumentHarness = this.observability.instrument(this.harness);
		await this.hydrateCacheTracker();
		this.attachHarness();
	}

	async switchSession(id: string): Promise<LogosAgentSessionInfo> {
		return await this.runTransition(async () => {
			const sessions = await this.repo.list({ cwd: this.config.workspaceRoot });
			const target = sessions.find((s) => s.id === id);
			if (!target) throw new Error(`Session not found: ${id}`);
			const session = await this.repo.open(target);
			const systemPromptBase = await loadSystemPromptBase(
				this.env,
				this.config.workspaceRoot,
			);
			const runtime = this.buildRuntime(session, systemPromptBase);
			await this.installRuntime(session, runtime);
			return await this.getSessionInfo();
		});
	}

	async newSession(): Promise<LogosAgentSessionInfo> {
		return await this.runTransition(async () => {
			const session = await this.repo.create({ cwd: this.config.workspaceRoot });
			const systemPromptBase = await loadSystemPromptBase(
				this.env,
				this.config.workspaceRoot,
			);
			const runtime = this.buildRuntime(session, systemPromptBase);
			await this.installRuntime(session, runtime);
			return await this.getSessionInfo();
		});
	}
}

export function getMessageText(message: AgentMessage): string {
	if (message.role === "user") {
		return typeof message.content === "string"
			? message.content
			: message.content
					.filter((item): item is TextContent => item.type === "text")
					.map((item) => item.text)
					.join("\n");
	}
	if (message.role === "assistant" || message.role === "toolResult") {
		return message.content
			.filter((item): item is TextContent => item.type === "text")
			.map((item) => item.text)
			.join("\n");
	}
	return "";
}

export function getMessageThinking(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((item): item is ThinkingContent => item.type === "thinking" && !item.redacted)
		.map((item) => item.thinking)
		.join("\n");
}
