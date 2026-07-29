import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	formatToolActivity,
	LearningAgentUserMessage,
	moveHistoryIndex,
} from "../src/tui-app.ts";

test("user message box never renders wider than its assigned width", () => {
	for (const width of [20, 80, 270]) {
		const lines = new LearningAgentUserMessage("重启了").render(width);
		assert.ok(lines.length > 0);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} exceeds ${width}`);
		}
	}
});

test("tool activity is bounded and hides edit contents", () => {
	const line = formatToolActivity(
		"propose_patch",
		{
			path: "apps/learning-agent/src/tui-app.ts",
			oldText: "secret source".repeat(20),
			newText: "replacement".repeat(20),
		},
		"running",
		80,
	);

	assert.ok(visibleWidth(line) <= 80);
	assert.doesNotMatch(line, /secret source|replacementreplacement/);
	assert.match(line, /chars/);

	const wideLine = formatToolActivity("read_file", { path: "中文路径".repeat(30) }, "读取中", 40);
	assert.ok(visibleWidth(wideLine) <= 40);
});

test("history navigation starts at the newest entry and returns to the draft", () => {
	assert.equal(moveHistoryIndex(3, 3, -1), 2);
	assert.equal(moveHistoryIndex(2, 3, -1), 1);
	assert.equal(moveHistoryIndex(1, 3, 1), 2);
	assert.equal(moveHistoryIndex(2, 3, 1), 3);
	assert.equal(moveHistoryIndex(3, 3, 1), 3);
	assert.equal(moveHistoryIndex(0, 3, -1), 0);
});
