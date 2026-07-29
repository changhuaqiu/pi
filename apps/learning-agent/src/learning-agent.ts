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
	createApplyEditTool,
	createControlledEditManager,
	createNodeControlledEditOperations,
	createProposePatchTool,
	type ControlledEditManager,
} from "./controlled-edit-tools.ts";
import { EditApprovalCoordinator, type EditApprovalRequest } from "./edit-approval.ts";
import {
	createNodeWorkspaceInfoOperations,
	createWorkspaceInfoTool,
} from "./workspace-info.ts";
import {
	createListFilesTool,
	createNodeReadOnlyWorkspaceOperations,
	createReadFileTool,
	createSearchTextTool,
} from "./read-only-tools.ts";
import {
	createGitBlameTool,
	createGitDiffTool,
	createGitLogTool,
	createGitShowTool,
	createGitStatusTool,
	createNodeGitOperations,
} from "./git-tools.ts";
import {
	createAuditRecord,
	freezeToolInput,
	type LearningToolName,
	redactToolResult,
	type ToolAuditRecord,
} from "./tool-security.ts";

export type LearningAgentEvent = AgentHarnessEvent | { type: "audit"; record: ToolAuditRecord };
export type LearningAgentUiEvent =
	| LearningAgentEvent
	| { type: "approval_request"; request: EditApprovalRequest }
	| { type: "approval_resolved"; requestId: string; approved: boolean };
type LearningTool =
	| ReturnType<typeof createWorkspaceInfoTool>
	| ReturnType<typeof createListFilesTool>
	| ReturnType<typeof createReadFileTool>
	| ReturnType<typeof createSearchTextTool>
	| ReturnType<typeof createProposePatchTool>
	| ReturnType<typeof createApplyEditTool>
	| ReturnType<typeof createGitStatusTool>
	| ReturnType<typeof createGitDiffTool>
	| ReturnType<typeof createGitLogTool>
	| ReturnType<typeof createGitShowTool>
	| ReturnType<typeof createGitBlameTool>;
type LearningHarness = AgentHarness<Skill, PromptTemplate, LearningTool>;
const allowedToolNames = new Set<LearningToolName>([
	"workspace_info",
	"list_files",
	"read_file",
	"search_text",
	"propose_patch",
	"apply_edit",
	"git_status",
	"git_diff",
	"git_log",
	"git_show",
	"git_blame",
]);

function isLearningToolName(value: string): value is LearningToolName {
	return allowedToolNames.has(value as LearningToolName);
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
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	isBusy(): boolean;
	subscribe(listener: (event: LearningAgentUiEvent) => void | Promise<void>): () => void;
	respondToApproval(requestId: string, approved: boolean): boolean;
	getMessages(): Promise<AgentMessage[]>;
	getSessionInfo(): Promise<LearningAgentSessionInfo>;
	newSession(): Promise<LearningAgentSessionInfo>;
	getModelId(): string;
	listSessions(): Promise<LearningAgentSessionListItem[]>;
	switchSession(id: string): Promise<LearningAgentSessionInfo>;
	compact(options?: { force?: boolean }): Promise<LearningAgentCompactResult>;
	restoreLastCompaction(): Promise<LearningAgentContextInfo>;
	getContextInfo(): Promise<LearningAgentContextInfo>;
}

