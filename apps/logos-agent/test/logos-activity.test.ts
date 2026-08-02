import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	describeLogosActivity,
	LogosActivityIndicator,
} from "../src/logos-activity.ts";
import type { LogosProgressSnapshot } from "../src/logos-progress.ts";

function snapshot(
	phase: LogosProgressSnapshot["phase"],
	elapsedMs: number,
	detail?: string,
): LogosProgressSnapshot {
	return {
		phase,
		...(detail === undefined ? {} : { detail }),
		elapsedMs,
		phaseElapsedMs: elapsedMs,
		observations: 0,
		proposals: 0,
		applications: 0,
		verifications: 0,
		failures: 0,
	};
}

test("logos activity animates and rotates phase-specific events", () => {
	const first = describeLogosActivity(snapshot("reasoning", 0));
	const nextFrame = describeLogosActivity(snapshot("reasoning", 120));
	const nextVerb = describeLogosActivity(snapshot("reasoning", 1_800));
	assert.equal(first?.verb, "Nebulizing");
	assert.notEqual(first?.frame, nextFrame?.frame);
	assert.notEqual(first?.verb, nextVerb?.verb);
	assert.equal(first?.timing, "thought for 0s");
	assert.match(first?.secondary ?? "", /^Tip:/);
});

test("logos activity shows concrete tool events and stays bounded", () => {
	const indicator = new LogosActivityIndicator();
	assert.equal(indicator.update(snapshot("observing", 1_250, "read_file")), true);
	const lines = indicator.render(48);
	assert.match(lines.join("\n"), /Inspecting evidence/);
	assert.match(lines.join("\n"), /read_file/);
	assert.match(lines.join("\n"), /worked for 1s/);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 48, `${visibleWidth(line)} exceeds 48`);
	}
	for (const line of indicator.render(18)) {
		assert.ok(visibleWidth(line) <= 18, `${visibleWidth(line)} exceeds 18`);
	}

	assert.equal(indicator.update(snapshot("idle", 2_000)), true);
	assert.deepEqual(indicator.render(48), []);
});

test("logos activity preserves concrete compaction details", () => {
	const description = describeLogosActivity(
		snapshot("compacting", 500, "committing compaction…"),
	);
	assert.equal(description?.secondary, "committing compaction…");
});

test("review activity coalesces sub-second animation frames", () => {
	const indicator = new LogosActivityIndicator();
	assert.equal(
		indicator.update(snapshot("reviewing", 0, "tool approval")),
		true,
	);
	assert.equal(
		indicator.update(snapshot("reviewing", 120, "tool approval")),
		false,
	);
	assert.equal(
		indicator.update(snapshot("reviewing", 1_000, "tool approval")),
		true,
	);
});
