import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	Box,
	CombinedAutocompleteProvider,
	Container,
	Editor,
	KeybindingsManager,
	Markdown,
	ProcessTerminal,
	Spacer,
	Text,
	TUI,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { LearningAgent, LearningAgentUiEvent } from "./learning-agent.ts";
import { getMessageText } from "./learning-agent.ts";
import { editorTheme, markdownTheme } from "./theme.ts";

declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"learningAgent.abort": true;
		"learningAgent.approveEdit": true;
		"learningAgent.exit": true;
		"learningAgent.exitIfEmpty": true;
		"learningAgent.rejectEdit": true;
		"learningAgent.historyUp": true;
		"learningAgent.historyDown": true;
	}
}

const appKeybindings = new KeybindingsManager({
	...TUI_KEYBINDINGS,
	"learningAgent.abort": { defaultKeys: "escape", description: "Abort the current turn" },
	"learningAgent.approveEdit": { defaultKeys: "y", description: "Approve the pending edit" },
	"learningAgent.exit": { defaultKeys: "ctrl+d", description: "Exit Learning Agent" },
	"learningAgent.exitIfEmpty": { defaultKeys: "ctrl+c", description: "Exit when the editor is empty" },
	"learningAgent.rejectEdit": { defaultKeys: ["n", "escape"], description: "Reject the pending edit" },
	"learningAgent.historyUp": { defaultKeys: "up", description: "Previous input" },
	"learningAgent.historyDown": { defaultKeys: "down", description: "Next input" },
});

// ── helpers ──────────────────────────────────────────────────────────────────

function sanitizeTerminalText(value: string): string {
	return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
		if (character === "\n" || character === "\t") return character;
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined) return "";
		return codePoint <= 0xffff
			? `\\u${codePoint.toString(16).padStart(4, "0")}`
			: `\\u{${codePoint.toString(16)}}`;
	});
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const mins = Math.floor(ms / 60000);
	const secs = Math.round((ms % 60000) / 1000);
	return `${mins}m${secs}s`;
}

function colorContextPercent(percent: number): string {
	if (percent > 90) return chalk.red(`${percent}%`);
	if (percent >= 70) return chalk.yellow(`${percent}%`);
	return chalk.green(`${percent}%`);
}

function truncateId(id: string, maxLen = 8): string {
	return id.length <= maxLen ? id : `${id.slice(0, maxLen)}…`;
}

// ── diff highlighting ────────────────────────────────────────────────────────

const MAX_DIFF_LINES = 30;

function highlightDiff(diff: string): string {
	const lines = diff.split("\n");
	const displayLines = lines.slice(0, MAX_DIFF_LINES);
	const truncated = lines.length > MAX_DIFF_LINES;

	const highlighted = displayLines.map((line) => {
		if (line.startsWith("+") && !line.startsWith("+++")) return chalk.green(line);
		if (line.startsWith("-") && !line.startsWith("---")) return chalk.red(line);
		if (line.startsWith("@@")) return chalk.cyan(line);
		if (line.startsWith("diff ") || line.startsWith("---") || line.startsWith("+++")) return chalk.bold(line);
		return chalk.dim(line);
	});

	if (truncated) {
		highlighted.push(
			chalk.yellow(`... ${lines.length - MAX_DIFF_LINES} more lines (truncated)`),
		);
	}

	return highlighted.join("\n");
}

// ── approval card ────────────────────────────────────────────────────────────

/**
 * A bordered card that displays an edit proposal with syntax-highlighted diff.
 * Rendered in a dedicated container above the status bar during approval.
 */
