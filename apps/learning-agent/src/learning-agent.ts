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
} from "../../../packages/agent/src/index.ts";
import { NodeExecutionEnv } from "../../../packages/agent/src/node.ts";
import {
	type AssistantMessage,
	createModels,
	type Model,
	type Models,
	type TextContent,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
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
	type LearningAgentCacheStats,
} from "./cache-stats.ts";
import {
	createControlledEditManager,
	createNodeControlledEditOperations,
} from "./controlled-edit-tools.ts";
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
	createGenericLearningApprovalSubject,
	createLearningToolDescriptors,
	type LearningApprovalSubject,
	type LearningTool,
} from "./learning-tools.ts";
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
import { SessionTaskRunJournal } from "./session-task-run-journal.ts";
import {
	TaskRunController,
	type TaskRunEvidence,
	type TaskRunManifest,
	type TaskRunState,
	type TaskRunUpdate,
} from "./task-run.ts";

export type LearningAgentEvent =
	| AgentHarnessEvent
	| { type: "audit"; record: ToolAuditRecord }
	| { type: "cache_observation_error"; message: string }
	| { type: "task_run_update"; run: TaskRunState };
export type { LearningApprovalSubject } from "./learning-tools.ts";
export type LearningAgentUiEvent =
	| LearningAgentEvent
	| { type: "approval_request"; request: ApprovalRequest<LearningApprovalSubject> }
	| {
			type: "approval_resolved";
			requestId: string;
			subjectKind: LearningApprovalSubject["kind"];
			approved: boolean;
	  };
type LearningHarness = AgentHarness<Skill, PromptTemplate, LearningTool>;
type TaskRunEvidenceInput = Omit<TaskRunEvidence, "id" | "recordedAt">;
interface LearningRuntime {
	harness: LearningHarness;
	toolSystem: ToolSystem<LearningTool, LearningApprovalSubject>;
	cacheTracker: CacheObservationTracker;
	taskRuns: TaskRunController;
	createTaskRunManifest(): TaskRunManifest;
}

const baseSystemPrompt =
	"You are Learning Agent, a concise coding assistant used to study reliable agent execution.";

async function loadSystemPromptBase(
	env: NodeExecutionEnv,
	workspaceRoot: string,
): Promise<string> {
	const workspaceInstructions = await loadWorkspaceInstructions(env, workspaceRoot);
	if (workspaceInstructions.warning) {
		console.warn(`Learning Agent: ${workspaceInstructions.warning}`);
	}
	return buildBaseSystemPrompt(baseSystemPrompt, workspaceInstructions.content);
}

export interface LearningAgentSessionInfo {
	id: string;
	path: string;
	messageCount: number;
}

export interface LearningAgentSessionListItem {
	id: string;
	path: string;
	messageCount: number;
	createdAt: string;
	preview: string;
}

export interface LearningAgentCompactResult {
	status: "completed" | "cancelled" | "not_needed";
	summary?: string;
	tokensBefore: number;
	tokensAfter: number;
	tokensSaved: number;
	restoreAvailable: boolean;
}

export interface LearningAgentContextInfo {
	tokenCount: number;
	contextWindow: number;
	percent: number;
}

