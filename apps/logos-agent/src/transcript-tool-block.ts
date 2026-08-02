import {
	Container,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { stripVTControlCharacters } from "node:util";

const defaultRenderWidth = 140;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeTerminalText(value: string): string {
	return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
		if (character === "\n" || character === "\t") return character;
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined) return "";
		return codePoint <= 0xffff
			? `\\u${codePoint.toString(16).padStart(4, "0")}`
			: `\\u{${codePoint.toString(16)}}`;
	});
}

function compactSingleLine(value: string, maxLength: number): string {
	const compact = sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
	return visibleWidth(compact) <= maxLength
		? compact
		: stripVTControlCharacters(truncateToWidth(compact, maxLength, "…"));
}

function formatToolValue(key: string, value: unknown): string {
	if (/oldText|newText|content|apiKey|token|password|secret/i.test(key)) {
		return typeof value === "string" ? `<${value.length} chars>` : "<redacted>";
	}
	if (typeof value === "string") return JSON.stringify(compactSingleLine(value, 48));
	try {
		return compactSingleLine(JSON.stringify(value) ?? String(value), 48);
	} catch {
		return "<unserializable>";
	}
}

function stringArgument(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArrayArgument(args: Record<string, unknown>, key: string): string[] {
	const value = args[key];
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function formatCommandTitle(args: Record<string, unknown>): string {
	const operation = stringArgument(args, "operation");
	const cwd = stringArgument(args, "cwd");
	let command: string;
	if (operation === "npm_install") {
		command = `npm install${args.lifecycleScripts === true ? "" : " --ignore-scripts"}`;
	} else if (operation === "npm_run") {
		const script = stringArgument(args, "script") ?? "<script>";
		const commandArgs = stringArrayArgument(args, "args");
		const argumentsDisplay = commandArgs.length === 0
			? ""
			: commandArgs.every((argument) => /^[A-Za-z0-9_./:@%+=,-]+$/u.test(argument))
				? ` -- ${commandArgs.join(" ")}`
				: ` -- argv=${JSON.stringify(commandArgs)}`;
		command = `npm run ${script}${argumentsDisplay}`;
	} else {
		command = "run_command";
	}
	return `Bash(${command})${cwd && cwd !== "." ? ` @ ${cwd}` : ""}`;
}

function formatKnownToolActivity(
	toolName: string,
	args: Record<string, unknown>,
): string | undefined {
	const path = stringArgument(args, "path") ?? ".";
	switch (toolName) {
		case "run_command":
			return formatCommandTitle(args);
		case "run_task": {
			const task = stringArgument(args, "task");
			if (task === "logos_agent_typecheck") return "Bash(node node_modules/typescript/bin/tsc --noEmit -p apps/logos-agent/tsconfig.json)";
			if (task === "logos_agent_test") return "Bash(node --import tsx --test test/*.test.ts)";
			return `Bash(${task ?? "validation task"})`;
		}
		case "read_file": {
			const startLine = typeof args.startLine === "number" ? args.startLine : 1;
			const maxLines = typeof args.maxLines === "number" ? args.maxLines : 200;
			return `Read(${path}:${startLine}-${startLine + maxLines - 1})`;
		}
		case "list_files":
			return `List(${path})`;
		case "grep": {
			const pattern = stringArgument(args, "pattern") ?? "";
			return `Grep(${JSON.stringify(compactSingleLine(pattern, 48))} in ${path})`;
		}
		case "propose_patch":
			return `Patch(${path})`;
		case "propose_create_file":
			return `Create(${path})`;
		case "propose_delete_file":
			return `Delete(${path})`;
		case "apply_edit": {
			const proposalId = stringArgument(args, "proposalId") ?? "proposal";
			return `Apply(${compactSingleLine(proposalId, 12)})`;
		}
		case "create_directories":
			return `Mkdir(${stringArrayArgument(args, "paths").join(", ") || path})`;
		case "git_status":
			return "Git(status)";
		case "git_diff":
			return "Git(diff)";
		case "git_log":
			return "Git(log)";
		case "git_show":
			return `Git(show ${stringArgument(args, "revision") ?? "HEAD"})`;
		case "git_blame":
			return `Git(blame ${path})`;
		case "command_status":
			return `BashStatus(${stringArgument(args, "processId") ?? "all"})`;
		case "stop_command":
			return `BashStop(${stringArgument(args, "processId") ?? "process"})`;
		case "workspace_info":
			return "Workspace(info)";
		case "codegraph_search":
			return `CodeGraphSearch(${JSON.stringify(compactSingleLine(stringArgument(args, "query") ?? "symbol", 48))})`;
		case "codegraph_node":
			return `CodeGraphNode(${JSON.stringify(compactSingleLine(stringArgument(args, "symbol") ?? stringArgument(args, "file") ?? "node", 48))})`;
		case "codegraph_explore":
			return `CodeGraphExplore(${JSON.stringify(compactSingleLine(stringArgument(args, "query") ?? "flow", 48))})`;
		case "codegraph_impact":
			return `CodeGraphImpact(${JSON.stringify(compactSingleLine(stringArgument(args, "symbol") ?? "symbol", 48))})`;
		case "web_search":
			return `WebSearch(${JSON.stringify(compactSingleLine(stringArgument(args, "query") ?? "", 48))})`;
		case "plan_task":
			return `Plan(${compactSingleLine(stringArgument(args, "goal") ?? "task", 56)})`;
		case "reflect_task":
			return `Reflect(${compactSingleLine(stringArgument(args, "decision") ?? "task", 56)})`;
		case "ask_user":
			return `Ask(${compactSingleLine(stringArgument(args, "question") ?? "user", 56)})`;
		default:
			return undefined;
	}
}

export function formatToolActivity(
	toolName: string,
	args: Record<string, unknown>,
	progress?: string,
	maxLength = 140,
): string {
	const knownActivity = formatKnownToolActivity(toolName, args);
	const argumentsText = knownActivity === undefined ? Object.entries(args)
		.map(([key, value]) => `${key}=${formatToolValue(key, value)}`)
		.join(" ") : "";
	const suffix = progress ? ` · ${compactSingleLine(progress, 80)}` : "";
	const activity = sanitizeTerminalText(
		knownActivity ?? `${toolName}${argumentsText ? `(${argumentsText})` : ""}`,
	);
	return truncateToWidth(
		`${activity}${suffix}`,
		maxLength,
		"…",
	);
}

function isCommandTool(toolName: string): boolean {
	return toolName === "run_command" || toolName === "run_task";
}

function commandOutputLines(detail: string, includeStatus: boolean): string[] {
	const lines = detail.split(/\r?\n/);
	const content: string[] = [];
	for (let index = 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (/^(stdout|stderr):\s*\(empty\)$/.test(line)) continue;
		if (/^(stdout|stderr):\s*$/.test(line)) continue;
		content.push(line);
	}
	while (content[0]?.trim() === "") content.shift();
	while (content.at(-1)?.trim() === "") content.pop();
	const status = lines[0] ?? "Completed";
	if (content.length === 0) return [status];
	return includeStatus ? [status, ...content.slice(-8)] : content.slice(-8);
}

function commandResultState(
	toolName: string,
	result: unknown,
): { failed: boolean; truncated: boolean } {
	if (!isCommandTool(toolName) || !isRecord(result) || !isRecord(result.details)) {
		return { failed: false, truncated: false };
	}
	const { details } = result;
	return {
		failed:
			(typeof details.exitCode === "number" && details.exitCode !== 0) ||
			details.status === "timed_out" ||
			details.status === "failed",
		truncated: details.truncated === true,
	};
}

export function getToolResultText(result: unknown): string {
	if (!isRecord(result) || !Array.isArray(result.content)) return "";
	const parts: string[] = [];
	for (const item of result.content) {
		if (!isRecord(item)) continue;
		if (item.type === "text" && typeof item.text === "string") {
			parts.push(item.text);
		} else if (item.type === "image") {
			parts.push("[image]");
		}
	}
	const detail = sanitizeTerminalText(parts.join("\n"));
	return detail.trim() ? detail : "";
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m${seconds}s`;
}

export class TranscriptToolBlock extends Container {
	private readonly title = new Text("", 1, 0);
	private readonly output = new Text("", 1, 0);
	private readonly toolName: string;
	private readonly args: Record<string, unknown>;
	private expanded: boolean;
	private detail = "";
	private status: "running" | "completed" | "error" = "running";
	private durationMs?: number;
	private commandStatusVisible = false;

	constructor(
		toolName: string,
		args: Record<string, unknown>,
		expanded = false,
	) {
		super();
		this.toolName = toolName;
		this.args = args;
		this.expanded = expanded;
		this.addChild(this.title);
		this.addChild(this.output);
		this.refresh();
	}

	updateResult(result: unknown): void {
		const detail = getToolResultText(result);
		if (detail.trim()) this.detail = detail;
		this.refresh();
	}

	complete(result: unknown, isError: boolean, durationMs?: number): void {
		const detail = getToolResultText(result);
		if (detail.trim()) this.detail = detail;
		const commandState = commandResultState(this.toolName, result);
		this.status = isError || commandState.failed ? "error" : "completed";
		this.commandStatusVisible = commandState.failed || commandState.truncated;
		this.durationMs = durationMs;
		this.refresh();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.refresh();
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	override render(width: number): string[] {
		this.refresh(width);
		return super.render(width);
	}

	private refresh(renderWidth = defaultRenderWidth): void {
		const call = formatToolActivity(
			this.toolName,
			this.args,
			undefined,
			Math.max(1, renderWidth - 5),
		);
		const bullet =
			this.status === "error"
				? chalk.red("●")
				: this.status === "completed"
					? chalk.green("●")
					: chalk.yellow("●");
		this.title.setText(`${bullet} ${chalk.bold(call)}`);

		const fallback =
			this.status === "running"
				? "Running…"
				: this.status === "error"
					? "Failed"
					: "Completed";
		const detail = this.detail || fallback;
		const lines = detail.split(/\r?\n/);
		const firstLine = lines[0] ?? fallback;
		const commandLines = isCommandTool(this.toolName)
			? commandOutputLines(detail, this.commandStatusVisible)
			: undefined;
		const collapsedLines = commandLines ?? [firstLine];
		const durationText =
			this.durationMs === undefined ? "" : ` · ${formatDuration(this.durationMs)}`;
		const baseSummaryWidth = Math.max(
			1,
			renderWidth - 2 - visibleWidth("  ⎿ ") - visibleWidth(durationText),
		);
		const hasHiddenDetail = commandLines === undefined
			? lines.length > 1 || visibleWidth(firstLine) > baseSummaryWidth
			: commandLines.length > collapsedLines.length || lines.length !== commandLines.length;
		const hintText = hasHiddenDetail
			? renderWidth < 40
				? " (ctrl+o)"
				: " (ctrl+o to expand)"
			: "";
		const duration = chalk.dim(durationText);

		if (!this.expanded) {
			const hint = chalk.dim(hintText);
			const summaryColor = this.status === "error" ? chalk.red : chalk.dim;
			const renderedLines = collapsedLines.map((line, index) => {
				const prefix = index === 0 ? "  ⎿ " : "     ";
				const metadata = index === collapsedLines.length - 1 ? `${duration}${hint}` : "";
				const availableWidth = Math.max(
					1,
					renderWidth - 2 - visibleWidth(prefix) - (index === collapsedLines.length - 1 ? visibleWidth(durationText) + visibleWidth(hintText) : 0),
				);
				return `${chalk.dim(prefix)}${summaryColor(compactSingleLine(line, availableWidth))}${metadata}`;
			});
			this.output.setText(renderedLines.join("\n"));
			return;
		}

		const expandedLines = lines.map((line, index) => {
			const prefix = index === 0 ? "  ⎿ " : "     ";
			const content = this.status === "error" ? chalk.red(line) : line;
			return `${chalk.dim(prefix)}${content}`;
		});
		if (this.durationMs !== undefined) {
			expandedLines[0] = `${expandedLines[0]}${duration}`;
		}
		this.output.setText(expandedLines.join("\n"));
	}
}

interface TranscriptToolBatchEntry {
	toolCallId: string;
	args: Record<string, unknown>;
	status: "running" | "completed" | "error";
	detail: string;
	durationMs?: number;
}

export interface TranscriptToolBatchCall {
	toolCallId: string;
	args: Record<string, unknown>;
}

export interface TranscriptToolCall extends TranscriptToolBatchCall {
	toolName: string;
}

export interface TranscriptToolBatch {
	toolName: string;
	calls: TranscriptToolBatchCall[];
}

const batchableTranscriptTools = new Set(["apply_edit"]);

export function createTranscriptToolBatches(
	calls: readonly TranscriptToolCall[],
): TranscriptToolBatch[] {
	const grouped = new Map<string, TranscriptToolBatchCall[]>();
	for (const call of calls) {
		if (!batchableTranscriptTools.has(call.toolName)) continue;
		const group = grouped.get(call.toolName) ?? [];
		group.push({ toolCallId: call.toolCallId, args: call.args });
		grouped.set(call.toolName, group);
	}
	return [...grouped.entries()]
		.filter(([, group]) => group.length > 1)
		.map(([toolName, group]) => ({ toolName, calls: group }));
}

function formatBatchActivity(toolName: string, count: number): string {
	if (toolName === "apply_edit") return `Apply(${count} edits)`;
	return `${toolName}(${count} calls)`;
}

export class TranscriptToolBatchBlock extends Container {
	private readonly title = new Text("", 1, 0);
	private readonly output = new Text("", 1, 0);
	private readonly toolName: string;
	private readonly entries: TranscriptToolBatchEntry[];
	private expanded: boolean;

	constructor(
		toolName: string,
		calls: readonly TranscriptToolBatchCall[],
		expanded = false,
	) {
		super();
		if (calls.length < 2) throw new Error("A transcript tool batch requires at least two calls");
		this.toolName = toolName;
		this.entries = calls.map((call) => ({
			toolCallId: call.toolCallId,
			args: call.args,
			status: "running",
			detail: "",
		}));
		this.expanded = expanded;
		this.addChild(this.title);
		this.addChild(this.output);
		this.refresh();
	}

	updateResult(toolCallId: string, result: unknown): void {
		const entry = this.getEntry(toolCallId);
		const detail = getToolResultText(result);
		if (detail.trim()) entry.detail = detail;
		this.refresh();
	}

	complete(
		toolCallId: string,
		result: unknown,
		isError: boolean,
		durationMs?: number,
	): void {
		const entry = this.getEntry(toolCallId);
		const detail = getToolResultText(result);
		if (detail.trim()) entry.detail = detail;
		entry.status = isError ? "error" : "completed";
		entry.durationMs = durationMs;
		this.refresh();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.refresh();
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	override render(width: number): string[] {
		this.refresh(width);
		return super.render(width);
	}

	private getEntry(toolCallId: string): TranscriptToolBatchEntry {
		const entry = this.entries.find((candidate) => candidate.toolCallId === toolCallId);
		if (!entry) throw new Error(`Tool call is not part of this transcript batch: ${toolCallId}`);
		return entry;
	}

	private refresh(renderWidth = defaultRenderWidth): void {
		const contentWidth = Math.max(1, renderWidth - 2);
		const hasError = this.entries.some((entry) => entry.status === "error");
		const completed = this.entries.every((entry) => entry.status !== "running");
		const bullet = hasError
			? chalk.red("●")
			: completed
				? chalk.green("●")
				: chalk.yellow("●");
		const title = truncateToWidth(
			formatBatchActivity(this.toolName, this.entries.length),
			Math.max(1, contentWidth - 2),
			"…",
		);
		this.title.setText(`${bullet} ${chalk.bold(title)}`);

		const maxCollapsedEntries = 8;
		const visibleEntries = this.expanded
			? this.entries
			: this.entries.slice(0, maxCollapsedEntries);
		const detailIsHidden =
			this.entries.length > visibleEntries.length ||
			this.entries.some((entry) => entry.detail.split(/\r?\n/).length > 1);
		const rows: string[] = [];
		for (const [entryIndex, entry] of visibleEntries.entries()) {
			const detailLines = entry.detail
				? entry.detail.split(/\r?\n/)
				: [
						entry.status === "running"
							? `${formatToolActivity(this.toolName, entry.args)} running…`
							: entry.status === "error"
								? "Failed"
								: "Completed",
					];
			const renderedDetailLines = this.expanded ? detailLines : detailLines.slice(0, 1);
			for (const [lineIndex, line] of renderedDetailLines.entries()) {
				const isFirstRow = rows.length === 0;
				const prefix = isFirstRow ? "  ⎿ " : "     ";
				const duration =
					lineIndex === 0 && entry.durationMs !== undefined
						? ` · ${formatDuration(entry.durationMs)}`
						: "";
				const isLastCollapsedRow =
					!this.expanded &&
					entryIndex === visibleEntries.length - 1 &&
					lineIndex === renderedDetailLines.length - 1;
				const hint =
					isLastCollapsedRow && detailIsHidden
						? renderWidth < 40
							? " (ctrl+o)"
							: " (ctrl+o to expand)"
						: "";
				const availableWidth = Math.max(
					1,
					contentWidth - visibleWidth(prefix) - visibleWidth(duration) - visibleWidth(hint),
				);
				const color = entry.status === "error" ? chalk.red : chalk.dim;
				rows.push(
					`${chalk.dim(prefix)}${color(compactSingleLine(line, availableWidth))}${chalk.dim(duration)}${chalk.dim(hint)}`,
				);
			}
		}
		if (!this.expanded && this.entries.length > visibleEntries.length) {
			const hidden = this.entries.length - visibleEntries.length;
			rows.push(
				chalk.dim(truncateToWidth(`     … ${hidden} more`, contentWidth, "…")),
			);
		}
		this.output.setText(rows.join("\n"));
	}
}

export class TranscriptThinkingBlock extends Container {
	private readonly content = new Text("", 1, 0);
	private expanded: boolean;
	private thinking = "";

	constructor(expanded = false) {
		super();
		this.expanded = expanded;
		this.addChild(this.content);
	}

	update(thinking: string): void {
		this.thinking = sanitizeTerminalText(thinking).trim();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	override render(width: number): string[] {
		if (!this.thinking || width <= 2) return [];
		const innerWidth = width - 2;
		const available = Math.max(1, innerWidth - 4);
		const lines = this.thinking.split(/\r?\n/);
		if (this.expanded) {
			this.content.setText([
				chalk.cyan("reasoning"),
				...lines.map((line) => `  ${line}`),
			].join("\n"));
		} else {
			const summary = compactSingleLine(lines[0] ?? "", Math.max(1, available - 24));
			this.content.setText(truncateToWidth(
				`${chalk.cyan("reasoning")} ${chalk.dim(summary)} ${chalk.dim("(ctrl+o to expand)")}`,
				innerWidth,
				"",
			),
			);
		}
		return super.render(width);
	}
}
