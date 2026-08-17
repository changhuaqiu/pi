import {
	createAskUserTool,
	summarizeQuestionForAudit,
	type UserQuestionOperations,
} from "./ask-user-tool.ts";
import {
	analyzeCodeGraphEditImpact,
	createCodeGraphExploreTool,
	createCodeGraphImpactTool,
	createCodeGraphNodeTool,
	createCodeGraphSearchTool,
	CODEGRAPH_RESULT_BUDGET_BYTES,
	parseCodeGraphExploreInput,
	parseCodeGraphImpactInput,
	parseCodeGraphNodeInput,
	parseCodeGraphSearchInput,
	type CodeIntelligenceProvider,
	type CodeGraphEditImpact,
} from "./code-intelligence.ts";
import {
	createApplyEditTool,
	createProposeCreateFileTool,
	createProposeDeleteFileTool,
	createProposePatchTool,
	type ControlledEditManager,
	type EditProposalSummary,
} from "./controlled-edit-tools.ts";
import {
	commandPlanApprovalSummary,
	createCommandStatusTool,
	createRunCommandTool,
	createStopCommandTool,
	type ControlledCommandApprovalSummary,
	type ControlledCommandManager,
	type ControlledCommandPlan,
	type ControlledCommandProcessSummary,
	type ControlledCommandToolDetails,
} from "./controlled-command-tools.ts";
import {
	createDirectoriesTool,
	parseCreateDirectoriesInput,
	type WorkspaceDirectoryOperations,
} from "./directory-tools.ts";
import {
	createGitBlameTool,
	createGitDiffTool,
	createGitLogTool,
	createGitShowTool,
	createGitStatusTool,
	type GitOperations,
} from "./git-tools.ts";
import {
	createListFilesTool,
	createGrepTool,
	createReadFileTool,
	type ReadOnlyWorkspaceOperations,
} from "./read-only-tools.ts";
import {
	createRunTaskTool,
	describeRunTask,
	parseRunTaskInput,
	type RunTaskApprovalSummary,
	type RunTaskOperations,
	type RunTaskToolDetails,
} from "./run-task-tool.ts";
import { createFinishTaskTool } from "./task-completion-tool.ts";
import {
	createPlanTaskTool,
	createReflectTaskTool,
	type ReflectionGuidanceInput,
	type TaskDeliberationController,
} from "./task-deliberation-tool.ts";
import type { TaskRunAssurance } from "./task-run.ts";
import {
	type ManagedToolDescriptor,
	type ToolAuthorizationContext,
	type ToolCapability,
} from "./tool-system.ts";
import { redactSensitiveText, summarizeAuditText } from "./tool-security.ts";
import {
	createWorkspaceInfoTool,
	type WorkspaceInfoOperations,
} from "./workspace-info.ts";
import {
	createWebSearchTool,
	parseWebSearchInput,
	type WebSearchOperations,
} from "./web-search-tool.ts";

export type LogosApprovalSubject =
	| { kind: "edit"; proposal: EditProposalSummary; impact?: CodeGraphEditImpact }
	| { kind: "directories"; paths: readonly string[] }
	| { kind: "task"; task: RunTaskApprovalSummary }
	| { kind: "command"; command: ControlledCommandApprovalSummary }
	| { kind: "process_stop"; process: ControlledCommandProcessSummary }
	| {
			kind: "tool";
			toolName: string;
			capabilities: readonly ToolCapability[];
	  };

export type LogosTool =
	| ReturnType<typeof createFinishTaskTool>
	| ReturnType<typeof createPlanTaskTool>
	| ReturnType<typeof createReflectTaskTool>
	| ReturnType<typeof createAskUserTool>
	| ReturnType<typeof createWorkspaceInfoTool>
	| ReturnType<typeof createListFilesTool>
	| ReturnType<typeof createReadFileTool>
	| ReturnType<typeof createGrepTool>
	| ReturnType<typeof createCodeGraphSearchTool>
	| ReturnType<typeof createCodeGraphNodeTool>
	| ReturnType<typeof createCodeGraphExploreTool>
	| ReturnType<typeof createCodeGraphImpactTool>
	| ReturnType<typeof createProposePatchTool>
	| ReturnType<typeof createProposeCreateFileTool>
	| ReturnType<typeof createProposeDeleteFileTool>
	| ReturnType<typeof createApplyEditTool>
	| ReturnType<typeof createDirectoriesTool>
	| ReturnType<typeof createRunCommandTool>
	| ReturnType<typeof createCommandStatusTool>
	| ReturnType<typeof createStopCommandTool>
	| ReturnType<typeof createGitStatusTool>
	| ReturnType<typeof createGitDiffTool>
	| ReturnType<typeof createGitLogTool>
	| ReturnType<typeof createGitShowTool>
	| ReturnType<typeof createGitBlameTool>
	| ReturnType<typeof createRunTaskTool>
	| ReturnType<typeof createWebSearchTool>;