export interface LearningAgent {
	prompt(text: string): Promise<AssistantMessage>;
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	isBusy(): boolean;
	subscribe(listener: (event: LearningAgentUiEvent) => void | Promise<void>): () => void;
	respondToApproval(requestId: string, approved: boolean): boolean;
	getMessages(): Promise<AgentMessage[]>;
	getSessionInfo(): Promise<LearningAgentSessionInfo>;
	newSession(): Promise<LearningAgentSessionInfo>;
	getModelId(): string;
	getWorkspaceRoot(): string;
	listSessions(): Promise<LearningAgentSessionListItem[]>;
	switchSession(id: string): Promise<LearningAgentSessionInfo>;
	compact(options?: { force?: boolean }): Promise<LearningAgentCompactResult>;
	restoreLastCompaction(): Promise<LearningAgentContextInfo>;
	getContextInfo(): Promise<LearningAgentContextInfo>;
	getCacheStats(): Promise<LearningAgentCacheStats>;
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

export interface LearningAgentConfig {
	workspaceRoot: string;
	sessionsRoot: string;
	provider: "openai" | "anthropic" | "deepseek";
	modelId: string;
	cacheEnvironment: CacheObservationEnvironment;
}

export function shouldRunManualCompaction(
	context: LearningAgentContextInfo,
	force: boolean,
): boolean {
	return force || (context.contextWindow > 0 && context.tokenCount / context.contextWindow >= 0.7);
}

function createModel(config: LearningAgentConfig): { models: Models; model: Model<any> } {
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

function assertCredentials(provider: LearningAgentConfig["provider"]): void {
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

export class HarnessLearningAgent implements LearningAgent {
	private readonly config: LearningAgentConfig;
	private readonly env: NodeExecutionEnv;
	private readonly repo: JsonlSessionRepo;
	private readonly models: Models;
	private readonly model: Model<any>;
	private harness: LearningHarness;
	private session: Session<JsonlSessionMetadata>;
	private busy = false;
	private transitioning = false;
	private transitionPromise?: Promise<void>;
	private readonly approval = new ApprovalCoordinator<LearningApprovalSubject>();
	private readonly toolPermissions = new InMemoryToolPermissionStore();
	private toolSystem: ToolSystem<LearningTool, LearningApprovalSubject>;
	private cacheTracker: CacheObservationTracker;
	private taskRuns: TaskRunController;
	private createTaskRunManifest: () => TaskRunManifest;
	private activeTaskRunId?: string;
	private abortRequestedTaskRunId?: string;
	private compactionAbortController?: AbortController;
	private compactionCommitStarted = false;
	private listeners = new Set<(event: LearningAgentUiEvent) => void | Promise<void>>();
	private unsubscribeHarness: () => void = () => {};

	private constructor(
		config: LearningAgentConfig,
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
		const runtime = this.buildRuntime(session, systemPromptBase);
		this.harness = runtime.harness;
		this.toolSystem = runtime.toolSystem;
		this.cacheTracker = runtime.cacheTracker;
		this.taskRuns = runtime.taskRuns;
		this.createTaskRunManifest = runtime.createTaskRunManifest;
	}

	static async create(config: LearningAgentConfig): Promise<HarnessLearningAgent> {
		assertCredentials(config.provider);
		const { models, model } = createModel(config);
		await mkdir(config.sessionsRoot, { recursive: true });
		const env = new NodeExecutionEnv({ cwd: config.workspaceRoot });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: config.sessionsRoot });
		const sessions = await repo.list({ cwd: config.workspaceRoot });
		const session = sessions[0] ? await repo.open(sessions[0]) : await repo.create({ cwd: config.workspaceRoot });
		const systemPromptBase = await loadSystemPromptBase(env, config.workspaceRoot);
		const agent = new HarnessLearningAgent(
			config,
			env,
			repo,
			models,
			model,
			session,
			systemPromptBase,
		);
		await agent.hydrateCacheTracker();
		agent.attachHarness();
		return agent;
	}

	private buildRuntime(
		session: Session<JsonlSessionMetadata>,
		systemPromptBase: string,
	): LearningRuntime {
		const taskRuns = new TaskRunController({
			journal: new SessionTaskRunJournal(session),
		});
		const readOperations = createNodeReadOnlyWorkspaceOperations(this.config.workspaceRoot);
		const gitOperations = createNodeGitOperations(this.config.workspaceRoot);
		const runTaskOperations = createNodeRunTaskOperations(this.config.workspaceRoot);
		const editManager = createControlledEditManager({
			operations: createNodeControlledEditOperations(this.config.workspaceRoot),
		});
		const toolSystem = new ToolSystem<LearningTool, LearningApprovalSubject>({
			workspaceRoot: this.config.workspaceRoot,
			permissionStore: this.toolPermissions,
			requestApproval: async (subject) => await this.requestApproval(subject),
			createGenericApprovalSubject: createGenericLearningApprovalSubject,
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
					},
				});
				await this.emit({ type: "audit", record });
			},
		});
		for (const descriptor of createLearningToolDescriptors({
			workspaceRoot: this.config.workspaceRoot,
			workspaceInfoOperations: createNodeWorkspaceInfoOperations(this.config.workspaceRoot),
			readOperations,
			gitOperations,
			runTaskOperations,
			editManager,
		})) {
			toolSystem.register(descriptor);
		}
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
					"task-run",
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
		const harness = new AgentHarness<Skill, PromptTemplate, LearningTool>({
			env: this.env,
			session,
			models: this.models,
			model: this.model,
			tools: toolSystem.getTools(),
			systemPrompt: buildSystemPrompt,
		});
		harness.on("tool_call", async (event) => await toolSystem.onToolCall(event));
		harness.on("tool_result", async (event) => {
			const patch = await toolSystem.onToolResult(event);
			await this.recordSemanticToolEvidence(
				taskRuns,
				event.toolCallId,
				event.toolName,
				patch?.details ?? event.details,
				patch?.isError ?? event.isError,
			);
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
				},
			});
			return undefined;
		});
		return {
			harness,
			toolSystem,
			cacheTracker,
			taskRuns,
			createTaskRunManifest,
		};
	}

	private attachHarness(): void {
		this.unsubscribeHarness();
		this.unsubscribeHarness = this.harness.subscribe(async (event) => {
			if (event.type === "compaction_update" && event.phase === "committing") {
				this.compactionCommitStarted = true;
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
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
			await this.emit(event);
		});
	}

	private async hydrateCacheTracker(): Promise<void> {
		this.cacheTracker.hydrate(
			collectCacheObservations(await this.session.getEntries()),
		);
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
		if (runId === undefined) return undefined;
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
					metadata: { toolName },
				},
				{ runId, idempotencyKey: `change:${toolCallId}` },
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

	private async requestApproval(subject: LearningApprovalSubject): Promise<boolean> {
		const requestApproval = async (
			request: ApprovalRequest<LearningApprovalSubject>,
		): Promise<void> => {
			await this.emit({ type: "approval_request", request });
		};
		const requestHolder: { value?: ApprovalRequest<LearningApprovalSubject> } = {};
		let approved = false;
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
		} finally {
			const request = requestHolder.value;
			if (request && this.activeTaskRunId !== undefined) {
				const run = await this.taskRuns.get(this.activeTaskRunId);
				if (run.status === "waiting") {
					await this.applyTaskRunUpdate(
						this.taskRuns,
						this.activeTaskRunId,
						{ type: "resume" },
						{ idempotencyKey: `approval:resume:${request.id}` },
					);
				}
				await this.recordTaskRunEvidence(
					this.taskRuns,
					{
						kind: "approval",
						sourceId: request.id,
						outcome: approved ? "approved" : "rejected",
						metadata: { subjectKind: request.subject.kind },
					},
					{ idempotencyKey: `approval:resolved:${request.id}` },
				);
			}
		}
		if (requestHolder.value) {
			await this.emit({
				type: "approval_resolved",
				requestId: requestHolder.value.id,
				subjectKind: requestHolder.value.subject.kind,
				approved,
			});
		}
		return approved;
	}

	private async runTransition<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
		if (this.isBusy()) throw new Error("Learning Agent is busy");
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

	private async emit(event: LearningAgentUiEvent): Promise<void> {
		for (const listener of this.listeners) await listener(event);
	}

	async prompt(text: string): Promise<AssistantMessage> {
		if (this.isBusy()) throw new Error("Learning Agent is busy");
		this.busy = true;
		let runId: string | undefined;
		try {
			const session = await this.session.getMetadata();
			const run = await this.taskRuns.start({
				sessionId: session.id,
				goal: text,
				manifest: this.createTaskRunManifest(),
			});
			runId = run.id;
			this.activeTaskRunId = run.id;
			await this.emit({ type: "task_run_update", run });
			const message = await this.harness.prompt(text);
			await this.applyTaskRunUpdate(
				this.taskRuns,
				run.id,
				{ type: "phase", phase: "deliver" },
				{ idempotencyKey: `phase:deliver:${message.timestamp}` },
			);
			await this.recordTaskRunEvidence(
				this.taskRuns,
				{
					kind: "assistant",
					sourceId: `${message.provider}:${message.timestamp}`,
					outcome: message.stopReason === "stop" ? "completed" : "failed",
					metadata: {
						model: message.model,
						stopReason: message.stopReason,
					},
				},
				{
					runId: run.id,
					idempotencyKey: `assistant:${message.provider}:${message.timestamp}`,
				},
			);
			const conclusion =
				message.stopReason === "stop"
					? "success"
					: message.stopReason === "aborted"
						? "aborted"
						: "failure";
			await this.applyTaskRunUpdate(
				this.taskRuns,
				run.id,
				{
					type: "finish",
					conclusion,
					...(message.stopReason === "stop"
						? {}
						: {
								reason:
									message.errorMessage ??
									`Assistant stopped with ${message.stopReason}`,
							}),
				},
				{ idempotencyKey: `finish:${message.timestamp}` },
			);
			return message;
		} catch (error) {
			if (runId !== undefined) {
				const run = await this.taskRuns.get(runId);
				if (run.status !== "terminal") {
					await this.applyTaskRunUpdate(this.taskRuns, runId, {
						type: "finish",
						conclusion:
							this.abortRequestedTaskRunId === runId
								? "aborted"
								: "failure",
						reason: error instanceof Error ? error.message : String(error),
					});
				}
			}
			throw error;
		} finally {
			if (this.abortRequestedTaskRunId === runId) {
				this.abortRequestedTaskRunId = undefined;
			}
			this.activeTaskRunId = undefined;
			this.busy = false;
		}
	}

	async steer(text: string): Promise<void> {
		if (!this.busy || this.activeTaskRunId === undefined) {
			throw new Error("Learning Agent has no active TaskRun");
		}
		await this.harness.steer(text);
	}

	async abort(): Promise<void> {
		if (this.compactionAbortController) {
			if (!this.compactionCommitStarted) this.compactionAbortController.abort();
			await this.transitionPromise;
			return;
		}
		this.approval.cancel();
		this.abortRequestedTaskRunId = this.activeTaskRunId;
		await this.harness.abort();
	}

	async waitForIdle(): Promise<void> {
		await this.transitionPromise;
		await this.harness.waitForIdle();
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

	subscribe(listener: (event: LearningAgentUiEvent) => void | Promise<void>): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	respondToApproval(requestId: string, approved: boolean): boolean {
		return this.approval.respond(requestId, approved);
	}

	async getMessages(): Promise<AgentMessage[]> {
		return (await this.session.buildContext()).messages;
	}

	async getSessionInfo(): Promise<LearningAgentSessionInfo> {
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

	async compact(options: { force?: boolean } = {}): Promise<LearningAgentCompactResult> {
		return await this.runTransition(async () => {
			const controller = new AbortController();
			this.compactionAbortController = controller;
			this.compactionCommitStarted = false;
			let before: LearningAgentContextInfo | undefined;
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

	async getContextInfo(): Promise<LearningAgentContextInfo> {
		const contextWindow = this.model.contextWindow;
		const context = await this.session.buildContext();
		const tokenCount = estimateContextTokens(context.messages).tokens;
		const percent = contextWindow > 0 ? Math.round((tokenCount / contextWindow) * 100) : 0;
		return { tokenCount, contextWindow, percent };
	}

	async getCacheStats(): Promise<LearningAgentCacheStats> {
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

	async restoreLastCompaction(): Promise<LearningAgentContextInfo> {
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

	async listSessions(): Promise<LearningAgentSessionListItem[]> {
		const sessions = await this.repo.list({ cwd: this.config.workspaceRoot });
		const result: LearningAgentSessionListItem[] = [];
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

	async switchSession(id: string): Promise<LearningAgentSessionInfo> {
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
			this.unsubscribeHarness();
			this.session = session;
			this.harness = runtime.harness;
			this.toolSystem = runtime.toolSystem;
			this.cacheTracker = runtime.cacheTracker;
			this.taskRuns = runtime.taskRuns;
			this.createTaskRunManifest = runtime.createTaskRunManifest;
			await this.hydrateCacheTracker();
			this.attachHarness();
			return await this.getSessionInfo();
		});
	}

	async newSession(): Promise<LearningAgentSessionInfo> {
		return await this.runTransition(async () => {
			const session = await this.repo.create({ cwd: this.config.workspaceRoot });
			const systemPromptBase = await loadSystemPromptBase(
				this.env,
				this.config.workspaceRoot,
			);
			const runtime = this.buildRuntime(session, systemPromptBase);
			this.unsubscribeHarness();
			this.session = session;
			this.harness = runtime.harness;
			this.toolSystem = runtime.toolSystem;
			this.cacheTracker = runtime.cacheTracker;
			this.taskRuns = runtime.taskRuns;
			this.createTaskRunManifest = runtime.createTaskRunManifest;
			await this.hydrateCacheTracker();
			this.attachHarness();
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
