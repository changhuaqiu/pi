import type { Component } from "../tui.ts";
import { terminateAnsiState, truncateToWidth } from "../utils.ts";

export type HorizontalLayoutWidth = number | `${number}%` | undefined;

export interface HorizontalLayoutSegment {
	component: Component;
	/** Fixed columns, percentage of content width, or omitted for flex. */
	width?: HorizontalLayoutWidth;
	/** Best-effort minimum width. Defaults to one column. */
	minWidth?: number;
}

export interface HorizontalLayoutOptions {
	/** Columns between adjacent children. Reduced before child minimums are degraded. */
	gap?: number;
}

/** Horizontally composes children without exceeding the requested terminal width. */
export class HorizontalLayout implements Component {
	private segments: HorizontalLayoutSegment[];
	private readonly gap: number;

	constructor(segments: HorizontalLayoutSegment[] = [], options: HorizontalLayoutOptions = {}) {
		this.segments = [...segments];
		this.gap = normalizeColumns(options.gap ?? 0);
	}

	addChild(component: Component, width?: HorizontalLayoutWidth, minWidth?: number): void {
		this.segments.push({ component, width, minWidth });
	}

	removeChild(component: Component): void {
		const index = this.segments.findIndex((segment) => segment.component === component);
		if (index !== -1) this.segments.splice(index, 1);
	}

	clear(): void {
		this.segments = [];
	}

	invalidate(): void {
		for (const segment of this.segments) segment.component.invalidate();
	}

	render(width: number): string[] {
		const viewportWidth = normalizeColumns(width);
		if (viewportWidth === 0 || this.segments.length === 0) return [];

		const { widths, gap } = this.allocateWidths(viewportWidth);
		const rendered = this.segments.map((segment, index) =>
			widths[index]! > 0 ? segment.component.render(widths[index]!) : [],
		);
		const height = rendered.reduce((maximum, lines) => Math.max(maximum, lines.length), 0);
		if (height === 0) return [];

		const gapText = " ".repeat(gap);
		const result: string[] = [];
		for (let row = 0; row < height; row += 1) {
			let line = "";
			for (let index = 0; index < rendered.length; index += 1) {
				if (index > 0) line += gapText;
				const segmentWidth = widths[index]!;
				if (segmentWidth === 0) continue;
				line += terminateAnsiState(truncateToWidth(rendered[index]![row] ?? "", segmentWidth, "", true));
			}
			result.push(truncateToWidth(line, viewportWidth, "", true));
		}
		return result;
	}

	private allocateWidths(totalWidth: number): { widths: number[]; gap: number } {
		const minimums = this.segments.map((segment) => normalizeColumns(segment.minWidth ?? 1));
		const gapCount = Math.max(0, this.segments.length - 1);
		const maximumGap = gapCount > 0 ? Math.max(0, Math.floor((totalWidth - sum(minimums)) / gapCount)) : 0;
		const gap = Math.min(this.gap, maximumGap);
		const available = totalWidth - gap * gapCount;
		if (sum(minimums) > available) return { widths: distributeConstrained(available, minimums), gap };

		const widths = minimums.slice();
		const flexIndexes: number[] = [];
		for (let index = 0; index < this.segments.length; index += 1) {
			const requested = this.segments[index]!.width;
			if (requested === undefined) {
				flexIndexes.push(index);
				continue;
			}
			const preferred =
				typeof requested === "number" ? normalizeColumns(requested) : percentageColumns(requested, available);
			widths[index] = Math.max(minimums[index]!, preferred);
		}

		shrinkToFit(widths, minimums, available);
		let remaining = available - sum(widths);
		for (let cursor = 0; remaining > 0 && flexIndexes.length > 0; cursor += 1) {
			widths[flexIndexes[cursor % flexIndexes.length]!]! += 1;
			remaining -= 1;
		}
		return { widths, gap };
	}
}

function normalizeColumns(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function percentageColumns(value: string, available: number): number {
	const match = /^(\d+(?:\.\d+)?)%$/.exec(value);
	return match ? Math.floor((available * Number(match[1])) / 100) : 0;
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

function distributeConstrained(available: number, limits: readonly number[]): number[] {
	const widths = new Array<number>(limits.length).fill(0);
	let remaining = available;
	while (remaining > 0) {
		let progressed = false;
		for (let index = 0; index < limits.length && remaining > 0; index += 1) {
			if (widths[index]! >= limits[index]!) continue;
			widths[index]! += 1;
			remaining -= 1;
			progressed = true;
		}
		if (!progressed) break;
	}
	return widths;
}

function shrinkToFit(widths: number[], minimums: readonly number[], available: number): void {
	let excess = sum(widths) - available;
	while (excess > 0) {
		const shrinkable = widths
			.map((width, index) => ({ index, room: width - minimums[index]! }))
			.filter(({ room }) => room > 0);
		if (shrinkable.length === 0) return;
		const share = Math.max(1, Math.floor(excess / shrinkable.length));
		for (const { index, room } of shrinkable) {
			const reduction = Math.min(room, share, excess);
			widths[index]! -= reduction;
			excess -= reduction;
			if (excess === 0) return;
		}
	}
}
