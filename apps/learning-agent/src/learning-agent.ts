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
			createGitStatusTool(this.config.workspaceRoot),
			createGitDiffTool(this.config.workspaceRoot),
			createGitLogTool(this.config.workspaceRoot),
			createGitShowTool(this.config.workspaceRoot),
			createGitBlameTool(this.config.workspaceRoot),
		];
		const harness = new AgentHarness<Skill, PromptTemplate, LearningTool>({
			env: this.env,
			session,
			models: this.models,
			model: this.model,
			tools,
			systemPrompt: [
				"You are Learning Agent, a concise coding assistant used to study reliable agent execution.",
				"You can inspect the current workspace with workspace_info, list_files, read_file, and search_text.",
				"Use list_files to discover structure, search_text to locate symbols, and read_file for bounded source ranges.",
				"Use propose_patch with exact oldText and newText to prepare an edit only under apps/learning-agent.",
				"propose_patch does not write. To apply it, call apply_edit with its proposalId; the application will ask the user for approval.",
				"Never claim an edit succeeded until apply_edit returns success. The running process must be restarted to load edited code.",
				"All tool paths are relative to the injected workspace root.",
				"Never claim to execute commands. Do not edit outside apps/learning-agent.",
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

// ═══════════════════════════════════════════════════════════════════════════════
// Git read-only tools (inlined to avoid creating a new file — see git-tools.ts)
// ═══════════════════════════════════════════════════════════════════════════════

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

const execFileAsync = promisify(execFile);

export type GitToolName = "git_status" | "git_diff" | "git_log" | "git_show" | "git_blame";

const gitStatusSchema = Type.Object(
	{ path: Type.Optional(Type.String({ description: "Workspace-relative path to limit status to", maxLength: 500 })) },
	{ additionalProperties: false },
);
const gitDiffSchema = Type.Object(
	{
		path: Type.Optional(Type.String({ description: "Workspace-relative file path to limit diff to", maxLength: 500 })),
		staged: Type.Optional(Type.Boolean({ description: "Show staged changes instead of unstaged (default false)" })),
		from: Type.Optional(Type.String({ description: "Source commit/ref, defaults to HEAD" })),
		to: Type.Optional(Type.String({ description: "Target commit/ref, defaults to working tree" })),
	},
	{ additionalProperties: false },
);
const gitLogSchema = Type.Object(
	{
		maxCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max entries, default 20" })),
		path: Type.Optional(Type.String({ description: "Workspace-relative file path to filter by", maxLength: 500 })),
		author: Type.Optional(Type.String({ description: "Filter by author name/email", maxLength: 200 })),
		since: Type.Optional(Type.String({ description: "ISO date to start from, e.g. 2025-01-01", maxLength: 50 })),
	},
	{ additionalProperties: false },
);
const gitShowSchema = Type.Object(
	{
		commit: Type.String({ description: "Commit hash or ref to show", minLength: 1, maxLength: 100 }),
		path: Type.Optional(Type.String({ description: "Workspace-relative file path to limit output to", maxLength: 500 })),
	},
	{ additionalProperties: false },
);
const gitBlameSchema = Type.Object(
	{
		path: Type.String({ description: "Workspace-relative file path", minLength: 1, maxLength: 500 }),
		startLine: Type.Optional(Type.Integer({ minimum: 1, description: "First line to show (1-based)" })),
		maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Max lines to show, default 50" })),
	},
	{ additionalProperties: false },
);

const gitStatusValidator = Compile(gitStatusSchema);
const gitDiffValidator = Compile(gitDiffSchema);
const gitLogValidator = Compile(gitLogSchema);
const gitShowValidator = Compile(gitShowSchema);
const gitBlameValidator = Compile(gitBlameSchema);

export interface GitStatusEntry { path: string; index: string; worktree: string; }
export interface GitStatusDetails { branch: string; staged: GitStatusEntry[]; unstaged: GitStatusEntry[]; untracked: string[]; }
export interface GitDiffDetails { diff: string; }
export interface GitLogEntry { hash: string; hashAbbrev: string; author: string; date: string; message: string; }
export interface GitLogDetails { entries: GitLogEntry[]; truncated: boolean; }
export interface GitShowDetails { commit: GitLogEntry; diff: string; }
export interface GitBlameLine { line: number; hash: string; hashAbbrev: string; author: string; date: string; content: string; }
export interface GitBlameDetails { lines: GitBlameLine[]; }

async function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024, signal, timeout: 15_000 });
	return stdout;
}

