import {
	createApplyEditTool,
	createProposeCreateFileTool,
	createProposeDeleteFileTool,
	createProposePatchTool,
	type ControlledEditManager,
	type EditProposalSummary,
} from "./controlled-edit-tools.ts";
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
	createReadFileTool,
	createSearchTextTool,
	type ReadOnlyWorkspaceOperations,
} from "./read-only-tools.ts";
import {
	createRunTaskTool,
	describeRunTask,
	parseRunTaskInput,
	type RunTaskApprovalSummary,
	type RunTaskOperations,
} from "./run-task-tool.ts";
import {
	type ManagedToolDescriptor,
	type ToolAuthorizationContext,
	type ToolCapability,
} from "./tool-system.ts";
import { summarizeAuditText } from "./tool-security.ts";
import {
	createWorkspaceInfoTool,
	type WorkspaceInfoOperations,
} from "./workspace-info.ts";

export type LearningApprovalSubject =
	| { kind: "edit"; proposal: EditProposalSummary }
	| { kind: "task"; task: RunTaskApprovalSummary }
	| {
			kind: "tool";
			toolName: string;
			capabilities: readonly ToolCapability[];
	  };

export type LearningTool =
	| ReturnType<typeof createWorkspaceInfoTool>
	| ReturnType<typeof createListFilesTool>
	| ReturnType<typeof createReadFileTool>
	| ReturnType<typeof createSearchTextTool>
	| ReturnType<typeof createProposePatchTool>
	| ReturnType<typeof createProposeCreateFileTool>
	| ReturnType<typeof createProposeDeleteFileTool>
	| ReturnType<typeof createApplyEditTool>
	| ReturnType<typeof createGitStatusTool>
	| ReturnType<typeof createGitDiffTool>
	| ReturnType<typeof createGitLogTool>
	| ReturnType<typeof createGitShowTool>
	| ReturnType<typeof createGitBlameTool>
	| ReturnType<typeof createRunTaskTool>;