export interface LearningAgentConfig {
	workspaceRoot: string;
	sessionsRoot: string;
	provider: "openai" | "anthropic" | "deepseek";
	modelId: string;
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
	private readonly approval = new EditApprovalCoordinator();
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
	) {
		this.config = config;
		this.env = env;
		this.repo = repo;
		this.models = models;
		this.model = model;
		this.session = session;
		this.harness = this.buildHarness(session);
	}

	static async create(config: LearningAgentConfig): Promise<HarnessLearningAgent> {
		assertCredentials(config.provider);
		const { models, model } = createModel(config);
		await mkdir(config.sessionsRoot, { recursive: true });
		const env = new NodeExecutionEnv({ cwd: config.workspaceRoot });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: config.sessionsRoot });
		const sessions = await repo.list({ cwd: config.workspaceRoot });
		const session = sessions[0] ? await repo.open(sessions[0]) : await repo.create({ cwd: config.workspaceRoot });
		const agent = new HarnessLearningAgent(config, env, repo, models, model, session);
		agent.attachHarness();
		return agent;
	}

	private buildHarness(session: Session<JsonlSessionMetadata>): LearningHarness {
		const readOperations = createNodeReadOnlyWorkspaceOperations(this.config.workspaceRoot);
		const gitOperations = createNodeGitOperations(this.config.workspaceRoot);
		const editManager = createControlledEditManager({
			operations: createNodeControlledEditOperations(this.config.workspaceRoot),
		});
		const tools: LearningTool[] = [
			createWorkspaceInfoTool(
				this.config.workspaceRoot,
				createNodeWorkspaceInfoOperations(this.config.workspaceRoot),
			),
			createListFilesTool(readOperations),
			createReadFileTool(readOperations),
			createSearchTextTool(readOperations),
			createProposePatchTool(editManager),
			createApplyEditTool(editManager),
			createGitStatusTool(gitOperations),
			createGitDiffTool(gitOperations),
			createGitLogTool(gitOperations),
			createGitShowTool(gitOperations),
			createGitBlameTool(gitOperations),
		];
		const harness = new AgentHarness<Skill, PromptTemplate, LearningTool>({
			env: this.env,
			session,
			models: this.models,
			model: this.model,
			tools,
			systemPrompt: [
				"You are Learning Agent, a concise coding assistant used to study reliable agent execution.",
				"You can inspect the current workspace with workspace_info, list_files, read_file, search_text, and the read-only git_* tools.",
				"Use list_files to discover structure, search_text to locate symbols, and read_file for bounded source ranges.",
				"Use git_status, git_diff, git_log, git_show, and git_blame to inspect repository history and changes without modifying Git state.",
				"Use propose_patch with exact oldText and newText to prepare an edit only under apps/learning-agent.",
				"propose_patch does not write. To apply it, call apply_edit with its proposalId; the application will ask the user for approval.",
				"Never claim an edit succeeded until apply_edit returns success. The running process must be restarted to load edited code.",
				"All tool paths are relative to the injected workspace root.",
				"Never claim to execute arbitrary shell commands. Git tools are limited to read-only inspection. Do not edit outside apps/learning-agent.",
			].join("\n"),
		});
		harness.on("tool_call", async (event) => {
			if (!isLearningToolName(event.toolName)) {
				return { block: true, reason: `Tool is not allowed: ${event.toolName}` };
			}
			freezeToolInput(event.input);
			let decision: ToolAuditRecord["decision"] = "allowed";
			let approvedProposalId: string | undefined;
			if (event.toolName === "apply_edit") {
				const proposalId = event.input.proposalId;
				if (typeof proposalId !== "string") {
					return { block: true, reason: "apply_edit proposalId is invalid" };
				}
				const proposal = editManager.getProposal(proposalId);
				const approved = await this.requestEditApproval(proposal);
				decision = approved ? "allowed" : "blocked";
				if (approved) approvedProposalId = proposalId;
			}
			const record = createAuditRecord(event.toolCallId, event.toolName, event.input, decision);
			await session.appendCustomEntry("tool_audit", record);
			await this.emit({ type: "audit", record });
			if (approvedProposalId) editManager.approve(approvedProposalId);
			return decision === "blocked" ? { block: true, reason: "User rejected the edit proposal" } : undefined;
		});
		harness.on("tool_result", (event) => {
			if (!isLearningToolName(event.toolName)) return undefined;
			return redactToolResult(event.content, event.details, this.config.workspaceRoot);
		});
		return harness;
	}

	private attachHarness(): void {
		this.unsubscribeHarness();
		this.unsubscribeHarness = this.harness.subscribe((event) => {
			if (event.type === "compaction_update" && event.phase === "committing") {
				this.compactionCommitStarted = true;
			}
			return this.emit(event);
		});
	}

	private async requestEditApproval(proposal: ReturnType<ControlledEditManager["getProposal"]>): Promise<boolean> {
		const requestApproval = async (request: EditApprovalRequest): Promise<void> => {
			await this.emit({ type: "approval_request", request });
		};
		const requestIdHolder: { value?: string } = {};
		const approved = await this.approval.request(proposal, async (request) => {
			requestIdHolder.value = request.id;
			await requestApproval(request);
		});
		if (requestIdHolder.value) {
			await this.emit({ type: "approval_resolved", requestId: requestIdHolder.value, approved });
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
		try {
			return await this.harness.prompt(text);
		} finally {
			this.busy = false;
		}
	}

	async abort(): Promise<void> {
		if (this.compactionAbortController) {
			if (!this.compactionCommitStarted) this.compactionAbortController.abort();
			await this.transitionPromise;
			return;
		}
		this.approval.cancel();
		await this.harness.abort();
	}

	async waitForIdle(): Promise<void> {
		await this.transitionPromise;
		await this.harness.waitForIdle();
	}

	isBusy(): boolean {
		return this.busy || this.transitioning;
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
				result.push({
					id: meta.id,
					path: meta.path,
					messageCount: context.messages.length,
					createdAt: meta.createdAt,
				});
			} catch {
				// Skip sessions that fail to open
				result.push({
					id: meta.id,
					path: meta.path,
					messageCount: 0,
					createdAt: meta.createdAt,
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
			const harness = this.buildHarness(session);
			this.unsubscribeHarness();
			this.session = session;
			this.harness = harness;
			this.attachHarness();
			return await this.getSessionInfo();
		});
	}

	async newSession(): Promise<LearningAgentSessionInfo> {
		return await this.runTransition(async () => {
			const session = await this.repo.create({ cwd: this.config.workspaceRoot });
			const harness = this.buildHarness(session);
			this.unsubscribeHarness();
			this.session = session;
			this.harness = harness;
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
