import assert from "node:assert/strict";
import { test } from "node:test";
import {
	formatLogosTrace,
	LogosProgress,
} from "../src/logos-progress.ts";

test("logos progress exposes the observe-propose-apply-verify loop", () => {
	const progress = new LogosProgress(1_000);
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

	progress.apply({ type: "approval_resolved", outcome: "approved" }, 2_600);
	progress.apply({ type: "tool_started", toolName: "apply_edit" }, 2_700);
	progress.apply({ type: "tool_finished", toolName: "apply_edit", isError: false }, 2_800);
	progress.apply({ type: "tool_started", toolName: "run_task" }, 2_900);
	progress.apply({ type: "tool_finished", toolName: "run_task", isError: false }, 3_000);
	progress.apply({ type: "turn_finished" }, 3_100);

	const completed = progress.snapshot(9_000);
	assert.equal(completed.phase, "idle");
	assert.equal(completed.elapsedMs, 1_100);
	assert.equal(
		formatLogosTrace(completed),
		"observe 1 / propose 1 / apply 1 / verify 1",
	);
});

test("logos progress preserves failures in the visible trace", () => {
	const progress = new LogosProgress(0);
	progress.apply({ type: "turn_started" }, 10);
	progress.apply({ type: "tool_started", toolName: "run_task" }, 20);
	progress.apply({ type: "tool_finished", toolName: "run_task", isError: true }, 30);
	progress.apply({ type: "turn_aborted" }, 40);

	const snapshot = progress.snapshot(50);
	assert.equal(snapshot.phase, "idle");
	assert.equal(snapshot.failures, 2);
	assert.match(formatLogosTrace(snapshot), /fail 2/);
});

test("failed approval resolution remains visible as a failure", () => {
	const progress = new LogosProgress(0);
	progress.apply({ type: "turn_started" }, 10);
	progress.apply({ type: "approval_requested", subjectKind: "operation" }, 20);
	const snapshot = progress.apply(
		{ type: "approval_resolved", outcome: "failed" },
		30,
	);

	assert.equal(snapshot.phase, "reasoning");
	assert.equal(snapshot.detail, "approval failed");
	assert.equal(snapshot.failures, 1);
});

test("repeated activity updates preserve the phase clock", () => {
	const progress = new LogosProgress(0);
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

test("directory creation is visible as an applied workspace mutation", () => {
	const progress = new LogosProgress(0);
	progress.apply({ type: "turn_started" }, 100);
	const snapshot = progress.apply(
		{ type: "tool_started", toolName: "create_directories" },
		200,
	);

	assert.equal(snapshot.phase, "applying");
	assert.equal(snapshot.detail, "create_directories");
	assert.equal(snapshot.applications, 1);
});

test("controlled commands and process inspection are visible in the logos trace", () => {
	const progress = new LogosProgress(0);
	progress.apply({ type: "turn_started" }, 100);
	const command = progress.apply(
		{ type: "tool_started", toolName: "run_command" },
		200,
	);
	assert.equal(command.phase, "applying");
	assert.equal(command.applications, 1);

	const status = progress.apply(
		{ type: "tool_started", toolName: "command_status" },
		300,
	);
	assert.equal(status.phase, "observing");
	assert.equal(status.observations, 1);
});

test("code intelligence is classified as bounded observation", () => {
	const progress = new LogosProgress(0);
	progress.apply({ type: "turn_started" }, 100);
	const snapshot = progress.apply(
		{ type: "tool_started", toolName: "codegraph_explore" },
		200,
	);

	assert.equal(snapshot.phase, "observing");
	assert.equal(snapshot.observations, 1);
});