function gitCheckSignal(signal?: AbortSignal): void {
	if (signal?.aborted) { const e = new Error("Operation aborted"); e.name = "AbortError"; throw e; }
}

function gitDetails(d: unknown): { content: [{ type: "text"; text: string }]; details: unknown } {
	return { content: [{ type: "text" as const, text: JSON.stringify(d, null, 2) }], details: d };
}

export function createGitStatusTool(workspaceRoot: string): AgentTool<typeof gitStatusSchema, GitStatusDetails> {
	return {
		name: "git_status", label: "git status",
		description: "Show the working tree status: branch, staged/unstaged changes, and untracked files.",
		parameters: gitStatusSchema, executionMode: "sequential",
		async execute(_id, raw, signal, onUpdate) {
			if (!gitStatusValidator.Check(raw)) throw new Error("git_status: invalid arguments");
			const input: Static<typeof gitStatusSchema> = raw;
			onUpdate?.({ content: [{ type: "text", text: "git_status: running…" }], details: {} });
			const args = ["status", "--porcelain=v2", "--branch"];
			if (input.path) args.push("--", input.path);
			const output = await runGit(args, workspaceRoot, signal);
			gitCheckSignal(signal);
			return gitDetails(parsePorcelainV2(output)) as AgentToolResult<GitStatusDetails>;
		},
	};
}

export function createGitDiffTool(workspaceRoot: string): AgentTool<typeof gitDiffSchema, GitDiffDetails> {
	return {
		name: "git_diff", label: "git diff",
		description: "Show changes between commits, the index, and working tree.",
		parameters: gitDiffSchema, executionMode: "sequential",
		async execute(_id, raw, signal, onUpdate) {
			if (!gitDiffValidator.Check(raw)) throw new Error("git_diff: invalid arguments");
			const input: Static<typeof gitDiffSchema> = raw;
			onUpdate?.({ content: [{ type: "text", text: "git_diff: running…" }], details: {} });
			const args = ["diff", "--patch", "--minimal"];
			if (input.staged) args.push("--cached");
			if (input.from) args.push(input.from);
			if (input.to) args.push(input.to);
			if (input.path) args.push("--", input.path);
			const diff = await runGit(args, workspaceRoot, signal);
			gitCheckSignal(signal);
			return gitDetails({ diff });
		},
	};
}

export function createGitLogTool(workspaceRoot: string): AgentTool<typeof gitLogSchema, GitLogDetails> {
	return {
		name: "git_log", label: "git log",
		description: "Show commit history.",
		parameters: gitLogSchema, executionMode: "sequential",
		async execute(_id, raw, signal, onUpdate) {
			if (!gitLogValidator.Check(raw)) throw new Error("git_log: invalid arguments");
			const input: Static<typeof gitLogSchema> = raw;
			onUpdate?.({ content: [{ type: "text", text: "git_log: running…" }], details: {} });
			const args = ["log", `--max-count=${input.maxCount ?? 20}`, "--format=%H%n%h%n%an%n%aI%n%s"];
			if (input.author) args.push(`--author=${input.author}`);
			if (input.since) args.push(`--since=${input.since}`);
			if (input.path) args.push("--", input.path);
			const output = await runGit(args, workspaceRoot, signal);
			gitCheckSignal(signal);
			const entries = parseLogFormat(output, input.maxCount ?? 20);
			return gitDetails({ entries, truncated: entries.length >= (input.maxCount ?? 20) });
		},
	};
}