export interface LogosToolDependencies {
	workspaceRoot: string;
	taskDeliberation: TaskDeliberationController;
	reflectionGuidance?: () => Promise<ReflectionGuidanceInput | undefined>;
	finishTaskAssurance?: () => Promise<TaskRunAssurance | undefined>;
	userQuestionOperations: UserQuestionOperations;
	workspaceInfoOperations: WorkspaceInfoOperations;
	readOperations: ReadOnlyWorkspaceOperations;
	codeIntelligenceProvider?: CodeIntelligenceProvider;
	gitOperations: GitOperations;
	runTaskOperations: RunTaskOperations;
	editManager: ControlledEditManager;
	directoryOperations: WorkspaceDirectoryOperations;
	commandManager: ControlledCommandManager;
	webSearchOperations?: WebSearchOperations;
}

export function summarizePatchInput(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const oldText = typeof input.oldText === "string" ? input.oldText : "";
	const newText = typeof input.newText === "string" ? input.newText : "";
	const oldSummary = summarizeAuditText(oldText);
	const newSummary = summarizeAuditText(newText);
	return {
		path: input.path,
		description: input.description,
		oldTextBytes: oldSummary.bytes,
		oldTextHash: oldSummary.sha256,
		newTextBytes: newSummary.bytes,
		newTextHash: newSummary.sha256,
	};
}

export function summarizeCreateInput(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const content = typeof input.content === "string" ? input.content : "";
	const summary = summarizeAuditText(content);
	return {
		path: input.path,
		description: input.description,
		contentBytes: summary.bytes,
		contentHash: summary.sha256,
	};
}

export function createGenericLogosApprovalSubject(
	context: ToolAuthorizationContext,
): LogosApprovalSubject {
	return {
		kind: "tool",
		toolName: context.toolName,
		capabilities: context.capabilities,
	};
}

function commandAuthorizationDenial(error: unknown, workspaceRoot: string): string {
	const rawMessage = error instanceof Error ? error.message : String(error);
	const safeMessage = redactSensitiveText(rawMessage, workspaceRoot)
		.replace(/[\r\n\t]+/g, " ")
		.trim()
		.slice(0, 500);
	return [
		`run_command rejected: ${safeMessage || "the requested project command is not allowed"}.`,
		"Use operation=\"npm_run\" with an existing package.json script, or operation=\"npm_install\".",
		"Shell command strings, pipelines, redirection, npx, tsx, and arbitrary executables are unsupported.",
	].join(" ");
}

function projectCommandResult(event: { readonly details: unknown }): { isError: boolean } | undefined {
	if (typeof event.details !== "object" || event.details === null) return undefined;
	const details = event.details as Partial<ControlledCommandToolDetails>;
	if (details.stage !== "completed") return undefined;
	const failed =
		details.status === "timed_out" ||
		details.status === "stopped" ||
		(details.exitCode !== undefined && details.exitCode !== 0);
	return { isError: failed };
}

function projectRunTaskResult(event: { readonly details: unknown }): { isError: boolean } | undefined {
	if (typeof event.details !== "object" || event.details === null) return undefined;
	const details = event.details as Partial<RunTaskToolDetails>;
	if (details.stage !== "completed" || details.exitCode === undefined) return undefined;
	return { isError: details.exitCode !== 0 };
}

