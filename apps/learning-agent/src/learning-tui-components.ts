import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	type SettingsListTheme,
	SettingsList,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import type {
	LearningAgentSessionListItem,
} from "./learning-agent.ts";
import type { LearningApprovalSubject } from "./learning-tools.ts";
import type {
	ToolPermission,
	ToolPolicyInfo,
} from "./tool-system.ts";
import { sanitizeTerminalText } from "./transcript-tool-block.ts";

const approvalViewportRows = 12;
const sessionViewportRows = 10;

const settingsTheme: SettingsListTheme = {
	label: (text, selected) => selected ? chalk.bold.cyan(text) : text,
	value: (text, selected) => selected ? chalk.bold(text) : chalk.dim(text),
	description: chalk.dim,
	cursor: chalk.cyan("> "),
	hint: chalk.dim,
};

function allowedPolicyValues(defaultPermission: ToolPermission): string[] {
	if (defaultPermission === "allow") return ["default", "ask", "deny"];
	if (defaultPermission === "ask") return ["default", "deny"];
	return ["default"];
}

function boundedLine(value: string, width: number): string {
	return truncateToWidth(value, Math.max(1, width), "…");
}

function formatDiffChunk(line: string, chunk: string): string {
	if (line.startsWith("+") && !line.startsWith("+++")) return chalk.green(chunk);
	if (line.startsWith("-") && !line.startsWith("---")) return chalk.red(chunk);
	if (line.startsWith("@@")) return chalk.cyan(chunk);
	if (line.startsWith("diff ") || line.startsWith("---") || line.startsWith("+++")) {
		return chalk.bold(chunk);
	}
	return chalk.dim(chunk);
}

function wrapDiffLine(line: string, width: number): string[] {
	const normalized = line.replace(/\t/g, "    ");
	if (normalized.length === 0) return [formatDiffChunk(line, "")];
	const rows: string[] = [];
	const totalWidth = visibleWidth(normalized);
	let startColumn = 0;
	while (startColumn < totalWidth) {
		let chunk = sliceByColumn(normalized, startColumn, width, true);
		if (chunk.length === 0) {
			chunk = sliceByColumn(normalized, startColumn, width);
		}
		rows.push(formatDiffChunk(line, chunk));
		const chunkWidth = visibleWidth(chunk);
		if (chunkWidth === 0) break;
		startColumn += chunkWidth;
	}
	return rows;
}

function countDiffChanges(lines: readonly string[]): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const line of lines) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		if (line.startsWith("-") && !line.startsWith("---")) deletions++;
	}
	return { additions, deletions };
}

export class LearningApprovalCard implements Component {
	private readonly subject: LearningApprovalSubject;
	private readonly diffLines: string[];
	private renderedDiffLines: string[];
	private scrollOffset = 0;

	constructor(subject: LearningApprovalSubject) {
		this.subject = subject;
		this.diffLines =
			subject.kind === "edit"
				? sanitizeTerminalText(subject.proposal.diff).split(/\r?\n/)
				: [];
		this.renderedDiffLines = this.diffLines;
	}

	scrollLines(delta: number): void {
		this.scrollOffset = this.clampOffset(this.scrollOffset + delta);
	}

	scrollPages(delta: number): void {
		this.scrollLines(delta * approvalViewportRows);
	}

	scrollToStart(): void {
		this.scrollOffset = 0;
	}

	scrollToEnd(): void {
		this.scrollOffset = this.clampOffset(Number.MAX_SAFE_INTEGER);
	}

