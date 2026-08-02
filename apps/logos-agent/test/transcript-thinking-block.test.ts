import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TranscriptThinkingBlock } from "../src/transcript-tool-block.ts";

test("thinking block stays within terminal width while streaming", () => {
	const block = new TranscriptThinkingBlock(false);
	block.update(`Inspecting ${"a".repeat(200)}`);
	for (const line of block.render(48)) assert.ok(visibleWidth(line) <= 48);

	block.setExpanded(true);
	block.update(`First ${"b".repeat(200)}\nSecond ${"c".repeat(200)} TAIL_MARKER`);
	for (const line of block.render(48)) assert.ok(visibleWidth(line) <= 48);
	assert.match(block.render(24).join(""), /TAIL_MARKER/);
	for (const line of block.render(8)) assert.ok(visibleWidth(line) <= 8);
	for (const line of block.render(3)) assert.ok(visibleWidth(line) <= 3);
	for (const line of block.render(2)) assert.ok(visibleWidth(line) <= 2);
	for (const line of block.render(1)) assert.ok(visibleWidth(line) <= 1);
});

test("thinking block is hidden until provider reasoning arrives", () => {
	const block = new TranscriptThinkingBlock();
	assert.deepEqual(block.render(80), []);
});
