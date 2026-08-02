import { getKeybindings } from "../keybindings.ts";
import { type Component, type Focusable, isFocusable } from "../tui.ts";
import { terminateAnsiState, truncateToWidth } from "../utils.ts";

export type ScrollPageSize = number | "half";

export interface ScrollViewTheme {
	scrollUpIndicator: (text: string) => string;
	scrollDownIndicator: (text: string) => string;
}

export interface ScrollViewOptions {
	paddingX?: number;
	theme?: ScrollViewTheme;
	pageSize?: ScrollPageSize;
}

const DEFAULT_THEME: ScrollViewTheme = {
	scrollUpIndicator: (text) => text,
	scrollDownIndicator: (text) => text,
};

/** Fixed-height, vertically scrollable viewport around any child component. */
export class ScrollView implements Component, Focusable {
	readonly child: Component;
	private viewportHeight: number;
	private readonly paddingX: number;
	private readonly theme: ScrollViewTheme;
	private readonly pageSize: ScrollPageSize;
	private scrollOffset = 0;
	private lastTotalLines?: number;
	private followBottom = false;
	private focusedValue = false;

	constructor(child: Component, maxVisibleLines: number, options: ScrollViewOptions = {}) {
		this.child = child;
		this.viewportHeight = normalizePositive(maxVisibleLines);
		this.paddingX = normalizeNonNegative(options.paddingX ?? 0);
		this.theme = options.theme ?? DEFAULT_THEME;
		this.pageSize = normalizePageSize(options.pageSize ?? "half");
	}

	get maxVisibleLines(): number {
		return this.viewportHeight;
	}

	set maxVisibleLines(value: number) {
		this.viewportHeight = normalizePositive(value);
		this.clampKnownOffset();
	}

	get focused(): boolean {
		return this.focusedValue;
	}

	set focused(value: boolean) {
		this.focusedValue = value;
		if (isFocusable(this.child)) this.child.focused = value;
	}

	get wantsKeyRelease(): boolean {
		return this.child.wantsKeyRelease === true;
	}

	invalidate(): void {
		this.child.invalidate();
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.scroll.up")) {
			this.moveBy(-1);
			return;
		}
		if (keybindings.matches(data, "tui.scroll.down")) {
			this.moveBy(1);
			return;
		}
		if (keybindings.matches(data, "tui.scroll.pageUp")) {
			this.moveBy(-this.resolvePageSize());
			return;
		}
		if (keybindings.matches(data, "tui.scroll.pageDown")) {
			this.moveBy(this.resolvePageSize());
			return;
		}
		if (keybindings.matches(data, "tui.scroll.home")) {
			this.scrollToTop();
			return;
		}
		if (keybindings.matches(data, "tui.scroll.end")) {
			this.scrollToBottom();
			return;
		}
		this.child.handleInput?.(data);
	}

	scrollToTop(): void {
		this.followBottom = false;
		this.scrollOffset = 0;
	}

	scrollToBottom(): void {
		this.followBottom = true;
		this.clampKnownOffset();
	}

	getScrollOffset(): number {
		return this.scrollOffset;
	}

	render(width: number): string[] {
		const viewportWidth = normalizeNonNegative(width);
		if (viewportWidth === 0) return [];
		const horizontalPadding = Math.min(this.paddingX, Math.floor((viewportWidth - 1) / 2));
		const contentWidth = Math.max(1, viewportWidth - horizontalPadding * 2);
		const childLines = this.child.render(contentWidth);
		this.lastTotalLines = childLines.length;
		if (this.followBottom) this.scrollOffset = maximumOffset(childLines.length, this.viewportHeight);
		else this.clampKnownOffset();

		const window = calculateWindow(childLines.length, this.viewportHeight, this.scrollOffset);
		this.scrollOffset = window.offset;
		const padding = " ".repeat(horizontalPadding);
		const formatLine = (line: string): string =>
			padding + terminateAnsiState(truncateToWidth(line, contentWidth, "", true)) + padding;
		const result: string[] = [];
		if (window.hiddenAbove > 0) result.push(formatLine(this.theme.scrollUpIndicator(`↑ ${window.hiddenAbove} more`)));
		for (const line of childLines.slice(window.offset, window.end)) result.push(formatLine(line));
		const reservedBottomRows = window.hiddenBelow > 0 ? 1 : 0;
		while (result.length < this.viewportHeight - reservedBottomRows) result.push(" ".repeat(viewportWidth));
		if (window.hiddenBelow > 0)
			result.push(formatLine(this.theme.scrollDownIndicator(`↓ ${window.hiddenBelow} more`)));
		return result.slice(0, this.viewportHeight);
	}

	private moveBy(amount: number): void {
		this.followBottom = false;
		this.scrollOffset = Math.max(0, this.scrollOffset + amount);
		this.clampKnownOffset();
	}

	private clampKnownOffset(): void {
		if (this.lastTotalLines !== undefined)
			this.scrollOffset = Math.min(this.scrollOffset, maximumOffset(this.lastTotalLines, this.viewportHeight));
	}

	private resolvePageSize(): number {
		return this.pageSize === "half" ? Math.max(1, Math.floor(this.viewportHeight / 2)) : this.pageSize;
	}
}

interface ScrollWindow {
	offset: number;
	end: number;
	hiddenAbove: number;
	hiddenBelow: number;
}

function calculateWindow(totalLines: number, height: number, requestedOffset: number): ScrollWindow {
	const offset = Math.min(Math.max(0, requestedOffset), maximumOffset(totalLines, height));
	if (totalLines <= height) return { offset: 0, end: totalLines, hiddenAbove: 0, hiddenBelow: 0 };
	if (height === 1) return { offset, end: Math.min(totalLines, offset + 1), hiddenAbove: 0, hiddenBelow: 0 };

	const hiddenAbove = offset;
	const topIndicatorRows = hiddenAbove > 0 ? 1 : 0;
	const rowsAfterTop = height - topIndicatorRows;
	const bottomIndicatorRows = totalLines - offset > rowsAfterTop && rowsAfterTop > 1 ? 1 : 0;
	const contentRows = Math.max(1, height - topIndicatorRows - bottomIndicatorRows);
	const end = Math.min(totalLines, offset + contentRows);
	return { offset, end, hiddenAbove, hiddenBelow: totalLines - end };
}

function maximumOffset(totalLines: number, height: number): number {
	return totalLines <= height ? 0 : Math.max(0, totalLines - (height === 1 ? 1 : height - 1));
}

function normalizeNonNegative(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizePositive(value: number): number {
	return Math.max(1, normalizeNonNegative(value));
}

function normalizePageSize(value: ScrollPageSize): ScrollPageSize {
	return value === "half" ? value : normalizePositive(value);
}