export interface LearningToolDependencies {
	workspaceRoot: string;
	workspaceInfoOperations: WorkspaceInfoOperations;
	readOperations: ReadOnlyWorkspaceOperations;
	gitOperations: GitOperations;
	runTaskOperations: RunTaskOperations;
	editManager: ControlledEditManager;
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

export function createGenericLearningApprovalSubject(
	context: ToolAuthorizationContext,
): LearningApprovalSubject {
	return {
		kind: "tool",
		toolName: context.toolName,
		capabilities: context.capabilities,
	};
}

export function createLearningToolDescriptors(
	dependencies: LearningToolDependencies,
): ManagedToolDescriptor<LearningTool, LearningApprovalSubject>[] {
	const workspaceInfo = createWorkspaceInfoTool(
		dependencies.workspaceRoot,
		dependencies.workspaceInfoOperations,
	);
	const listFiles = createListFilesTool(dependencies.readOperations);
	const readFile = createReadFileTool(dependencies.readOperations);
	const searchText = createSearchTextTool(dependencies.readOperations);
	const proposePatch = createProposePatchTool(dependencies.editManager);
	const proposeCreateFile = createProposeCreateFileTool(dependencies.editManager);
	const proposeDeleteFile = createProposeDeleteFileTool(dependencies.editManager);
	const applyEdit = createApplyEditTool(dependencies.editManager);
	const gitStatus = createGitStatusTool(dependencies.gitOperations);
	const gitDiff = createGitDiffTool(dependencies.gitOperations);
	const gitLog = createGitLogTool(dependencies.gitOperations);
	const gitShow = createGitShowTool(dependencies.gitOperations);
	const gitBlame = createGitBlameTool(dependencies.gitOperations);
	const runTask = createRunTaskTool(dependencies.runTaskOperations);

	return [
		{
			tool: workspaceInfo,
			capabilities: [{ kind: "workspace.inspect", scope: "workspace" }],
			defaultPermission: "allow",
			guidance: [
				"Use workspace_info for bounded workspace metadata. All tool paths are relative to the injected workspace root.",
			],
		},
		{
			tool: listFiles,
			capabilities: [{ kind: "fs.read", scope: "workspace" }],
			defaultPermission: "allow",
			guidance: ["Use list_files to discover structure, search_text to locate symbols, and read_file for bounded source ranges."],
		},
		{
			tool: readFile,
			capabilities: [{ kind: "fs.read", scope: "workspace" }],
			defaultPermission: "allow",
		},
		{
			tool: searchText,
			capabilities: [{ kind: "fs.read", scope: "workspace" }],
			defaultPermission: "allow",
		},
		{
			tool: proposePatch,
			capabilities: [
				{ kind: "edit.propose", scope: "apps/learning-agent/**" },
				{ kind: "fs.read", scope: "apps/learning-agent/**" },
			],
			defaultPermission: "allow",
			audit: { summarizeInput: summarizePatchInput },
			guidance: [
				"Use propose_patch, propose_create_file, or propose_delete_file to prepare controlled mutations only under apps/learning-agent.",
				"Proposal tools do not write. Call apply_edit with the returned proposalId to request the mutation.",
			],
		},
		{
			tool: proposeCreateFile,
			capabilities: [{ kind: "edit.propose", scope: "apps/learning-agent/**" }],
			defaultPermission: "allow",
			audit: { summarizeInput: summarizeCreateInput },
		},
		{
			tool: proposeDeleteFile,
			capabilities: [
				{ kind: "edit.propose", scope: "apps/learning-agent/**" },
				{ kind: "fs.read", scope: "apps/learning-agent/**" },
			],
			defaultPermission: "allow",
		},
		{
			tool: applyEdit,
			capabilities: [
				{ kind: "fs.read", scope: "apps/learning-agent/**" },
				{ kind: "fs.write", scope: "apps/learning-agent/**" },
				{ kind: "fs.delete", scope: "apps/learning-agent/**" },
			],
			defaultPermission: "ask",
			authorization: {
				prepare(context) {
					const proposalId = context.input.proposalId;
					if (typeof proposalId !== "string") {
						return { kind: "deny", reason: "apply_edit proposalId is invalid" };
					}
					const proposal = dependencies.editManager.getProposal(proposalId);
					return {
						kind: "ready",
						approvalSubject: { kind: "edit", proposal },
						grant: () => dependencies.editManager.approve(proposalId),
					};
				},
			},
			guidance: [
				"apply_edit always requires approval. Never claim an edit succeeded until apply_edit returns success.",
				"The running process must be restarted to load edited code.",
			],
		},
		{
			tool: gitStatus,
			capabilities: [{ kind: "git.read", scope: "workspace" }],
			defaultPermission: "allow",
			guidance: [
				"Git tools are limited to read-only inspection and never modify Git state.",
			],
		},
		{
			tool: gitDiff,
			capabilities: [{ kind: "git.read", scope: "workspace" }],
			defaultPermission: "allow",
		},
		{
			tool: gitLog,
			capabilities: [{ kind: "git.read", scope: "workspace" }],
			defaultPermission: "allow",
		},
		{
			tool: gitShow,
			capabilities: [{ kind: "git.read", scope: "workspace" }],
			defaultPermission: "allow",
		},
		{
			tool: gitBlame,
			capabilities: [{ kind: "git.read", scope: "workspace" }],
			defaultPermission: "allow",
		},
		{
			tool: runTask,
			capabilities: [{ kind: "process.execute", scope: "fixed-learning-agent-validation" }],
			defaultPermission: "ask",
			authorization: {
				prepare(context) {
					const task = parseRunTaskInput(context.input);
					return {
						kind: "ready",
						approvalSubject: { kind: "task", task: describeRunTask(task) },
					};
				},
			},
			guidance: [
				"Use run_task only for its fixed Learning Agent tests or typecheck; it requires user approval.",
				"Never claim to execute arbitrary shell commands.",
			],
		},
	];
}
