import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { LearningAgentUserMessage } from "../src/tui-app.ts";

test("user message box never renders wider than its assigned width", () => {
	for (const width of [20, 80, 270]) {
		const lines = new LearningAgentUserMessage("重启了").render(width);
		assert.ok(lines.length > 0);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} exceeds ${width}`);
		}
	}
});
