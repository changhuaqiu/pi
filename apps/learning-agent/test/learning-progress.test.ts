import assert from "node:assert/strict";
import { test } from "node:test";
import {
	formatLearningTrace,
	LearningProgress,
} from "../src/learning-progress.ts";

test("learning progress exposes the observe-propose-apply-verify loop", () => {
	const progress = new LearningProgress(1_000);
	progress.apply({ type: "turn_started" }, 2_000);
	progress.apply({ type: "tool_started", toolName: "read_file" }, 2_100);
	progress.apply({ type: "tool_finished", toolName: "read_file", isError: false }, 2_200);
	progress.apply({ type: "tool_started", toolName: "propose_patch" }, 2_300);
	progress.apply({ type: "approval_requested", subjectKind: "edit" }, 2_400);

	const review = progress.snapshot(2_500);
	assert.equal(review.phase, "reviewing");
	assert.equal(review.observations, 1);
	assert.equal(review.proposals, 1);
	assert.equal(review.applications, 0);
	assert.equal(review.elapsedMs, 500);
	assert.equal(review.phaseElapsedMs, 100);

	progress.apply({ type: "approval_resolved", approved: true }, 2_600);
	progress.apply({ type: "tool_started", toolName: "apply_edit" }, 2_700);
	progress.apply({ type: "tool_finished", toolName: "apply_edit", isError: false }, 2_800);
	progress.apply({ type: "tool_started", toolName: "run_task" }, 2_900);
	progress.apply({ type: "tool_finished", toolName: "run_task", isError: false }, 3_000);
	progress.apply({ type: "turn_finished" }, 3_100);

	const completed = progress.snapshot(9_000);
	assert.equal(completed.phase, "idle");
	assert.equal(completed.elapsedMs, 1_100);
	assert.equal(
		formatLearningTrace(completed),
		"observe 1 / propose 1 / apply 1 / verify 1",
	);
});

test("learning progress preserves failures in the visible trace", () => {
	const progress = new LearningProgress(0);
	progress.apply({ type: "turn_started" }, 10);
	progress.apply({ type: "tool_started", toolName: "run_task" }, 20);
	progress.apply({ type: "tool_finished", toolName: "run_task", isError: true }, 30);
	progress.apply({ type: "turn_aborted" }, 40);

	const snapshot = progress.snapshot(50);
	assert.equal(snapshot.phase, "idle");
	assert.equal(snapshot.failures, 2);
	assert.match(formatLearningTrace(snapshot), /fail 2/);
});

test("repeated activity updates preserve the phase clock", () => {
	const progress = new LearningProgress(0);
	progress.apply({ type: "turn_started" }, 100);
	progress.apply(
		{ type: "phase_changed", phase: "compacting", detail: "compacting…" },
		200,
	);
	progress.apply(
		{ type: "phase_changed", phase: "compacting", detail: "compacting…" },
		700,
	);

	assert.equal(progress.snapshot(1_200).phaseElapsedMs, 1_000);
});