export function createLogosToolDescriptors(
	dependencies: LogosToolDependencies,
): ManagedToolDescriptor<LogosTool, LogosApprovalSubject>[] {
	const finishTask = createFinishTaskTool({
		...(dependencies.finishTaskAssurance === undefined
			? {}
			: { loadAssurance: dependencies.finishTaskAssurance }),
	});
	const planTask = createPlanTaskTool(dependencies.taskDeliberation);
	const reflectTask = createReflectTaskTool(dependencies.taskDeliberation, {
		...(dependencies.reflectionGuidance === undefined
			? {}
			: { loadGuidance: dependencies.reflectionGuidance }),
	});
	const askUser = createAskUserTool(dependencies.userQuestionOperations);
	const workspaceInfo = createWorkspaceInfoTool(
		dependencies.workspaceRoot,
		dependencies.workspaceInfoOperations,
	);
	const listFiles = createListFilesTool(dependencies.readOperations);
	const readFile = createReadFileTool(dependencies.readOperations);
	const grep = createGrepTool(dependencies.readOperations);
	const proposePatch = createProposePatchTool(dependencies.editManager);
	const proposeCreateFile = createProposeCreateFileTool(dependencies.editManager);
	const proposeDeleteFile = createProposeDeleteFileTool(dependencies.editManager);
	const applyEdit = createApplyEditTool(dependencies.editManager);
	const createDirectories = createDirectoriesTool(
		dependencies.directoryOperations,
	);
	const runCommand = createRunCommandTool(dependencies.commandManager);
	const commandStatus = createCommandStatusTool(dependencies.commandManager);
	const stopCommand = createStopCommandTool(dependencies.commandManager);
	const gitStatus = createGitStatusTool(dependencies.gitOperations);
	const gitDiff = createGitDiffTool(dependencies.gitOperations);
	const gitLog = createGitLogTool(dependencies.gitOperations);
	const gitShow = createGitShowTool(dependencies.gitOperations);
	const gitBlame = createGitBlameTool(dependencies.gitOperations);
	const runTask = createRunTaskTool(dependencies.runTaskOperations);

	const descriptors: ManagedToolDescriptor<LogosTool, LogosApprovalSubject>[] = [
		{
			tool: planTask,
			capabilities: [{ kind: "task.plan", scope: "current-task-run" }],
			defaultPermission: "allow",
			context: { maxBytes: 8 * 1024 },
			guidance: [
				"Before any workspace mutation or process execution, call plan_task with a bounded plan. Do not call plan_task for read-only analysis or answers; they end with a normal assistant response.",
			],
		},
		{
			tool: reflectTask,
			capabilities: [{ kind: "task.reflect", scope: "current-task-run" }],
			defaultPermission: "allow",
			context: { maxBytes: 8 * 1024 },
			guidance: [
				"After side effects or verification, call reflect_task with concrete evidence. Use decision=ready only when the result is complete; use continue or revise when more work remains.",
			],
		},
		{
			tool: finishTask,
			capabilities: [{ kind: "task.complete", scope: "current-task-run" }],
			defaultPermission: "allow",
			context: { maxBytes: 8 * 1024 },
			guidance: [
				"Ordinary conversation, greetings, explanations, and read-only answers end with a normal assistant response. Do not call plan_task, reflect_task, or finish_task for those turns.",
				"After entering an execution task through an edit proposal, a workspace mutation, or process execution, a normal response stop does not complete that task. Call finish_task as the only tool call when execution and verification are complete, then provide the concise final user-facing summary as normal assistant text without more tools.",
				"Never stop after merely promising or announcing future work. Continue with the required tools instead. Call finish_task only after requested mutations succeeded and relevant verification was performed, or clearly state why verification was not applicable.",
			],
		},
		{
			tool: askUser,
			capabilities: [{ kind: "user.interact", scope: "clarification" }],
			defaultPermission: "allow",
			audit: { summarizeInput: summarizeQuestionForAudit },
		},
		{
			tool: workspaceInfo,
			capabilities: [{ kind: "workspace.inspect", scope: "workspace" }],
			defaultPermission: "allow",
			context: { history: "compact" },
		},
		{
			tool: listFiles,
			capabilities: [{ kind: "fs.read", scope: "workspace" }],
			defaultPermission: "allow",
			context: { history: "compact" },
		},
		{
			tool: readFile,
			capabilities: [{ kind: "fs.read", scope: "workspace" }],
			defaultPermission: "allow",
			context: { history: "compact" },
		},
		{
			tool: grep,
			capabilities: [{ kind: "fs.read", scope: "workspace" }],
			defaultPermission: "allow",
			context: { history: "compact" },
		},
		{
			tool: proposePatch,
			capabilities: [
				{ kind: "edit.propose", scope: "workspace" },
				{ kind: "fs.read", scope: "workspace" },
			],
			defaultPermission: "allow",
			context: { history: "preserve" },
			audit: { summarizeInput: summarizePatchInput },
		},
		{
			tool: proposeCreateFile,
			capabilities: [{ kind: "edit.propose", scope: "workspace" }],
			defaultPermission: "allow",
			context: { history: "preserve" },
			audit: { summarizeInput: summarizeCreateInput },
		},
		{
			tool: proposeDeleteFile,
			capabilities: [
				{ kind: "edit.propose", scope: "workspace" },
				{ kind: "fs.read", scope: "workspace" },
			],
			defaultPermission: "allow",
			context: { history: "preserve" },
		},
		{
			tool: applyEdit,
			capabilities: [
				{ kind: "fs.read", scope: "workspace" },
				{ kind: "fs.write", scope: "workspace" },
				{ kind: "fs.delete", scope: "workspace" },
			],
			defaultPermission: "allow",
			authorization: {
				prepare(context) {
					const proposalId = context.input.proposalId;
					if (typeof proposalId !== "string") {
						return { kind: "deny", reason: "apply_edit proposalId is invalid" };
					}
					const proposal = dependencies.editManager.getProposal(proposalId);
					return {
						kind: "ready",
						prepareApprovalSubject: async (): Promise<LogosApprovalSubject> => ({
							kind: "edit",
							proposal,
							impact: dependencies.codeIntelligenceProvider === undefined
								? undefined
								: await analyzeCodeGraphEditImpact(
									dependencies.codeIntelligenceProvider,
									proposal,
								),
						}),
						grant: () => dependencies.editManager.approve(proposalId),
					};
				},
			},
			guidance: [
				"The running process must be restarted to load edited code.",
			],
		},
		{
			tool: createDirectories,
			capabilities: [{ kind: "fs.write", scope: "workspace-directories" }],
			defaultPermission: "allow",
			authorization: {
				prepare(context) {
					const input = parseCreateDirectoriesInput(context.input);
					return {
						kind: "ready",
						approvalSubject: {
							kind: "directories",
							paths: input.paths,
						},
					};
				},
			},
			audit: {
				summarizeInput(input) {
					return { paths: parseCreateDirectoriesInput(input).paths };
				},
			},
		},
		{
			tool: runCommand,
			capabilities: [
				{ kind: "process.execute", scope: "structured-npm-project-commands" },
				{ kind: "fs.write", scope: "workspace-command-side-effects" },
				{ kind: "network.access", scope: "command-dependent-network-access" },
			],
			defaultPermission: "allow",
			authorization: {
				async prepare(context) {
					let plan: ControlledCommandPlan;
					try {
						plan = await dependencies.commandManager.prepare(
							context.input as Record<string, unknown>,
						);
					} catch (error) {
						return {
							kind: "deny" as const,
							reason: commandAuthorizationDenial(error, dependencies.workspaceRoot),
						};
					}
					return {
						kind: "ready",
						approvalSubject: {
							kind: "command",
							command: commandPlanApprovalSummary(plan),
						},
						grant: () =>
							dependencies.commandManager.approve(
								context.toolCallId,
								plan,
							),
					};
				},
			},
			audit: {
				summarizeInput(input) {
					const args = Array.isArray(input.args) ? input.args : [];
					const argumentSummary = summarizeAuditText(JSON.stringify(args));
					return {
						operation: input.operation,
						cwd: input.cwd,
						script: input.script,
						mode: input.mode,
						timeoutMs: input.timeoutMs,
						startupWaitMs: input.startupWaitMs,
						lifecycleScripts: input.lifecycleScripts,
						argumentCount: args.length,
						argumentsBytes: argumentSummary.bytes,
						argumentsHash: argumentSummary.sha256,
					};
				},
			},
			context: {
				maxBytes: 64 * 1024,
				history: "compact",
				project: projectCommandResult,
			},
			guidance: [
				"Never claim run_command is an operating-system sandbox; executed project scripts can access the workspace and network.",
				"Command path and manifest checks assume a cooperative workspace; concurrent external replacement during preparation or launch is unsupported.",
			],
		},
		{
			tool: commandStatus,
			capabilities: [{ kind: "process.inspect", scope: "managed-project-commands" }],
			defaultPermission: "allow",
			context: { history: "compact" },
		},
		{
			tool: stopCommand,
			capabilities: [
				{ kind: "process.terminate", scope: "managed-project-command-tree" },
			],
			defaultPermission: "allow",
			authorization: {
				prepare(context) {
					const processId = context.input.processId;
					if (typeof processId !== "string") {
						return {
							kind: "deny",
							reason: "stop_command processId is invalid",
						};
					}
					return {
						kind: "ready",
						approvalSubject: {
							kind: "process_stop",
							process: dependencies.commandManager.getProcess(processId),
						},
					};
				},
			},
		},
		{
			tool: gitStatus,
			capabilities: [{ kind: "git.read", scope: "workspace" }],
			defaultPermission: "allow",
			context: { history: "compact" },
		},
		{
			tool: gitDiff,
			capabilities: [{ kind: "git.read", scope: "workspace" }],
			defaultPermission: "allow",
			context: { history: "compact" },
		},
		{
			tool: gitLog,
			capabilities: [{ kind: "git.read", scope: "workspace" }],
			defaultPermission: "allow",
			context: { history: "compact" },
		},
		{
			tool: gitShow,
			capabilities: [{ kind: "git.read", scope: "workspace" }],
			defaultPermission: "allow",
			context: { history: "compact" },
		},
		{
			tool: gitBlame,
			capabilities: [{ kind: "git.read", scope: "workspace" }],
			defaultPermission: "allow",
			context: { history: "compact" },
		},
		{
			tool: runTask,
			capabilities: [{ kind: "process.execute", scope: "fixed-logos-agent-validation" }],
			defaultPermission: "allow",
			context: {
				history: "compact",
				project: projectRunTaskResult,
			},
			authorization: {
				prepare(context) {
					const task = parseRunTaskInput(context.input);
					return {
						kind: "ready",
						approvalSubject: { kind: "task", task: describeRunTask(task) },
					};
				},
			},
		},
	];
	if (dependencies.codeIntelligenceProvider) {
		const provider = dependencies.codeIntelligenceProvider;
		descriptors.push(
			{
				tool: createCodeGraphSearchTool(provider),
				capabilities: [{ kind: "code.inspect", scope: "local-workspace-index" }],
				defaultPermission: "allow",
				audit: {
					summarizeInput(input) {
						const request = parseCodeGraphSearchInput(input);
						const query = summarizeAuditText(request.query);
						return {
							queryBytes: query.bytes,
							queryHash: query.sha256,
							kind: request.kind,
							limit: request.limit,
						};
					},
				},
				context: {
					maxBytes: CODEGRAPH_RESULT_BUDGET_BYTES,
					history: "compact-after-use",
				},
			},
			{
				tool: createCodeGraphNodeTool(provider),
				capabilities: [{ kind: "code.inspect", scope: "local-workspace-index" }],
				defaultPermission: "allow",
				audit: {
					summarizeInput(input) {
						const request = parseCodeGraphNodeInput(input);
						const symbol = request.symbol === undefined
							? undefined
							: summarizeAuditText(request.symbol);
						return {
							file: request.file,
							symbolBytes: symbol?.bytes,
							symbolHash: symbol?.sha256,
							offset: request.offset,
							limit: request.limit,
							symbolsOnly: request.symbolsOnly,
						};
					},
				},
				context: {
					maxBytes: CODEGRAPH_RESULT_BUDGET_BYTES,
					history: "compact-after-use",
				},
			},
			{
				tool: createCodeGraphExploreTool(provider),
				capabilities: [{ kind: "code.inspect", scope: "local-workspace-index" }],
				defaultPermission: "allow",
				audit: {
					summarizeInput(input) {
						const request = parseCodeGraphExploreInput(input);
						const query = summarizeAuditText(request.query);
						return {
							queryBytes: query.bytes,
							queryHash: query.sha256,
							maxFiles: request.maxFiles,
						};
					},
				},
				context: {
					maxBytes: CODEGRAPH_RESULT_BUDGET_BYTES,
					history: "compact-after-use",
				},
			},
			{
				tool: createCodeGraphImpactTool(provider),
				capabilities: [{ kind: "code.inspect", scope: "local-workspace-index" }],
				defaultPermission: "allow",
				audit: {
					summarizeInput(input) {
						const request = parseCodeGraphImpactInput(input);
						const symbol = summarizeAuditText(request.symbol);
						return {
							symbolBytes: symbol.bytes,
							symbolHash: symbol.sha256,
							depth: request.depth,
						};
					},
				},
				context: {
					maxBytes: CODEGRAPH_RESULT_BUDGET_BYTES,
					history: "compact-after-use",
				},
			},
		);
	}
	if (dependencies.webSearchOperations) {
			descriptors.push({
			tool: createWebSearchTool(dependencies.webSearchOperations),
			capabilities: [
				{ kind: "network.search", scope: "public-web-search" },
			],
			defaultPermission: "allow",
			audit: {
				summarizeInput(input) {
					const request = parseWebSearchInput(input);
					const query = summarizeAuditText(request.query);
					return {
						queryBytes: query.bytes,
						queryHash: query.sha256,
						count: request.count,
					};
				},
			},
			context: { maxBytes: 32 * 1024, history: "compact" },
			guidance: [
				"You have live public-web access through web_search. When the user asks to browse, search, research competitors, or verify current information, call web_search before answering; never claim that internet access is unavailable without attempting the tool.",
				"If results are weak or irrelevant, refine the query, search for official project or product names, and clearly distinguish strong evidence from weak search results.",
			],
		});
	}
	return descriptors;
}
