import type { ContextRequestTrace } from "@earendil-works/pi-agent-core";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import {
	analyzeContextRequestTrace,
	type ContextRequestTraceAnalysis,
	type ContextTraceDiff,
	type ContextTraceMessage,
	type ContextTraceSnapshot,
} from "../../../core/context-transform-trace.ts";
import { theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

export class ContextRequestTraceComponent extends Box {
	private expanded = false;
	private readonly requestSequence: number;
	private readonly analysis: ContextRequestTraceAnalysis;

	constructor(requestSequence: number, trace: ContextRequestTrace) {
		super(1, 1, (text) => theme.bg("customMessageBg", text));
		this.requestSequence = requestSequence;
		this.analysis = analyzeContextRequestTrace(trace);
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();
		const label = theme.fg("customMessageLabel", `\x1b[1m[context request #${this.requestSequence}]\x1b[22m`);
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				this.expanded
					? formatExpanded(this.analysis)
					: `${formatCollapsed(this.analysis)} (${keyText("app.tools.expand")} to expand)`,
				0,
				0,
			),
		);
	}
}

function formatCollapsed(analysis: ContextRequestTraceAnalysis): string {
	const transform = analysis.transform;
	return [
		`Agent ${analysis.agentState.messageCount} → ${analysis.transformed.messageCount}`,
		`LLM ${analysis.llm.messageCount}`,
		`~${formatTokens(analysis.agentState.estimatedTokens)} → ~${formatTokens(analysis.finalProviderContext.totalTokens)} tokens`,
		`-${transform.removed.length} +${transform.injected.length} ~${transform.modified.length}`,
	].join(" | ");
}

function formatExpanded(analysis: ContextRequestTraceAnalysis): string {
	const lines = [
		...formatSnapshot("① Agent state", analysis.agentState),
		...formatSnapshot("② After transformContext", analysis.transformed),
		...formatDiff("Transform changes", analysis.transform, {
			removed: "removed",
			injected: "injected",
			modified: "modified",
		}),
		...formatSnapshot("③ After convertToLlm", analysis.llm),
		...formatDiff("Conversion changes", analysis.conversion, {
			removed: "filtered",
			injected: "produced",
			modified: "converted",
		}),
		[
			"④ Final provider context",
			`system=~${formatTokens(analysis.finalProviderContext.systemPromptTokens)}`,
			`tools=~${formatTokens(analysis.finalProviderContext.toolTokens)}`,
			`messages=~${formatTokens(analysis.finalProviderContext.messageTokens)}`,
			`total=~${formatTokens(analysis.finalProviderContext.totalTokens)} tokens`,
		].join(" | "),
	];
	return lines.join("\n");
}

function formatSnapshot(label: string, snapshot: ContextTraceSnapshot): string[] {
	const lines = [
		[
			label,
			`${snapshot.messageCount} messages`,
			`~${formatTokens(snapshot.estimatedTokens)} tokens`,
			`roles: ${formatDistribution(snapshot.roles)}`,
			`content: ${formatDistribution(snapshot.contentTypes)}`,
		].join(" | "),
	];
	for (const message of snapshot.messages) {
		lines.push(formatFullMessage(message));
	}
	return lines;
}

function formatDiff(
	label: string,
	diff: ContextTraceDiff,
	terms: { removed: string; injected: string; modified: string },
): string[] {
	const lines = [`${label}: -${diff.removed.length} +${diff.injected.length} ~${diff.modified.length}`];
	for (const message of diff.removed) {
		lines.push(formatMessage(`  ${terms.removed}`, message));
	}
	for (const message of diff.injected) {
		lines.push(formatMessage(`  ${terms.injected}`, message));
	}
	for (const modification of diff.modified) {
		lines.push(formatMessage(`  ${terms.modified} from`, modification.before));
		lines.push(formatMessage("    to", modification.after));
	}
	return lines;
}

function formatMessage(prefix: string, message: ContextTraceMessage): string {
	const preview = message.preview ? ` ${message.preview}` : "";
	return `${prefix} [${message.index}] ${message.label} ~${formatTokens(message.estimatedTokens)} tokens${preview}`;
}

function formatFullMessage(message: ContextTraceMessage): string {
	const header = `  [${message.index}] ${message.label} ~${formatTokens(message.estimatedTokens)} tokens`;
	if (!message.content) return header;
	return `${header}\n${indent(message.content, "      ")}`;
}

function indent(text: string, prefix: string): string {
	return text
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");
}

function formatDistribution(distribution: Record<string, number>): string {
	const entries = Object.entries(distribution);
	return entries.length > 0 ? entries.map(([key, value]) => `${key}=${value}`).join(" ") : "none";
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return tokens.toString();
	if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
	return `${Math.round(tokens / 1000)}k`;
}
