import {
	Container,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import chalk from "chalk";

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
		: truncateToWidth(compact, maxLength, "…");
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

export function formatToolActivity(
	toolName: string,
	args: Record<string, unknown>,
	progress?: string,
	maxLength = 140,
): string {
	const argumentsText = Object.entries(args)
		.map(([key, value]) => `${key}=${formatToolValue(key, value)}`)
		.join(" ");
	const suffix = progress ? ` · ${compactSingleLine(progress, 80)}` : "";
	return truncateToWidth(
		`${toolName}${argumentsText ? `(${argumentsText})` : ""}${suffix}`,
		maxLength,
		"…",
	);
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
		this.status = isError ? "error" : "completed";
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
		const durationText =
			this.durationMs === undefined ? "" : ` · ${formatDuration(this.durationMs)}`;
		const baseSummaryWidth = Math.max(
			1,
			renderWidth - 2 - visibleWidth("  ⎿ ") - visibleWidth(durationText),
		);
		const hasHiddenDetail =
			lines.length > 1 ||
			visibleWidth(firstLine) > baseSummaryWidth;
		const hintText = hasHiddenDetail
			? renderWidth < 40
				? " (ctrl+o)"
				: " (ctrl+o to expand)"
			: "";
		const summaryWidth = Math.max(
			1,
			baseSummaryWidth - visibleWidth(hintText),
		);
		const duration = chalk.dim(durationText);

		if (!this.expanded) {
			const hint = chalk.dim(hintText);
			const summaryColor = this.status === "error" ? chalk.red : chalk.dim;
			this.output.setText(
				`${chalk.dim("  ⎿ ")}${summaryColor(compactSingleLine(firstLine, summaryWidth))}${duration}${hint}`,
			);
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