	getScrollOffset(): number {
		return this.scrollOffset;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const contentWidth = Math.max(1, safeWidth - 4);
		const lines = [
			boundedLine(chalk.bold.yellow("Review before Learning Agent acts"), safeWidth),
		];

		if (this.subject.kind === "edit") {
			const proposal = this.subject.proposal;
			const changes = countDiffChanges(this.diffLines);
			this.renderedDiffLines = this.diffLines.flatMap((line) =>
				wrapDiffLine(line, contentWidth),
			);
			lines.push(
				boundedLine(
					` ${proposal.kind.toUpperCase()}  ${sanitizeTerminalText(proposal.path)}  ${chalk.green(`+${changes.additions}`)} ${chalk.red(`-${changes.deletions}`)}`,
					safeWidth,
				),
			);
			if (proposal.description) {
				lines.push(boundedLine(` Why: ${sanitizeTerminalText(proposal.description)}`, safeWidth));
			}
			lines.push(chalk.dim(boundedLine(` ${"─".repeat(Math.max(1, contentWidth))}`, safeWidth)));

			this.scrollOffset = this.clampOffset(this.scrollOffset);
			const end = Math.min(
				this.scrollOffset + approvalViewportRows,
				this.renderedDiffLines.length,
			);
			for (const line of this.renderedDiffLines.slice(this.scrollOffset, end)) {
				lines.push(`  ${line}`);
			}
			while (lines.length < approvalViewportRows + (proposal.description ? 4 : 3)) {
				lines.push("");
			}
			const rangeStart =
				this.renderedDiffLines.length === 0 ? 0 : this.scrollOffset + 1;
			lines.push(
				chalk.dim(
					boundedLine(
						` ${rangeStart}-${end}/${this.renderedDiffLines.length}  ↑↓ row  PgUp/PgDn page  Home/End`,
						safeWidth,
					),
				),
			);
		} else if (this.subject.kind === "task") {
			const task = this.subject.task;
			lines.push(boundedLine(` Task: ${sanitizeTerminalText(task.label)}`, safeWidth));
			lines.push(boundedLine(` Command: ${sanitizeTerminalText(task.command)}`, safeWidth));
			lines.push(boundedLine(` Cwd: ${sanitizeTerminalText(task.cwd)}`, safeWidth));
			lines.push(boundedLine(` Timeout: ${Math.round(task.timeoutMs / 1000)}s`, safeWidth));
			lines.push(chalk.dim(" This is fixed validation; arbitrary commands are not allowed."));
		} else {
			lines.push(boundedLine(` Tool: ${sanitizeTerminalText(this.subject.toolName)}`, safeWidth));
			for (const capability of this.subject.capabilities) {
				lines.push(
					boundedLine(
						` ${capability.kind}: ${sanitizeTerminalText(capability.scope)}`,
						safeWidth,
					),
				);
			}
		}

		lines.push(chalk.dim(boundedLine(` ${"─".repeat(Math.max(1, contentWidth))}`, safeWidth)));
		lines.push(
			boundedLine(
				` ${chalk.bold.green("[y] approve once")}  ${chalk.bold.red("[n/esc] reject")}`,
				safeWidth,
			),
		);
		return lines.map((line) => boundedLine(line, safeWidth));
	}

	private clampOffset(offset: number): number {
		return Math.max(
			0,
			Math.min(
				offset,
				Math.max(0, this.renderedDiffLines.length - approvalViewportRows),
			),
		);
	}
}

export class LearningSessionPicker implements Component, Focusable {
	private readonly sessions: readonly LearningAgentSessionListItem[];
	private readonly currentSessionId: string;
	private readonly searchInput = new Input();
	private filtered: LearningAgentSessionListItem[];
	private selectedIndex = 0;
	private _focused = false;

	onSelect?: (session: LearningAgentSessionListItem) => void;
	onCancel?: () => void;

