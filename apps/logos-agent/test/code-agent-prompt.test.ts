import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTool } from "../../../packages/agent/src/index.ts";
import { codeAgentSystemPrompt } from "../src/code-agent-prompt.ts";
import { ToolSystem } from "../src/tool-system.ts";
import { buildBaseSystemPrompt } from "../src/workspace-instructions.ts";

test("core prompt defines an end-to-end coding agent contract", () => {
	assert.match(codeAgentSystemPrompt, /autonomous coding agent/);
	assert.match(codeAgentSystemPrompt, /investigate, implement, verify/);
	assert.match(codeAgentSystemPrompt, /Do not stop after describing a plan/);
	assert.match(codeAgentSystemPrompt, /read authoritative files before editing/);
	assert.match(codeAgentSystemPrompt, /use its actual output to diagnose the cause/);
	assert.match(codeAgentSystemPrompt, /rerun the relevant verification/);
	assert.match(codeAgentSystemPrompt, /state exactly what was not run and why/);
	assert.match(codeAgentSystemPrompt, /Review the final diff and behavior/);
	assert.match(codeAgentSystemPrompt, /Never claim that a file changed/);
});

test("core prompt distinguishes ordinary turns from execution tasks", () => {
	assert.match(codeAgentSystemPrompt, /conversation turns/);
	assert.match(codeAgentSystemPrompt, /execution tasks/);
	assert.match(codeAgentSystemPrompt, /Answer them directly and stop/);
	assert.match(codeAgentSystemPrompt, /Own the task end to end/);
});

test("core prompt stays independent from concrete tool names", () => {
	for (const toolName of [
		"plan_task",
		"finish_task",
		"read_file",
		"propose_patch",
		"run_command",
	]) {
		assert.doesNotMatch(codeAgentSystemPrompt, new RegExp(toolName));
	}
});

test("workspace instructions remain a later, explicit policy layer", () => {
	const toolSystem = new ToolSystem<AgentTool, string>({
		workspaceRoot: "C:\\workspace",
		async requestApproval() {
			return false;
		},
		createGenericApprovalSubject() {
			return "approval";
		},
		async recordAudit() {},
	});
	const prompt = toolSystem.buildSystemPrompt(
		buildBaseSystemPrompt(codeAgentSystemPrompt, "Run the project checks."),
	);

	assert.ok(prompt.indexOf("<operating-contract>") < prompt.indexOf("<workspace-instructions"));
	assert.ok(prompt.indexOf("<workspace-instructions") < prompt.indexOf("<tool-policy>"));
	assert.match(prompt, /Run the project checks/);
	assert.match(prompt, /cannot expand or override application-enforced tool permissions/);
});