export function createGitShowTool(workspaceRoot: string): AgentTool<typeof gitShowSchema, GitShowDetails> {
	return {
		name: "git_show", label: "git show",
		description: "Show details and diff for a specific commit.",
		parameters: gitShowSchema, executionMode: "sequential",
		async execute(_id, raw, signal, onUpdate) {
			if (!gitShowValidator.Check(raw)) throw new Error("git_show: invalid arguments");
			const input: Static<typeof gitShowSchema> = raw;
			onUpdate?.({ content: [{ type: "text", text: "git_show: running…" }], details: {} });
			const metaOutput = await runGit(["log", "--max-count=1", "--format=%H%n%h%n%an%n%aI%n%s", input.commit], workspaceRoot, signal);
			const commits = parseLogFormat(metaOutput, 1);
			const commit = commits[0];
			if (!commit) throw new Error(`Commit not found: ${input.commit}`);
			const diffArgs = ["show", "--patch", "--minimal", commit.hash];
			if (input.path) diffArgs.push("--", input.path);
			const diff = await runGit(diffArgs, workspaceRoot, signal);
			gitCheckSignal(signal);
			return gitDetails({ commit, diff });
		},
	};
}

export function createGitBlameTool(workspaceRoot: string): AgentTool<typeof gitBlameSchema, GitBlameDetails> {
	return {
		name: "git_blame", label: "git blame",
		description: "Show line-by-line authorship for a file.",
		parameters: gitBlameSchema, executionMode: "sequential",
		async execute(_id, raw, signal, onUpdate) {
			if (!gitBlameValidator.Check(raw)) throw new Error("git_blame: invalid arguments");
			const input: Static<typeof gitBlameSchema> = raw;
			onUpdate?.({ content: [{ type: "text", text: "git_blame: running…" }], details: {} });
			const maxLines = input.maxLines ?? 50;
			const startLine = input.startLine ?? 1;
			const range = `${startLine},${startLine + maxLines - 1}`;
			const output = await runGit(["blame", "--porcelain", "-L", range, "--", input.path], workspaceRoot, signal);
			gitCheckSignal(signal);
			return gitDetails({ lines: parseBlamePorcelain(output) });
		},
	};
}

// ── porcelain v2 parser ──

function parsePorcelainV2(output: string): GitStatusDetails {
	const lines = output.split("\n").filter((l) => l.length > 0);
	let branch = "(unknown)";
	const staged: GitStatusEntry[] = [];
	const unstaged: GitStatusEntry[] = [];
	const untracked: string[] = [];
	for (const line of lines) {
		if (line.startsWith("# branch.head ")) { branch = line.slice(15); if (branch === "(detached)") branch = "HEAD (detached)"; }
		else if (line.startsWith("1 ")) {
			const parts = line.slice(2).split(" ");
			const idx = parts[0]?.[0] ?? ".";
			const wt = parts[0]?.[1] ?? ".";
			const p = parts.slice(2).join(" ");
			const entry: GitStatusEntry = { path: p, index: idx, worktree: wt };
			if (idx !== ".") staged.push(entry);
			if (wt !== ".") unstaged.push(entry);
		} else if (line.startsWith("? ")) { untracked.push(line.slice(2)); }
	}
	return { branch, staged, unstaged, untracked };
}

function parseLogFormat(output: string, maxCount: number): GitLogEntry[] {
	const lines = output.trim().split("\n").filter((l) => l.length > 0);
	const entries: GitLogEntry[] = [];
	for (let i = 0; i + 4 < lines.length && entries.length < maxCount; i += 5) {
		entries.push({ hash: lines[i]!, hashAbbrev: lines[i + 1]!, author: lines[i + 2]!, date: lines[i + 3]!, message: lines[i + 4]! });
	}
	return entries;
}

function parseBlamePorcelain(output: string): GitBlameLine[] {
	const lines = output.split("\n");
	const result: GitBlameLine[] = [];
	let hash = "", hashAbbrev = "", author = "", date = "", lineNum = 0;
	for (const line of lines) {
		if (/^[0-9a-f]{40}\s+\d+\s+\d+/.test(line)) {
			const parts = line.split(/\s+/);
			hash = parts[0] ?? ""; hashAbbrev = hash.slice(0, 8); lineNum = parseInt(parts[1] ?? "0", 10);
		} else if (line.startsWith("author ")) { author = line.slice(7); }
		else if (line.startsWith("author-time ")) {
			const ts = parseInt(line.slice(12), 10);
			date = ts > 0 ? new Date(ts * 1000).toISOString() : "";
		} else if (line.startsWith("\t")) {
			result.push({ line: lineNum + result.length, hash, hashAbbrev, author, date, content: line.slice(1) });
		}
	}
	return result;
}
