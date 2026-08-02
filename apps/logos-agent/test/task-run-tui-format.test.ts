import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTaskRun } from "../src/tui-app.ts";
import type { TaskRunState } from "../src/task-run.ts";

test("formats TaskRun lifecycle and evidence metrics", () => {
	const run: TaskRunState = {
		id: "run-1",
		sessionId: "session-1",
		goal: "Fix cache accounting",
		status: "terminal",
		phase: "deliver",
		conclusion: "failure",
		completionReason: "verification failed",
		assurance: "unverified",
		manifest: {
			release: "release-b",
			appVersion: "0.1.0",
			features: ["task-run"],
			model: { api: "faux", provider: "faux", id: "test-model" },
			systemPromptHash: "system",
			toolsHash: "tools",
			policyHash: "policy",
			workspaceHash: "workspace",
		},
		evidence: [],
		currentSubjectFingerprint: "workspace",
		sequence: 2,
		startedAt: "2026-07-30T00:00:00.000Z",
		updatedAt: "2026-07-30T00:00:01.000Z",
		completedAt: "2026-07-30T00:00:01.000Z",
		metrics: {
			providerRequests: 2,
			toolCalls: 3,
			approvals: 1,
			changes: 1,
			verifications: 1,
			networkQueries: 2,
			durationMs: 1_000,
		},
	};

	const output = formatTaskRun(run);
	assert.match(
		output,
		/status terminal .* conclusion failure .* assurance unverified/,
	);
	assert.match(output, /requests 2 .* tools 3 .* approvals 1/);
	assert.match(output, /web 2/);
	assert.match(output, /reason verification failed/);
});
