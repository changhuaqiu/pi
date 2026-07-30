import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	findCommandSuggestion,
	formatToolActivity,
	highlightDiff,
	LearningAgentUserMessage,
} from "../src/tui-app.ts";
import {
	getToolResultText,
	TranscriptToolBlock,
} from "../src/transcript-tool-block.ts";

test("unknown slash commands suggest a command instead of becoming a model prompt", () => {
	assert.equal(
		findCommandSuggestion("/sesions", ["/sessions", "/session", "/help"]),
		"/sessions",
	);
	assert.equal(findCommandSuggestion("/unrelated", ["/sessions", "/help"]), undefined);
});

test("user message box never renders wider than its assigned width", () => {
	for (const width of [20, 80, 270]) {
		const lines = new LearningAgentUserMessage("重启了").render(width);
		assert.ok(lines.length > 0);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} exceeds ${width}`);
		}
	}
	assert.match(
		new LearningAgentUserMessage("safe\u001b[31m").render(40).join("\n"),
		/\\u001b/,
	);
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

	const createLine = formatToolActivity(
		"propose_create_file",
		{ path: "apps/learning-agent/src/new.ts", content: "private file source" },
		"preparing",
		80,
	);
	assert.doesNotMatch(createLine, /private file source/);
	assert.match(createLine, /chars/);

	const wideLine = formatToolActivity("read_file", { path: "中文路径".repeat(30) }, "读取中", 40);
	assert.ok(visibleWidth(wideLine) <= 40);
});

test("tool event block updates in place and expands multiline results", () => {
	const block = new TranscriptToolBlock(
		"read_file",
		{ path: "apps/learning-agent/src/tui-app.ts" },
	);
	block.updateResult({
		content: [{ type: "text", text: "reading source" }],
	});
	const running = block.render(60).join("\n");
	assert.match(running, /●/u);
	assert.match(running, /reading source/u);

	block.complete(
		{
			content: [
				{
					type: "text",
					text: "Read 100 lines\nfirst detail\nsecond detail",
				},
			],
		},
		false,
		1250,
	);
	const collapsed = block.render(60).join("\n");
	assert.match(collapsed, /⎿/u);
	assert.match(collapsed, /Read 100 lines/u);
	assert.match(collapsed, /ctrl\+o to expand/u);
	assert.doesNotMatch(collapsed, /second detail/u);

	block.setExpanded(true);
	const expandedLines = block.render(40);
	assert.equal(block.isExpanded(), true);
	assert.match(expandedLines.join("\n"), /second detail/u);
	for (const line of expandedLines) {
		assert.ok(visibleWidth(line) <= 40, `${visibleWidth(line)} exceeds 40`);
	}
});

test("tool event block sanitizes terminal controls and bounds narrow output", () => {
	const block = new TranscriptToolBlock(
		"search_text",
		{ query: "很长的查询".repeat(50) },
		true,
	);
	block.complete(
		{
			content: [
				{
					type: "text",
					text: `safe\u001b[31m\n${"很长的结果".repeat(100)}`,
				},
			],
		},
		false,
		5,
	);

	const lines = block.render(24);
	assert.match(lines.join("\n"), /\\u001b/u);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 24, `${visibleWidth(line)} exceeds 24`);
	}
});

test("collapsed CJK tool output stays on one row and expanded text preserves spacing", () => {
	const block = new TranscriptToolBlock("workspace_info", {});
	block.complete(
		{
			content: [{ type: "text", text: "中文结果".repeat(100) }],
		},
		false,
		12,
	);
	assert.equal(block.render(32).length, 2);

	assert.equal(
		getToolResultText({
			content: [{ type: "text", text: "  indented\n\n" }],
		}),
		"  indented\n\n",
	);
});

test("approval diff bounds both rendered rows and narrow-terminal line width", () => {
	const diff = Array.from(
		{ length: 100 },
		(_, index) => `+${index} ${"很长的创建内容".repeat(100)}`,
	).join("\n");
	const lines = highlightDiff(diff, 40).split("\n");

	assert.equal(lines.length, 31);
	for (const line of lines) assert.ok(visibleWidth(line) <= 40);
});