class ApprovalCard extends Container {
	constructor(filePath: string, description: string | undefined, diff: string) {
		super();

		// Header line
		const header = chalk.bold.yellow("╔══ Edit Approval ═══════════════════════════════════════");
		this.addChild(new Text(header, 0, 0));

		// File path
		this.addChild(new Text(`  ${chalk.cyan("File:")} ${chalk.white(filePath)}`, 0, 0));
		if (description) {
			this.addChild(new Text(`  ${chalk.dim("Description:")} ${description}`, 0, 0));
		}

		// Separator
		this.addChild(new Text(chalk.dim("  " + "─".repeat(50)), 0, 0));

		// Diff with highlighting
		const highlighted = highlightDiff(diff);
		for (const line of highlighted.split("\n")) {
			this.addChild(new Text(`  ${line}`, 0, 0));
		}

		// Footer with key hints
		this.addChild(new Text(chalk.dim("  " + "─".repeat(50)), 0, 0));
		this.addChild(
			new Text(
				`  ${chalk.bold.green("[y]")} Approve  ${chalk.bold.red("[n]")} Reject  ${chalk.bold.yellow("[esc]")} Reject`,
				0,
				0,
			),
		);
		this.addChild(new Text(chalk.bold.yellow("╚══════════════════════════════════════════════════════════"), 0, 0));
	}
}

// ── command system ───────────────────────────────────────────────────────────

interface Command {
	name: string;
	aliases?: string[];
	description: string;
	usage?: string;
	handler: (args: string) => Promise<string | undefined> | string | undefined;
}

// ── TUI ──────────────────────────────────────────────────────────────────────

export class LearningAgentUserMessage extends Box {
	constructor(text: string) {
		super(1, 1, (line) => chalk.bgCyan.black(line));
		this.addChild(new Text(chalk.black(text), 0, 0));
	}
}

export class LearningAgentTui {
	private readonly agent: LearningAgent;
	private readonly terminal = new ProcessTerminal();
	private readonly tui = new TUI(this.terminal);
	private readonly root = new Container();

	// Layout containers
	private readonly headerContainer = new Container();
	private readonly transcriptContainer = new Container();
	private readonly approvalContainer = new Container();
	private readonly statusContainer = new Container();
	private readonly editorContainer = new Container();

	private readonly editor = new Editor(this.tui, editorTheme);
	private readonly statusText = new Text("", 1, 0);
	private readonly headerText = new Text("", 1, 0);

	private activeAssistant?: Markdown;
	private activeCompaction?: Markdown;
	private done?: () => void;
	private pendingApprovalId?: string;
	private shuttingDown = false;
	private unsubscribeAgent: () => void = () => {};
	private pendingContinue = false;

	// Session metadata for the status bar
	private sessionId = "";
	private modelId = "";
	private messageCount = 0;
	private sessionPath = "";

	// Input history
	private inputHistory: string[] = [];
	private historyIndex = -1;
	private draftBeforeHistory = "";

	// Timing
	private turnStartTime = 0;
	private tokenInput = 0;
	private tokenOutput = 0;

	// Commands
	private readonly commands: Command[];

	private readonly signalHandler = () => {
		void this.requestShutdown();
	};

