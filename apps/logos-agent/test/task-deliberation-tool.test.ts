import assert from "node:assert/strict";
import test from "node:test";
import {
	buildReflectionGuidance,
	createPlanTaskTool,
	createReflectTaskTool,
	TaskDeliberationController,
	type TaskPlanSnapshot,
} from "../src/task-deliberation-tool.ts";
import type { TaskRunEvidence, TaskRunState } from "../src/task-run.ts";
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

function runState(
	evidence: TaskRunEvidence[],
	currentSubjectFingerprint = "fp-current",
): TaskRunState {
	return {
		id: "run-1",
		sessionId: "session-1",
		goal: "task goal",
		status: "active",
		phase: "verify",
		assurance: "unverified",
		manifest: {
			release: "test-release",
			appVersion: "0.1.0",
			features: ["task-run"],
			model: { api: "faux", provider: "faux", id: "test-model" },
			systemPromptHash: "s",
			toolsHash: "t",
			policyHash: "p",
			workspaceHash: "w",
		},
		evidence,
		currentSubjectFingerprint,
		sequence: evidence.length + 1,
		startedAt: "2026-07-30T00:00:00.000Z",
		updatedAt: "2026-07-30T00:00:01.000Z",
		metrics: {
			providerRequests: 0,
			toolCalls: 0,
			approvals: 0,
			changes: 0,
			verifications: 0,
			networkQueries: 0,
			durationMs: 0,
		},
	};
}

function changeEvidence(
	id: string,
	paths: string[],
	subjectFingerprint = "fp-current",
): TaskRunEvidence {
	return {
		id,
		kind: "change",
		sourceId: `tool-${id}`,
		outcome: "completed",
		subjectFingerprint,
		metadata: { paths },
		recordedAt: "2026-07-30T00:00:00.000Z",
	};
}

function verificationEvidence(
	id: string,
	outcome: "passed" | "failed",
	subjectFingerprint = "fp-current",
): TaskRunEvidence {
	return {
		id,
		kind: "verification",
		sourceId: `tool-${id}`,
		outcome,
		subjectFingerprint,
		metadata: { task: "logos_agent_test" },
		recordedAt: "2026-07-30T00:00:00.000Z",
	};
}

test("guidance flags declared criteria without matching verification and plan drift", () => {
	const plan: TaskPlanSnapshot = {
		goal: "Refactor the cache module",
		steps: ["Edit one file"],
		verification: ["Typecheck passes"],
		risks: [],
	};
	const run = runState([
		changeEvidence("c1", ["src/a.ts"]),
		changeEvidence("c2", ["src/b.ts"]),
	]);
	const guidance = buildReflectionGuidance(plan, {
		goal: "Refactor the cache module and its tests",
		run,
	});
	assert.equal(guidance.summary.changeSites, 2);
	assert.deepEqual(guidance.summary.changedPaths, ["src/a.ts", "src/b.ts"]);
	assert.equal(guidance.summary.verification, "none");
	assert.equal(guidance.summary.discrepancies.length, 2);
	assert.match(guidance.text, /Original goal: Refactor the cache module and its tests/);
	assert.match(guidance.text, /no verification evidence matches the current workspace state/);
	assert.match(guidance.text, /2 change sites were recorded, but the plan declared only 1 step/);
});

test("guidance reports passing verification against the current state", () => {
	const plan: TaskPlanSnapshot = {
		goal: "Fix the bug",
		steps: ["Edit the file", "Run the test"],
		verification: ["Focused test passes"],
		risks: [],
	};
	const run = runState([
		changeEvidence("c1", ["src/a.ts"]),
		verificationEvidence("v1", "passed"),
	]);
	const guidance = buildReflectionGuidance(plan, { run });
	assert.equal(guidance.summary.verification, "passed");
	assert.deepEqual(guidance.summary.discrepancies, []);
	assert.match(guidance.text, /passed against the current workspace state/);
});

test("guidance flags a failed verification and ignores stale fingerprints", () => {
	const plan: TaskPlanSnapshot = {
		goal: "Verify the fix",
		steps: ["Edit"],
		verification: ["Check passes"],
		risks: [],
	};
	const run = runState([
		verificationEvidence("v-old", "passed", "fp-old"),
		verificationEvidence("v-new", "failed"),
	]);
	const guidance = buildReflectionGuidance(plan, { run });
	assert.equal(guidance.summary.verification, "failed");
	assert.equal(guidance.summary.discrepancies.length, 1);
	assert.match(guidance.text, /FAILED against the current workspace state/);
});

test("guidance without an active run stays minimal", () => {
	const guidance = buildReflectionGuidance(undefined, { goal: "a question" });
	assert.equal(guidance.summary.changeSites, 0);
	assert.equal(guidance.summary.verification, "none");
	assert.deepEqual(guidance.summary.discrepancies, []);
	assert.match(guidance.text, /No execution task is active/);
});

test("guidance truncates long goals and long path lists", () => {
	const longGoal = "g".repeat(600);
	const paths = Array.from({ length: 15 }, (_, index) => `src/file-${index}.ts`);
	const run = runState([changeEvidence("c1", paths)]);
	const guidance = buildReflectionGuidance(undefined, { goal: longGoal, run });
	assert.ok(guidance.text.length < 4_000);
	assert.ok(guidance.text.includes("…"));
	assert.match(guidance.text, /…\(\+5 more\)/);
});

test("reflect_task returns runtime facts alongside the recorded reflection", async () => {
	const controller = new TaskDeliberationController();
	controller.recordPlan({
		goal: "Fix the bug",
		steps: ["Edit the file"],
		verification: ["Focused test passes"],
	});
	const run = runState([changeEvidence("c1", ["src/a.ts"])]);
	const reflectTool = createReflectTaskTool(controller, {
		loadGuidance: async () => ({ goal: "Fix the bug in src/a.ts", run }),
	});
	const result = await reflectTool.execute("reflect-1", {
		decision: "ready",
		evidence: ["Edit applied"],
		nextAction: "Deliver the fix",
	});
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	assert.match(text, /^Reflection recorded: ready\./);
	assert.match(text, /Runtime fact check:/);
	assert.match(text, /Original goal: Fix the bug in src\/a\.ts/);
	assert.equal(result.details.guidance?.verification, "none");
	assert.equal(result.details.decision, "ready");
	assert.equal(controller.snapshot().reflection?.decision, "ready");
});

test("reflect_task records the reflection even when guidance fails", async () => {
	const controller = new TaskDeliberationController();
	const reflectTool = createReflectTaskTool(controller, {
		loadGuidance: async () => {
			throw new Error("guidance unavailable");
		},
	});
	const result = await reflectTool.execute("reflect-1", {
		decision: "continue",
		evidence: ["Still working"],
		nextAction: "Keep implementing",
	});
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	assert.equal(text, "Reflection recorded: continue.");
	assert.equal(result.details.guidance, undefined);
	assert.equal(controller.snapshot().reflection?.decision, "continue");
});