	constructor(
		sessions: readonly LearningAgentSessionListItem[],
		currentSessionId: string,
	) {
		this.sessions = sessions;
		this.currentSessionId = currentSessionId;
		this.filtered = [...sessions];
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	setQuery(query: string): void {
		this.searchInput.setValue(query);
		this.updateFilter();
	}

	getFilteredCount(): number {
		return this.filtered.length;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up")) {
			this.selectedIndex =
				this.filtered.length === 0
					? 0
					: (this.selectedIndex - 1 + this.filtered.length) % this.filtered.length;
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.selectedIndex =
				this.filtered.length === 0
					? 0
					: (this.selectedIndex + 1) % this.filtered.length;
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
			const selected = this.filtered[this.selectedIndex];
			if (selected) this.onSelect?.(selected);
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}
		this.searchInput.handleInput(data);
		this.updateFilter();
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines = [
			boundedLine(chalk.bold.cyan("Resume a learning session"), safeWidth),
			boundedLine(chalk.dim(" Search by prompt, date, or session id"), safeWidth),
			...this.searchInput.render(safeWidth),
			"",
		];
		if (this.filtered.length === 0) {
			lines.push(chalk.dim(" No matching sessions"));
		} else {
			const start = Math.max(
				0,
				Math.min(
					this.selectedIndex - Math.floor(sessionViewportRows / 2),
					Math.max(0, this.filtered.length - sessionViewportRows),
				),
			);
			const end = Math.min(start + sessionViewportRows, this.filtered.length);
			for (let index = start; index < end; index++) {
				const session = this.filtered[index];
				if (!session) continue;
				const selected = index === this.selectedIndex;
				const current = session.id === this.currentSessionId ? "*" : " ";
				const date = sanitizeTerminalText(session.createdAt.slice(0, 10));
				const id = sanitizeTerminalText(session.id.slice(0, 10));
				const preview = sanitizeTerminalText(session.preview) || "(empty session)";
				const prefix = selected ? ">" : " ";
				const line = `${prefix}${current} ${date}  ${id}  ${session.messageCount} msgs  ${preview}`;
				lines.push(
					selected
						? chalk.bold.cyan(boundedLine(line, safeWidth))
						: boundedLine(line, safeWidth),
				);
			}
			if (this.filtered.length > sessionViewportRows) {
				lines.push(
					chalk.dim(
						boundedLine(
							` ${this.selectedIndex + 1}/${this.filtered.length}`,
							safeWidth,
						),
					),
				);
			}
		}
		lines.push(chalk.dim(boundedLine(" Enter resume  Esc cancel  * current", safeWidth)));
		return lines.map((line) =>
			visibleWidth(line) <= safeWidth ? line : boundedLine(line, safeWidth),
		);
	}

	private updateFilter(): void {
		const query = this.searchInput.getValue().trim().toLowerCase();
		this.filtered = query
			? this.sessions.filter((session) =>
					[
						session.id,
						session.createdAt,
						session.preview,
					].some((value) => value.toLowerCase().includes(query)),
				)
			: [...this.sessions];
		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, this.filtered.length - 1),
		);
	}
}

export class LearningToolPolicyPicker implements Component {
	private readonly settings: SettingsList;

	constructor(
		policies: readonly ToolPolicyInfo[],
		onChange: (toolName: string, permission: ToolPermission | undefined) => void,
		onCancel: () => void,
	) {
		this.settings = new SettingsList(
			policies.map((policy) => ({
				id: policy.name,
				label: sanitizeTerminalText(policy.name),
				description: [
					`Default: ${policy.defaultPermission}.`,
					...policy.capabilities.map(
						(capability) =>
							`${capability.kind}: ${sanitizeTerminalText(capability.scope)}`,
					),
				].join(" "),
				currentValue:
					policy.effectivePermission === policy.defaultPermission
						? "default"
						: policy.effectivePermission,
				values: allowedPolicyValues(policy.defaultPermission),
			})),
			10,
			settingsTheme,
			(toolName, value) => {
				onChange(
					toolName,
					value === "default" ? undefined : value as ToolPermission,
				);
			},
			onCancel,
			{ enableSearch: true },
		);
	}

	handleInput(data: string): void {
		this.settings.handleInput(data);
	}

	invalidate(): void {
		this.settings.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		return [
			boundedLine(chalk.bold.cyan("Learning Agent tool policy"), safeWidth),
			boundedLine(
				chalk.dim("Control which evidence and actions are available to the model."),
				safeWidth,
			),
			"",
			...this.settings.render(safeWidth),
		].map((line) => boundedLine(line, safeWidth));
	}
}
