import assert from "node:assert/strict";
import test from "node:test";
import {
	createPlanTaskTool,
	createReflectTaskTool,
	TaskDeliberationController,
} from "../src/task-deliberation-tool.ts";
import type { ToolCapability } from "../src/tool-system.ts";

const writeCapability: readonly ToolCapability[] = [
	{ kind: "fs.write", scope: "workspace" },
];
const completionCapability: readonly ToolCapability[] = [
	{ kind: "task.complete", scope: "current-task-run" },
];

test("requires a plan before side effects", () => {
	const controller = new TaskDeliberationController();
	controller.beginTurn();
	assert.deepEqual(controller.beforeToolCall({ toolName: "apply_edit" }, writeCapability), {
		block: true,
		reason: "Create a task plan with plan_task before using apply_edit",
	});
});

test("requires fresh reflection after side effects before completion", () => {
	const controller = new TaskDeliberationController();
	controller.recordPlan({
			goal: "Change one file",
			steps: ["Apply the edit"],
			verification: ["Run the focused test"],
	});
	assert.equal(controller.beforeToolCall({ toolName: "apply_edit" }, writeCapability), undefined);
	controller.afterToolResult(writeCapability);
	assert.equal(
		controller.beforeToolCall({ toolName: "finish_task" }, completionCapability)?.block,
		true,
	);

	controller.recordReflection({
			decision: "ready",
			evidence: ["Focused test passed"],
			nextAction: "Deliver the result",
	});
	assert.equal(
			controller.beforeToolCall({ toolName: "finish_task" }, completionCapability),
			undefined,
	);
});

test("does not require a plan for read-only tools or simple completion", () => {
	const controller = new TaskDeliberationController();
	controller.beginTurn();
	assert.equal(
			controller.beforeToolCall(
				{ toolName: "read_file" },
				[{ kind: "fs.read", scope: "workspace" }],
			),
			undefined,
	);
	assert.equal(
			controller.beforeToolCall({ toolName: "finish_task" }, completionCapability),
			undefined,
	);
});

test("records plans and reflections through their tools", async () => {
	const controller = new TaskDeliberationController();
	const planTool = createPlanTaskTool(controller);
	const reflectTool = createReflectTaskTool(controller);
	await planTool.execute(
			"plan-1",
			{
				goal: "Implement safely",
				steps: ["Inspect", "Edit"],
				verification: ["Typecheck"],
			},
	);
	await reflectTool.execute(
			"reflect-1",
			{
				decision: "continue",
				evidence: ["Inspection complete"],
				nextAction: "Apply the edit",
			},
	);
	assert.deepEqual(controller.snapshot(), {
		plan: { goal: "Implement safely", steps: ["Inspect", "Edit"], verification: ["Typecheck"], risks: [] },
		reflection: { decision: "continue", evidence: ["Inspection complete"], nextAction: "Apply the edit", risks: [] },
		reflectionRequired: false,
	});
});

test("a later side effect invalidates a previously ready reflection", () => {
	const controller = new TaskDeliberationController();
	controller.recordPlan({
		goal: "Apply two edits",
		steps: ["Apply the first edit", "Apply the second edit"],
		verification: ["Run typecheck"],
	});
	controller.recordReflection({
		decision: "ready",
		evidence: ["First edit passed"],
		nextAction: "Deliver",
	});
	controller.afterToolResult(writeCapability);

	assert.equal(controller.snapshot().reflection, undefined);
	assert.equal(
		controller.beforeToolCall({ toolName: "finish_task" }, completionCapability)?.block,
		true,
	);
});

for (const decision of ["continue", "revise"] as const) {
	test(`${decision} reflection cannot complete a planned task`, () => {
		const controller = new TaskDeliberationController();
		controller.recordPlan({
			goal: "Change one file",
			steps: ["Apply the edit"],
			verification: ["Run the focused test"],
		});
		controller.recordReflection({
			decision,
			evidence: ["More work remains"],
			nextAction: "Continue implementation",
		});
		assert.equal(
			controller.beforeToolCall({ toolName: "finish_task" }, completionCapability)?.block,
			true,
		);
	});
}

test("beginTurn clears plan and reflection from the previous task", () => {
	const controller = new TaskDeliberationController();
	controller.recordPlan({
		goal: "Old task",
		steps: ["Old step"],
		verification: ["Old check"],
	});
	controller.recordReflection({
		decision: "ready",
		evidence: ["Old evidence"],
		nextAction: "Deliver old task",
	});
	controller.beginTurn();

	assert.deepEqual(controller.snapshot(), { reflectionRequired: false });
	assert.equal(
		controller.beforeToolCall({ toolName: "apply_edit" }, writeCapability)?.block,
		true,
	);
});