	constructor(agent: LearningAgent) {
		this.agent = agent;

		this.commands = [
			{
				name: "/help",
				aliases: ["/h", "/?"],
				description: "Show available commands",
				handler: () => this.showHelp(),
			},
			{
				name: "/session",
				aliases: ["/info"],
				description: "Show current session details",
				handler: async () => {
					const info = await this.agent.getSessionInfo();
					this.sessionId = info.id;
					this.sessionPath = info.path;
					this.messageCount = info.messageCount;
					await this.updateStatusBar();
					return `session ${info.id}\npath   ${info.path}\nmessages ${info.messageCount}`;
				},
			},
			{
				name: "/sessions",
				aliases: ["/list"],
				description: "List all sessions",
				handler: async () => {
					const sessions = await this.agent.listSessions();
					if (sessions.length === 0) return "no sessions found";
					const lines = sessions.map((s, i) => {
						const marker = s.id === this.sessionId ? chalk.green("●") : "○";
						const date = s.createdAt.slice(0, 10);
						return `${marker} ${chalk.cyan(truncateId(s.id, 10).padEnd(12))} ${chalk.dim(date)}  ${s.messageCount} msgs`;
					});
					lines.unshift(chalk.bold("Sessions:"));
					lines.push(chalk.dim("\nUse /switch <id> to switch sessions."));
					this.transcriptContainer.addChild(new Text(lines.join("\n"), 1, 1));
					this.tui.requestRender();
					return undefined;
				},
			},
			{
				name: "/switch",
				description: "Switch to another session",
				usage: "/switch <session-id>",
				handler: async (args) => {
					if (!args.trim()) return chalk.red("Usage: /switch <session-id>");
					const id = args.trim();
					this.setBusy(true, "switching session…");
					const info = await this.agent.switchSession(id);
					this.sessionId = info.id;
					this.sessionPath = info.path;
					this.messageCount = info.messageCount;
					this.tokenInput = 0;
					this.tokenOutput = 0;
					this.transcriptContainer.clear();
					this.approvalContainer.clear();
					await this.renderHistory(await this.agent.getMessages());
					await this.updateStatusBar();
					this.updateHeader();
					return `switched to session ${info.id} (${info.messageCount} messages)`;
				},
			},
			{
				name: "/new",
				aliases: ["/reset"],
				description: "Start a new session",
				handler: async () => {
					this.setBusy(true, "creating session…");
					const info = await this.agent.newSession();
					this.sessionId = info.id;
					this.sessionPath = info.path;
					this.messageCount = info.messageCount;
					this.tokenInput = 0;
					this.tokenOutput = 0;
					this.transcriptContainer.clear();
					this.approvalContainer.clear();
					await this.updateStatusBar();
					this.updateHeader();
					return `new session ${info.id}`;
				},
			},
			{
				name: "/compact",
				aliases: ["/zip"],
				description: "Compress conversation history to save context space",
				usage: "/compact [--force]",
				handler: async (args) => {
					const force = args.trim() === "--force";
					if (args.trim() && !force) return chalk.red("Usage: /compact [--force]");
					this.setBusy(true, "compacting…");
					try {
						const result = await this.agent.compact({ force });
						this.setBusy(false);
						await this.updateStatusBar();
						this.updateHeader();
						if (result.status === "not_needed") {
							return `context is only ~${result.tokensBefore} tokens; use /compact --force to compact below 70%`;
						}
						if (result.status === "cancelled") return "compaction cancelled; context unchanged";
						return [
							`compaction complete — ~${result.tokensSaved} tokens saved`,
							`context ~${result.tokensBefore} → ~${result.tokensAfter}`,
							"Use /undo-compact before sending another message to restore the original branch.",
						].join("\n");
					} catch (error) {
						this.setBusy(false);
						throw error;
					} finally {
						this.activeCompaction = undefined;
					}
				},
			},
			{
				name: "/undo-compact",
				aliases: ["/unzip"],
				description: "Restore the immediately preceding compaction",
				handler: async () => {
					this.setBusy(true, "restoring context…");
					try {
						const info = await this.agent.restoreLastCompaction();
						return `original context restored (~${info.tokenCount} / ${info.contextWindow} tokens)`;
					} finally {
						this.setBusy(false);
						await this.updateStatusBar();
					}
				},
			},
			{
				name: "/context",
				aliases: ["/ctx"],
				description: "Show context usage vs model window",
				handler: async () => {
					const info = await this.agent.getContextInfo();
					return `context ~${info.tokenCount} / ${info.contextWindow} tokens (${colorContextPercent(info.percent)})`;
				},
			},
			{
				name: "/clear",
				aliases: ["/cls"],
				description: "Clear the transcript display (session is preserved)",
				handler: () => {
					this.transcriptContainer.clear();
					return undefined; // no extra line needed
				},
			},
			{
				name: "/exit",
				aliases: ["/quit", "/q"],
				description: "Exit Learning Agent",
				handler: async () => {
					await this.requestShutdown();
					return undefined;
				},
			},
		];

		// Build layout
		this.root.addChild(this.headerContainer);
		this.root.addChild(new Spacer(1));
		this.root.addChild(this.transcriptContainer);
		this.root.addChild(new Spacer(1));
		this.root.addChild(this.approvalContainer);
		this.root.addChild(new Spacer(1));
		this.root.addChild(this.statusContainer);
		this.root.addChild(this.editorContainer);

		// Header
		this.headerContainer.addChild(this.headerText);

		// Status bar
		this.statusContainer.addChild(this.statusText);

		// Editor
		// Logo (shown until first message)
		const logo = new Text(
			[
				chalk.bold.cyan("  ╔══════════════════════════════════╗"),
				chalk.bold.cyan("  ║        LEARNING AGENT            ║"),
				chalk.bold.cyan("  ╠══════════════════════════════════╣"),
				chalk.dim("  ║  /help     show commands         ║"),
				chalk.dim("  ║  /context  context usage         ║"),
				chalk.dim("  ║  /compact  compress history      ║"),
				chalk.dim("  ║  /session  current session       ║"),
				chalk.dim("  ║  /sessions list all sessions     ║"),
				chalk.bold.cyan("  ╚══════════════════════════════════╝"),
				"",
			].join("\n"),
			0,
			0,
		);
		this.transcriptContainer.addChild(logo);

		this.editorContainer.addChild(this.editor);

		// Autocomplete: slash commands
		const slashCommands = this.commands.map((cmd) => ({
			name: cmd.name.slice(1), // strip leading /
			description: cmd.description,
		}));
		this.editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(slashCommands, process.cwd()),
		);

