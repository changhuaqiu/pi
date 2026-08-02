import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { type Component, type Focusable, TUI } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class NumberedLines implements Component {
	count: number;
	wantsKeyRelease?: boolean;
	readonly inputs: string[] = [];
	invalidated = false;
	constructor(count: number) {
		this.count = count;
	}
	render(_width: number): string[] {
		return Array.from({ length: this.count }, (_, index) => `line ${index}`);
	}
	handleInput(data: string): void {
		this.inputs.push(data);
	}
	invalidate(): void {
		this.invalidated = true;
	}
}

describe("ScrollView", () => {
	it("keeps indicators inside a fixed-height, fixed-width viewport", () => {
		const lines = new ScrollView(new NumberedLines(10), 5).render(20);
		assert.equal(lines.length, 5);
		assert.match(lines[0]!, /line 0/);
		assert.match(lines[3]!, /line 3/);
		assert.match(lines[4]!, /↓ 6 more/);
		for (const line of lines) assert.equal(visibleWidth(line), 20);
	});

	it("shows both directions and scrolls to a following bottom", () => {
		const child = new NumberedLines(10);
		const view = new ScrollView(child, 5);
		view.render(20);
		view.handleInput("\x1b[B");
		let lines = view.render(20);
		assert.match(lines[0]!, /↑ 1 more/);
		assert.match(lines[4]!, /↓ 6 more/);
		view.scrollToBottom();
		lines = view.render(20);
		assert.equal(view.getScrollOffset(), 6);
		assert.match(lines[4]!, /line 9/);
		child.count = 12;
		lines = view.render(20);
		assert.equal(view.getScrollOffset(), 8);
		assert.match(lines[4]!, /line 11/);
	});

	it("clamps offsets after content and viewport changes", () => {
		const child = new NumberedLines(10);
		const view = new ScrollView(child, 5);
		view.render(20);
		view.scrollToBottom();
		view.render(20);
		view.maxVisibleLines = 3;
		view.render(20);
		assert.equal(view.getScrollOffset(), 8);
		child.count = 2;
		assert.equal(view.render(20).length, 3);
		assert.equal(view.getScrollOffset(), 0);
	});

	it("uses configurable page sizes and dedicated keybindings", () => {
		const view = new ScrollView(new NumberedLines(30), 10, { pageSize: 15 });
		view.render(20);
		view.handleInput("\x1b[6~");
		assert.equal(view.getScrollOffset(), 15);
		view.handleInput("\x1b[6~");
		assert.equal(view.getScrollOffset(), 21);
		view.handleInput("\x1b[5~");
		assert.equal(view.getScrollOffset(), 6);
	});

	it("keeps bilateral padding and narrow dimensions within bounds", () => {
		const lines = new ScrollView(new NumberedLines(2), 3, { paddingX: 2 }).render(12);
		for (const line of lines) {
			assert.equal(visibleWidth(line), 12);
			assert.equal(line.startsWith("  "), true);
			assert.equal(line.endsWith("  "), true);
		}
		const narrow = new ScrollView(new NumberedLines(3), 1, { paddingX: 5 });
		narrow.render(1);
		narrow.handleInput("\x1b[B");
		assert.equal(visibleWidth(narrow.render(1)[0]!), 1);
	});

	it("closes ST and BEL OSC 8 hyperlinks before right padding", () => {
		for (const terminator of ["\x1b\\", "\x07"] as const) {
			const open = `\x1b]8;;https://example.com${terminator}`;
			const close = `\x1b]8;;${terminator}`;
			const child: Component = { render: () => [`${open}linked text that overflows`], invalidate() {} };
			const line = new ScrollView(child, 1, { paddingX: 2 }).render(12)[0]!;
			assert.ok(line.indexOf(close) > line.indexOf(open));
			assert.ok(line.indexOf(close) < line.lastIndexOf("  "));
		}
	});

	it("delegates focus, invalidation, and non-navigation input", () => {
		const child = new NumberedLines(2) as NumberedLines & Focusable;
		child.focused = false;
		const view = new ScrollView(child, 3);
		view.focused = true;
		view.invalidate();
		view.handleInput("x");
		assert.equal(child.focused, true);
		assert.equal(child.invalidated, true);
		assert.deepEqual(child.inputs, ["x"]);
		view.handleInput("\x1b[B");
		assert.deepEqual(child.inputs, ["x"]);
	});

	it("preserves the child's Kitty key-release opt-in through the focused wrapper", () => {
		const child = new NumberedLines(2);
		child.wantsKeyRelease = true;
		const view = new ScrollView(child, 2);
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		tui.addChild(view);
		tui.start();
		try {
			tui.setFocus(view);
			terminal.sendInput("\x1b[97;1:3u");
			assert.deepEqual(child.inputs, ["\x1b[97;1:3u"]);
		} finally {
			tui.stop();
		}
	});

	it("honors customized scroll bindings", () => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.scroll.down": "ctrl+n" }));
		try {
			const child = new NumberedLines(10);
			const view = new ScrollView(child, 3);
			view.render(20);
			view.handleInput("\x1b[B");
			assert.deepEqual(child.inputs, ["\x1b[B"]);
			view.handleInput("\x0e");
			assert.equal(view.getScrollOffset(), 1);
		} finally {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		}
	});
});
