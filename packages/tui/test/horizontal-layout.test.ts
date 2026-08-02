import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HorizontalLayout } from "../src/components/horizontal-layout.ts";
import type { Component } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";

class RecordingComponent implements Component {
	readonly widths: number[] = [];
	invalidated = false;
	private readonly lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(width: number): string[] {
		this.widths.push(width);
		return this.lines;
	}
	invalidate(): void {
		this.invalidated = true;
	}
}

describe("HorizontalLayout", () => {
	it("renders no rows without children or viewport columns", () => {
		assert.deepEqual(new HorizontalLayout().render(80), []);
		const child = new RecordingComponent(["hidden"]);
		assert.deepEqual(new HorizontalLayout([{ component: child }]).render(0), []);
		assert.deepEqual(child.widths, []);
	});

	it("allocates fixed widths, percentage widths, gaps, and flex remainder", () => {
		const fixed = new RecordingComponent(["fixed"]);
		const percent = new RecordingComponent(["percent"]);
		const flex = new RecordingComponent(["flex"]);
		const line = new HorizontalLayout(
			[{ component: fixed, width: 10 }, { component: percent, width: "25%" }, { component: flex }],
			{ gap: 2 },
		).render(80)[0]!;
		assert.deepEqual(fixed.widths, [10]);
		assert.deepEqual(percent.widths, [19]);
		assert.deepEqual(flex.widths, [47]);
		assert.equal(visibleWidth(line), 80);
	});

	it("shrinks preferences without overflowing", () => {
		const left = new RecordingComponent(["left"]);
		const right = new RecordingComponent(["right"]);
		const lines = new HorizontalLayout([
			{ component: left, width: 60 },
			{ component: right, width: 60 },
		]).render(80);
		assert.deepEqual(left.widths, [40]);
		assert.deepEqual(right.widths, [40]);
		assert.equal(visibleWidth(lines[0]!), 80);
	});

	it("reduces gaps before degrading child minimum widths", () => {
		const left = new RecordingComponent(["left"]);
		const right = new RecordingComponent(["right"]);
		new HorizontalLayout(
			[
				{ component: left, minWidth: 5 },
				{ component: right, minWidth: 5 },
			],
			{ gap: 4 },
		).render(10);
		assert.deepEqual(left.widths, [5]);
		assert.deepEqual(right.widths, [5]);
	});

	it("degrades impossible minimums fairly in very narrow viewports", () => {
		const children = [new RecordingComponent(["a"]), new RecordingComponent(["b"]), new RecordingComponent(["c"])];
		const line = new HorizontalLayout(
			children.map((component) => ({ component, minWidth: 5 })),
			{ gap: 4 },
		).render(2)[0]!;
		assert.deepEqual(
			children.map((child) => child.widths),
			[[1], [1], []],
		);
		assert.equal(visibleWidth(line), 2);
	});

	it("composes matching visual rows and bounds ANSI wide-character output", () => {
		const left = new RecordingComponent(["left-0", "left-1"]);
		const right = new RecordingComponent(["right-0", `\x1b[31m${"界".repeat(20)}`]);
		const lines = new HorizontalLayout([
			{ component: left, width: 10 },
			{ component: right, width: 10 },
		]).render(20);
		assert.match(lines[0]!, /left-0.*right-0/);
		assert.equal(visibleWidth(lines[1]!), 20);
	});

	it("closes clipped ST and BEL OSC 8 hyperlinks before the next column", () => {
		for (const terminator of ["\x1b\\", "\x07"] as const) {
			const open = `\x1b]8;;https://example.com${terminator}`;
			const close = `\x1b]8;;${terminator}`;
			const line = new HorizontalLayout(
				[
					{ component: new RecordingComponent([`${open}linked text that overflows`]), width: 8 },
					{ component: new RecordingComponent(["plain"]), width: 8 },
				],
				{ gap: 1 },
			).render(17)[0]!;
			assert.ok(line.indexOf(close) > line.indexOf(open));
			assert.ok(line.indexOf(close) < line.indexOf("plain"));
		}
	});

	it("supports child mutation and invalidation", () => {
		const first = new RecordingComponent(["first"]);
		const second = new RecordingComponent(["second"]);
		const layout = new HorizontalLayout();
		layout.addChild(first, "50%");
		layout.addChild(second, "50%");
		layout.invalidate();
		assert.equal(first.invalidated, true);
		assert.equal(second.invalidated, true);
		layout.removeChild(first);
		assert.doesNotMatch(layout.render(20)[0]!, /first/);
		layout.clear();
		assert.deepEqual(layout.render(20), []);
	});
});