		this.tui.addChild(this.root);
		this.tui.setFocus(this.editor);

		this.editor.onSubmit = (text) => {
			void this.handleSubmit(text);
		};

		// Global input listener
		this.tui.addInputListener((data) => {
			// History navigation (only when editor is focused)
			if (appKeybindings.matches(data, "learningAgent.historyUp")) {
				this.navigateHistory(-1);
				return { consume: true };
			}
			if (appKeybindings.matches(data, "learningAgent.historyDown")) {
				this.navigateHistory(1);
				return { consume: true };
			}

			if (this.pendingApprovalId) {
				if (appKeybindings.matches(data, "learningAgent.approveEdit")) {
					this.agent.respondToApproval(this.pendingApprovalId, true);
					return { consume: true };
				}
				if (appKeybindings.matches(data, "learningAgent.rejectEdit")) {
					this.agent.respondToApproval(this.pendingApprovalId, false);
					return { consume: true };
				}
				if (appKeybindings.matches(data, "learningAgent.exit")) {
					void this.requestShutdown();
				}
				return { consume: true };
			}
			if (appKeybindings.matches(data, "learningAgent.exit")) {
				void this.requestShutdown();
				return { consume: true };
			}
			if (
				appKeybindings.matches(data, "learningAgent.exitIfEmpty") &&
				this.editor.getText().length === 0
			) {
				void this.requestShutdown();
				return { consume: true };
			}
			if (!appKeybindings.matches(data, "learningAgent.abort") || !this.agent.isBusy()) return undefined;
			void this.agent.abort();
			return { consume: true };
		});
	}

	// ── lifecycle ──────────────────────────────────────────────────────────

	async run(): Promise<void> {
		// Load session metadata
		const info = await this.agent.getSessionInfo();
		this.sessionId = info.id;
		this.sessionPath = info.path;
		this.messageCount = info.messageCount;
		this.modelId = this.agent.getModelId();
		this.updateHeader();
		await this.updateStatusBar();

		await this.renderHistory(await this.agent.getMessages());

		this.unsubscribeAgent = this.agent.subscribe((event) => this.handleAgentEvent(event));
		process.once("SIGINT", this.signalHandler);
		process.once("SIGTERM", this.signalHandler);
		process.once("SIGHUP", this.signalHandler);
		this.tui.start();
		try {
			await new Promise<void>((resolve) => {
				this.done = resolve;
			});
			await this.agent.waitForIdle();
		} finally {
			this.unsubscribeAgent();
			process.off("SIGINT", this.signalHandler);
			process.off("SIGTERM", this.signalHandler);
			process.off("SIGHUP", this.signalHandler);
			this.tui.stop();
		}
	}

	// ── header & status ─────────────────────────────────────────────────────

	private updateHeader(): void {
		const modelLabel = this.modelId || "?";
		const sessionLabel = truncateId(this.sessionId);
		const msgLabel = `${this.messageCount} msgs`;
		this.headerText.setText(
			chalk.bold.cyan("Learning Agent") +
				chalk.dim(" · ") +
				chalk.dim(`model ${modelLabel}`) +
				chalk.dim(" · ") +
				chalk.dim(`session ${sessionLabel}`) +
				chalk.dim(" · ") +
				chalk.dim(msgLabel),
		);
		this.tui.requestRender();
	}

	private async updateStatusBar(): Promise<void> {
		const parts: string[] = [];
		if (this.modelId) parts.push(chalk.dim(this.modelId));
		if (this.sessionId) parts.push(chalk.dim(`s:${truncateId(this.sessionId)}`));
		if (this.tokenInput > 0 || this.tokenOutput > 0) {
			parts.push(chalk.dim(`↑${this.tokenInput} ↓${this.tokenOutput}`));
		}
		// Show context usage
		try {
			const ctx = await this.agent.getContextInfo();
			if (ctx.contextWindow > 0) {
				parts.push(`ctx ${colorContextPercent(ctx.percent)}`);
			}
		} catch { /* ignore */ }
		const statusLine = parts.join(" │ ");
		this.statusText.setText(statusLine || chalk.dim("idle"));
		this.tui.requestRender();
	}

	// ── history navigation ──────────────────────────────────────────────────

	private navigateHistory(direction: number): void {
		if (this.inputHistory.length === 0) return;

		if (this.historyIndex === -1) {
			this.draftBeforeHistory = this.editor.getText();
		}

		const newIndex = this.historyIndex + direction;
		if (newIndex < -1) return;
		if (newIndex >= this.inputHistory.length) return;

		this.historyIndex = newIndex;
		const text = newIndex === -1 ? this.draftBeforeHistory : this.inputHistory[newIndex];
		this.editor.setText(text);
		this.tui.requestRender();
	}

	// ── command system ──────────────────────────────────────────────────────

	private async showHelp(): Promise<string | undefined> {
		const lines = this.commands.map((cmd) => {
			const names = [cmd.name, ...(cmd.aliases ?? [])].join(", ");
			return `${chalk.cyan(names.padEnd(20))} ${chalk.dim(cmd.description)}`;
		});
		lines.unshift(chalk.bold("Commands:"));
		lines.push("");
		lines.push(chalk.dim("Type /command or just type to chat with the agent."));
		this.transcriptContainer.addChild(new Text(lines.join("\n"), 1, 1));
		this.tui.requestRender();
		return undefined;
	}

	private async executeCommand(input: string): Promise<boolean> {
		const parts = input.split(/\s+/);
		const cmdName = parts[0]!.toLowerCase();
		const args = parts.slice(1).join(" ");

		const cmd = this.commands.find(
			(c) => c.name === cmdName || (c.aliases ?? []).includes(cmdName),
		);
		if (!cmd) return false;

		try {
			const result = await cmd.handler(args);
			if (result !== undefined) {
				this.addSystemLine(result);
			}
		} catch (error) {
			this.addSystemLine(
				chalk.red(`command error: ${error instanceof Error ? error.message : String(error)}`),
			);
		}
		return true;
	}

	// ── rendering ───────────────────────────────────────────────────────────

	private async renderHistory(messages: AgentMessage[]): Promise<void> {
		for (const message of messages) {
			if (message.role === "user") this.addUserMessage(getMessageText(message));
			if (message.role === "assistant") this.addAssistantMessage(getMessageText(message), message.errorMessage);
		}
	}

	private addUserMessage(text: string): void {
		this.transcriptContainer.addChild(new Spacer(1));
		this.transcriptContainer.addChild(new Text(chalk.cyan.bold("You"), 1, 0));
		this.transcriptContainer.addChild(new LearningAgentUserMessage(text));
		this.tui.requestRender();
	}

	private addAssistantMessage(text: string, errorMessage?: string): Markdown {
		const content = errorMessage ? `${text}\n\nError: ${errorMessage}`.trim() : text;
		const component = new Markdown(content, 1, 1, markdownTheme);
		this.transcriptContainer.addChild(new Spacer(1));
		this.transcriptContainer.addChild(new Text(chalk.magenta.bold("Agent"), 1, 0));
		this.transcriptContainer.addChild(component);
		this.tui.requestRender();
		return component;
	}

	private addSystemLine(text: string): void {
		this.transcriptContainer.addChild(new Text(chalk.dim(`─ ${text}`), 1, 0));
		this.tui.requestRender();
	}

	private addToolCallCard(toolName: string, args: Record<string, unknown>): void {
		const summary = Object.entries(args)
			.map(([k, v]) => {
				const sv = typeof v === "string" ? (v.length > 60 ? `${v.slice(0, 57)}…` : v) : JSON.stringify(v);
				return `${chalk.dim(k)}=${chalk.yellow(sv)}`;
			})
			.join(" ");
		this.transcriptContainer.addChild(new Spacer(1));
		this.transcriptContainer.addChild(
			new Text(`${chalk.dim("⚙")} ${chalk.yellow.bold(toolName)} ${summary}`, 1, 1),
		);
		this.tui.requestRender();
	}

	private addToolResultCard(toolName: string, isError: boolean): void {
		const icon = isError ? chalk.red("✖") : chalk.green("✔");
		this.transcriptContainer.addChild(
			new Text(`${icon} ${chalk.dim(toolName)} ${isError ? chalk.red("error") : chalk.green("ok")}`, 1, 2),
		);
		this.tui.requestRender();
	}

	private setBusy(busy: boolean, label = busy ? "thinking…" : "idle"): void {
		this.editor.disableSubmit = busy;
		const stateLabel = busy ? chalk.yellow(label) : chalk.dim(label);
		const sessionPart = chalk.dim(`s:${truncateId(this.sessionId)}`);
		this.statusText.setText(`${stateLabel}  ${sessionPart}`);
		this.tui.requestRender();
	}

	// ── input handling ──────────────────────────────────────────────────────

	private async handleSubmit(rawText: string): Promise<void> {
		const text = rawText.trim();
		if (!text) return;

		// Push to history
		this.inputHistory.push(text);
		this.historyIndex = -1;
		this.draftBeforeHistory = "";
		this.editor.setText("");

		// Try command first
		if (text.startsWith("/")) {
			const handled = await this.executeCommand(text);
			if (handled) return;
			// Unknown command: fall through to send as prompt
			this.addSystemLine(chalk.dim(`Unknown command: ${text.split(/\s+/)[0]}. Sending as prompt…`));
		}

		try {
			this.turnStartTime = Date.now();
			this.setBusy(true);
			await this.agent.prompt(text);
		} catch (error) {
			this.addSystemLine(
				chalk.red(`error: ${error instanceof Error ? error.message : String(error)}`),
			);
		} finally {
			await this.updateStatusBar();

			// Auto-continue: if model hit length limit, send "continue" prompt
			if (this.pendingContinue && !this.shuttingDown) {
				this.pendingContinue = false;
				this.setBusy(true);
				await this.handleSubmit("continue");
				return;
			}

			if (this.agent.isBusy()) {
				this.setBusy(true);
			} else {
				this.setBusy(false);
			}
		}
	}

	private async requestShutdown(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		this.editor.disableSubmit = true;
		this.addSystemLine(chalk.dim("shutting down…"));
		try {
			if (this.agent.isBusy()) await this.agent.abort();
		} catch (error) {
			this.addSystemLine(`shutdown error: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.done?.();
		}
	}

	// ── agent events ────────────────────────────────────────────────────────

	private handleAgentEvent(event: LearningAgentUiEvent): void {
		if (event.type === "compaction_update") {
			if (!this.activeCompaction) {
				this.transcriptContainer.addChild(new Spacer(1));
				this.transcriptContainer.addChild(new Text(chalk.cyan.bold("Compaction"), 1, 0));
				this.activeCompaction = new Markdown("", 1, 1, markdownTheme);
				this.transcriptContainer.addChild(this.activeCompaction);
			}
			this.activeCompaction.setText(sanitizeTerminalText(event.text) || chalk.dim("generating summary…"));
			this.setBusy(
				true,
				event.phase === "committing"
					? "committing compaction…"
					: event.phase === "turn_prefix"
						? "compacting turn prefix…"
						: "compacting…",
			);
			this.tui.requestRender();
			return;
		}
		if (event.type === "approval_request") {
			this.pendingApprovalId = event.request.id;
			const proposal = event.request.proposal;
			// Show approval card in dedicated container
			this.approvalContainer.clear();
			this.approvalContainer.addChild(
				new ApprovalCard(proposal.path, proposal.description, proposal.diff),
			);
			this.statusText.setText(
				chalk.bold.yellow("🔐 Edit approval pending — [y] approve  [n] reject  [esc] reject"),
			);
			this.tui.requestRender();
			return;
		}
		if (event.type === "approval_resolved") {
			if (this.pendingApprovalId === event.requestId) this.pendingApprovalId = undefined;
			// Clear the approval card
			this.approvalContainer.clear();
			this.addSystemLine(event.approved ? chalk.green("✓ edit approved") : chalk.red("✗ edit rejected"));
			this.setBusy(true, "thinking…");
			this.tui.requestRender();
			return;
		}
		if (event.type === "audit") {
			const decision = event.record.decision === "allowed" ? chalk.green("allowed") : chalk.red(event.record.decision);
			this.addSystemLine(`audit ${event.record.toolName}: ${decision}`);
			return;
		}
		if (event.type === "message_start") {
			if (event.message.role === "user") this.addUserMessage(getMessageText(event.message));
			if (event.message.role === "assistant") {
				this.messageCount++;
				this.activeAssistant = this.addAssistantMessage(getMessageText(event.message));
			}
		} else if (event.type === "message_update" && this.activeAssistant) {
			this.activeAssistant.setText(getMessageText(event.message));
			this.tui.requestRender();
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const elapsed = Date.now() - this.turnStartTime;
			const msg = event.message;
			this.activeAssistant?.setText(
				msg.errorMessage
					? `${getMessageText(msg)}\n\nError: ${msg.errorMessage}`.trim()
					: getMessageText(msg),
			);
			this.activeAssistant = undefined;
			if (msg.usage) {
				this.tokenInput += msg.usage.input;
				this.tokenOutput += msg.usage.output;
			}

			// Log stop reason for debugging truncation
			this.addSystemLine(chalk.dim(`[debug] stopReason=${msg.stopReason}`));

			// Auto-continue when model hits output length limit
			if (msg.stopReason === "length" && !this.shuttingDown) {
				this.pendingContinue = true;
				this.addSystemLine(chalk.yellow("response truncated, continuing…"));
				return; // handleSubmit's finally will pick this up
			}

			this.setBusy(false);
			this.addSystemLine(chalk.dim(`turn completed in ${formatDuration(elapsed)}`));
			this.updateHeader();
		} else if (event.type === "tool_execution_start") {
			this.setBusy(true, `tool: ${event.toolName}`);
			this.addToolCallCard(event.toolName, event.args as Record<string, unknown>);
		} else if (event.type === "tool_execution_end") {
			this.addToolResultCard(event.toolName, event.isError);
			this.setBusy(true, "thinking…");
		} else if (event.type === "abort") {
			this.setBusy(false);
			this.addSystemLine(chalk.yellow("turn aborted"));
		}
	}
}
