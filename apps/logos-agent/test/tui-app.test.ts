import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	findCommandSuggestion,
	formatToolActivity,
	highlightDiff,
	LogosAgentUserMessage,
} from "../src/tui-app.ts";
import {
	getToolResultText,
	TranscriptToolBatchBlock,
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
		const lines = new LogosAgentUserMessage("重启了").render(width);
		assert.ok(lines.length > 0);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} exceeds ${width}`);
		}
	}
	assert.match(
		new LogosAgentUserMessage("safe\u001b[31m").render(40).join("\n"),
		/\\u001b/,
	);
});

test("tool activity uses concise semantic titles and hides edit contents", () => {
	const line = formatToolActivity(
		"propose_patch",
		{
			path: "apps/logos-agent/src/tui-app.ts",
			oldText: "secret source".repeat(20),
			newText: "replacement".repeat(20),
		},
		"running",
		80,
	);

	assert.ok(visibleWidth(line) <= 80);
	assert.doesNotMatch(line, /secret source|replacementreplacement/);
	assert.equal(line, "Patch(apps/logos-agent/src/tui-app.ts) · running");

	const createLine = formatToolActivity(
		"propose_create_file",
		{ path: "apps/logos-agent/src/new.ts", content: "private file source" },
		"preparing",
		80,
	);
	assert.doesNotMatch(createLine, /private file source/);
	assert.equal(createLine, "Create(apps/logos-agent/src/new.ts) · preparing");

	const wideLine = formatToolActivity("read_file", { path: "中文路径".repeat(30) }, "读取中", 40);
	assert.ok(visibleWidth(wideLine) <= 40);
	assert.match(wideLine, /^Read\(/u);

	assert.equal(
		formatToolActivity("run_command", {
			operation: "npm_run",
			script: "typecheck",
			args: ["--pretty", "false"],
		}),
		"Bash(npm run typecheck -- --pretty false)",
	);
	assert.equal(
		formatToolActivity("run_command", {
			operation: "npm_run",
			script: "test",
			args: ["hello world", "&&"],
			cwd: "apps/example",
		}),
		'Bash(npm run test -- argv=["hello world","&&"]) @ apps/example',
	);
	assert.match(
		formatToolActivity("run_command", {
			operation: "npm_run",
			script: "typecheck",
			args: ["safe\u001b[31m"],
		}),
		/\\u001b/u,
	);
	assert.equal(
		stripVTControlCharacters(formatToolActivity("apply_edit", { proposalId: "1f6017aa-4249-4302-a7bb-e4a38959cad3" })),
		"Apply(1f6017aa-42…)",
	);
});

test("collapsed command block shows a bounded tail instead of the status envelope", () => {
	const block = new TranscriptToolBlock("run_command", {
		operation: "npm_run",
		script: "typecheck",
	});
	block.complete(
		{
			content: [{
				type: "text",
				text: [
					"npm run typecheck completed with exit code 0 in 100ms.",
					"stdout:",
					...Array.from({ length: 10 }, (_, index) => `output ${index + 1}`),
					"stderr: (empty)",
				].join("\n"),
			}],
		},
		false,
		100,
	);

	const lines = block.render(60);
	const rendered = lines.join("\n");
	assert.match(rendered, /● Bash\(npm run typecheck\)/u);
	assert.doesNotMatch(rendered, /completed with exit code/u);
	assert.doesNotMatch(rendered, /output 1(?:\D|$)/u);
	assert.match(rendered, /output 3/u);
	assert.match(rendered, /output 10/u);
	assert.match(rendered, /ctrl\+o to expand/u);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 60, `${visibleWidth(line)} exceeds 60`);
	}
});

test("failed and truncated commands keep their status envelope visible", () => {
	const failed = new TranscriptToolBlock("run_command", {
		operation: "npm_run",
		script: "test",
	});
	failed.complete(
		{
			content: [{
				type: "text",
				text: "npm run test exited with exit code 1 in 10ms.\nstdout: (empty)\nstderr:\nboom",
			}],
			details: {
				stage: "completed",
				status: "exited",
				exitCode: 1,
				truncated: false,
			},
		},
		false,
		10,
	);
	const failedText = failed.render(80).join("\n");
	assert.match(failedText, /exit code 1/u);
	assert.match(failedText, /boom/u);

	const truncated = new TranscriptToolBlock("run_task", {
		task: "logos_agent_typecheck",
	});
	truncated.complete(
		{
			content: [{
				type: "text",
				text: "Logos Agent typecheck exited with code 0 in 10ms (output truncated).\nstdout:\nlast line\nstderr: (empty)",
			}],
			details: {
				stage: "completed",
				exitCode: 0,
				truncated: true,
			},
		},
		false,
		10,
	);
	const truncatedText = truncated.render(100).join("\n");
	assert.match(truncatedText, /output truncated/u);
	assert.match(truncatedText, /last line/u);
});

test("tool event block updates in place and expands multiline results", () => {
	const block = new TranscriptToolBlock(
		"read_file",
		{ path: "apps/logos-agent/src/tui-app.ts" },
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

test("apply batch renders repeated edits as one bounded transcript block", () => {
	const block = new TranscriptToolBatchBlock(
		"apply_edit",
		["a", "b", "c", "d"].map((id) => ({
			toolCallId: id,
			args: { proposalId: `${id}-proposal` },
		})),
	);
	for (const [index, id] of ["a", "b", "c", "d"].entries()) {
		block.complete(
			id,
			{
				content: [{
					type: "text",
					text: `Applied delete proposal ${id}-proposal to "src/core/file-${index}.ts".\nPrevious SHA-256: hash-${id}`,
				}],
			},
			false,
			200 + index,
		);
	}

	const collapsedLines = block.render(110);
	const collapsed = stripVTControlCharacters(collapsedLines.join("\n"));
	assert.equal(collapsed.match(/Apply\(4 edits\)/gu)?.length, 1);
	assert.match(collapsed, /src\/core\/file-0\.ts/u);
	assert.match(collapsed, /src\/core\/file-3\.ts/u);
	assert.match(collapsed, /ctrl\+o to expand/u);
	assert.doesNotMatch(collapsed, /Previous SHA-256/u);
	for (const line of collapsedLines) {
		assert.ok(visibleWidth(line) <= 110, `${visibleWidth(line)} exceeds 110`);
	}

	block.setExpanded(true);
	const expandedLines = block.render(50);
	assert.match(stripVTControlCharacters(expandedLines.join("\n")), /Previous SHA-256: hash-d/u);
	for (const line of expandedLines) {
		assert.ok(visibleWidth(line) <= 50, `${visibleWidth(line)} exceeds 50`);
	}
});

test("apply batch keeps an individual failure visible on narrow terminals", () => {
	const block = new TranscriptToolBatchBlock("apply_edit", [
		{ toolCallId: "ok", args: { proposalId: "ok-proposal" } },
		{ toolCallId: "failed", args: { proposalId: "failed-proposal" } },
	]);
	block.complete(
		"ok",
		{ content: [{ type: "text", text: "Applied replace proposal ok-proposal." }] },
		false,
		10,
	);
	block.complete(
		"failed",
		{ content: [{ type: "text", text: "User rejected the requested operation" }] },
		true,
		12,
	);

	const lines = block.render(28);
	assert.match(stripVTControlCharacters(lines.join("\n")), /Apply\(2 edits\)/u);
	block.setExpanded(true);
	assert.match(
		stripVTControlCharacters(block.render(80).join("\n")),
		/User rejected the requested operation/u,
	);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 28, `${visibleWidth(line)} exceeds 28`);
	}
});

test("running apply batch title stays bounded at the minimum terminal width", () => {
	const block = new TranscriptToolBatchBlock("apply_edit", [
		{ toolCallId: "first", args: {} },
		{ toolCallId: "second", args: {} },
	]);
	for (const line of block.render(8)) {
		assert.ok(visibleWidth(line) <= 8, `${visibleWidth(line)} exceeds 8`);
	}
});

test("tool event block sanitizes terminal controls and bounds narrow output", () => {
	const block = new TranscriptToolBlock(
		"grep",
		{ pattern: "很长的查询".repeat(50) },
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
