import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	Box,
	Container,
	Editor,
	KeybindingsManager,
	Markdown,
	type OverlayHandle,
	ProcessTerminal,
	Spacer,
	type Terminal,
	Text,
	TUI,
	TUI_KEYBINDINGS,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import type {
	CacheOperationsReport,
	CacheReleaseComparison,
	LearningAgentCacheStats,
} from "./cache-stats.ts";
import type { LearningAgent, LearningAgentUiEvent } from "./learning-agent.ts";
import { getMessageText } from "./learning-agent.ts";
import { LearningActivityIndicator } from "./learning-activity.ts";
import { LearningAutocompleteProvider } from "./learning-autocomplete.ts";
import {
	describeLearningInput,
	type LearningInputMode,
} from "./learning-input.ts";
import {
	formatLearningTrace,
	LearningProgress,
	type LearningProgressEvent,
	type LearningPhase,
} from "./learning-progress.ts";
import {
	LearningApprovalCard,
	LearningSessionPicker,
	LearningToolPolicyPicker,
} from "./learning-tui-components.ts";
import { editorTheme, markdownTheme } from "./theme.ts";
import {
	sanitizeTerminalText,
	TranscriptToolBlock,
} from "./transcript-tool-block.ts";
import type { TaskRunState } from "./task-run.ts";

export { formatToolActivity } from "./transcript-tool-block.ts";

declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"learningAgent.abort": true;
		"learningAgent.approveEdit": true;
		"learningAgent.exit": true;
		"learningAgent.exitIfEmpty": true;
		"learningAgent.rejectEdit": true;
		"learningAgent.toggleToolDetails": true;
		"learningAgent.approvalUp": true;
		"learningAgent.approvalDown": true;
		"learningAgent.approvalPageUp": true;
		"learningAgent.approvalPageDown": true;
		"learningAgent.approvalHome": true;
		"learningAgent.approvalEnd": true;
	}
}

const appKeybindings = new KeybindingsManager({
	...TUI_KEYBINDINGS,
	"learningAgent.abort": { defaultKeys: "escape", description: "Abort the current turn" },
	"learningAgent.approveEdit": { defaultKeys: "y", description: "Approve the pending operation" },
	"learningAgent.exit": { defaultKeys: "ctrl+d", description: "Exit Learning Agent" },
	"learningAgent.exitIfEmpty": { defaultKeys: "ctrl+c", description: "Exit when the editor is empty" },
	"learningAgent.rejectEdit": {
		defaultKeys: ["n", "escape"],
		description: "Reject the pending operation",
	},
	"learningAgent.toggleToolDetails": {
		defaultKeys: "ctrl+o",
		description: "Toggle tool output details",
	},
	"learningAgent.approvalUp": { defaultKeys: "up", description: "Scroll approval up" },
	"learningAgent.approvalDown": { defaultKeys: "down", description: "Scroll approval down" },
	"learningAgent.approvalPageUp": { defaultKeys: "pageUp", description: "Scroll approval one page up" },
	"learningAgent.approvalPageDown": {
		defaultKeys: "pageDown",
		description: "Scroll approval one page down",
	},
	"learningAgent.approvalHome": { defaultKeys: "home", description: "Go to approval start" },
	"learningAgent.approvalEnd": { defaultKeys: "end", description: "Go to approval end" },
});

// ── helpers ──────────────────────────────────────────────────────────────────

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

function formatCacheRate(rate: number | undefined): string {
	return rate === undefined ? "not reported" : `${rate.toFixed(1)}%`;
}

export function formatCacheOperationsReport(report: CacheOperationsReport): string {
	const scope = report.release ? `release ${report.release}` : "all releases";
	const lines = [
		`cache report (${scope})`,
		`hit rate ${formatCacheRate(report.stats.hitRate)} · telemetry coverage ${formatCacheRate(report.stats.telemetryCoverage)}`,
		`requests ${report.stats.requestCount} · prompt ${report.stats.promptTokens} · read ${report.stats.cacheReadTokens} · write ${report.stats.cacheWriteTokens} · uncached ${report.stats.uncachedInputTokens}`,
	];
	if (report.availableReleases.length > 0) {
		lines.push(`available releases: ${report.availableReleases.join(", ")}`);
	}
	for (const segment of report.segments.slice(0, 5)) {
		lines.push(
			`${segment.stats.hitRate === undefined ? "?" : `${segment.stats.hitRate.toFixed(1)}%`} · ${segment.stats.promptTokens} tokens · ${segment.label}`,
		);
	}
	return lines.join("\n");
}

export function formatCacheReleaseComparison(
	comparison: CacheReleaseComparison,
): string {
	const lines = [
		`cache comparison ${comparison.baselineRelease} → ${comparison.currentRelease}`,
		`hit rate ${formatCacheRate(comparison.baseline.hitRate)} → ${formatCacheRate(comparison.current.hitRate)}${
			comparison.deltaPercentagePoints === undefined
				? ""
				: ` (${comparison.deltaPercentagePoints >= 0 ? "+" : ""}${comparison.deltaPercentagePoints.toFixed(1)}pp)`
		}`,
	];
	if (
		comparison.trafficMixPercentagePoints !== undefined &&
		comparison.withinSegmentPercentagePoints !== undefined
	) {
		lines.push(
			`attribution: traffic mix ${comparison.trafficMixPercentagePoints >= 0 ? "+" : ""}${comparison.trafficMixPercentagePoints.toFixed(1)}pp · within segment ${comparison.withinSegmentPercentagePoints >= 0 ? "+" : ""}${comparison.withinSegmentPercentagePoints.toFixed(1)}pp`,
		);
	}
	for (const contributor of comparison.contributors.slice(0, 5)) {
		lines.push(
			`${contributor.impactPercentagePoints >= 0 ? "+" : ""}${contributor.impactPercentagePoints.toFixed(1)}pp (mix ${contributor.trafficMixPercentagePoints >= 0 ? "+" : ""}${contributor.trafficMixPercentagePoints.toFixed(1)}, within ${contributor.withinSegmentPercentagePoints >= 0 ? "+" : ""}${contributor.withinSegmentPercentagePoints.toFixed(1)}) · ${contributor.segment}`,
		);
	}
	return lines.join("\n");
}

export function formatTaskRun(run: TaskRunState): string {
	const lines = [
		`task run ${run.id}`,
		`status ${run.status} · phase ${run.phase} · conclusion ${run.conclusion ?? "pending"} · assurance ${run.assurance}`,
		`goal ${run.goal}`,
		`requests ${run.metrics.providerRequests} · tools ${run.metrics.toolCalls} · approvals ${run.metrics.approvals} · changes ${run.metrics.changes} · verifications ${run.metrics.verifications} · ${formatDuration(run.metrics.durationMs)}`,
		`release ${run.manifest.release} · model ${run.manifest.model.provider}/${run.manifest.model.id}`,
	];
	if (run.completionReason) lines.push(`reason ${run.completionReason}`);
	return lines.join("\n");
}

function truncateId(id: string, maxLen = 8): string {
	return id.length <= maxLen ? id : `${id.slice(0, maxLen)}…`;
}

// ── diff highlighting ────────────────────────────────────────────────────────

function editDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
		const current = [leftIndex];
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
			current[rightIndex] = Math.min(
				(current[rightIndex - 1] ?? 0) + 1,
				(previous[rightIndex] ?? 0) + 1,
				(previous[rightIndex - 1] ?? 0) +
					(left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
			);
		}
		for (let index = 0; index < current.length; index++) previous[index] = current[index] ?? 0;
	}
	return previous[right.length] ?? right.length;
}

export function findCommandSuggestion(
	input: string,
	commandNames: readonly string[],
): string | undefined {
	const normalized = input.toLowerCase();
	let best: { name: string; distance: number } | undefined;
	for (const name of commandNames) {
		const distance = editDistance(normalized, name.toLowerCase());
		if (!best || distance < best.distance) best = { name, distance };
	}
	const threshold = Math.max(1, Math.floor(normalized.length / 3));
	return best && best.distance <= threshold ? best.name : undefined;
}

const MAX_DIFF_LINES = 30;

export function highlightDiff(diff: string, maxWidth = 72): string {
	const lines = diff.split("\n");
	const displayLines = lines
		.slice(0, MAX_DIFF_LINES)
		.map((line) => truncateToWidth(line, maxWidth, "…"));
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
			chalk.yellow(
				truncateToWidth(
					`... ${lines.length - MAX_DIFF_LINES} more lines (truncated)`,
					maxWidth,
					"…",
				),
			),
		);
	}

	return highlighted.join("\n");
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
		super(1, 1, (line) => chalk.bgHex("#2a2a2a").white(line));
		this.addChild(new Text(chalk.white(sanitizeTerminalText(text)), 0, 0));
	}
}

export class LearningAgentTui {
	private readonly agent: LearningAgent;
	private readonly terminal: Terminal;
	private readonly tui: TUI;
	private readonly root = new Container();

	// Layout containers
	private readonly headerContainer = new Container();
	private readonly transcriptContainer = new Container();
	private readonly statusContainer = new Container();
	private readonly editorContainer = new Container();

	private readonly editor: Editor;
	private readonly statusText = new Text("", 1, 0);
	private readonly headerText = new Text("", 1, 0);
	private readonly inputHintText = new Text("", 1, 0);
	private readonly activityIndicator = new LearningActivityIndicator();

	private activeAssistant?: Markdown;
	private activeCompaction?: Markdown;
	private readonly activeTools = new Map<
		string,
		{ component: TranscriptToolBlock; startedAt: number }
	>();
	private readonly toolBlocks: TranscriptToolBlock[] = [];
	private toolOutputExpanded = false;
	private done?: () => void;
	private pendingApprovalId?: string;
	private approvalCard?: LearningApprovalCard;
	private approvalOverlay?: OverlayHandle;
	private sessionOverlay?: OverlayHandle;
	private policyOverlay?: OverlayHandle;
	private shuttingDown = false;
	private unsubscribeAgent: () => void = () => {};
	private pendingContinue = false;
	private statusOverride?: string;
	private contextPercent?: number;
	private cacheStats?: LearningAgentCacheStats;
	private readonly progress = new LearningProgress();
	private progressTimer?: NodeJS.Timeout;
	private readonly promptQueue: string[] = [];
	private promptRunning = false;
	private commandRunning = false;
	private drainingQueue = false;
	private auditVisible = false;
	private policyUpdate: Promise<void> = Promise.resolve();
	private pendingPolicyUpdates = 0;
	private policyUpdateFailed = false;
	private sessionSwitchFailed = false;
	private referenceCompletionActive = false;

	// Session metadata for the status bar
	private sessionId = "";
	private modelId = "";
	private messageCount = 0;
	private sessionPath = "";

	// Timing
	private tokenInput = 0;
	private tokenOutput = 0;
	private lastStopReason?: string;

	// Commands
	private readonly commands: Command[];

	private readonly signalHandler = () => {
		void this.requestShutdown();
	};

	constructor(agent: LearningAgent, terminal: Terminal = new ProcessTerminal()) {
		this.agent = agent;
		this.terminal = terminal;
		this.tui = new TUI(terminal);
		this.editor = new Editor(this.tui, editorTheme);

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
				description: "Search and resume a learning session",
				handler: async () => {
					await this.showSessionPicker();
					return undefined;
				},
			},
			{
				name: "/switch",
				description: "Switch to another session",
				usage: "/switch <session-id>",
				handler: async (args) => {
					if (!args.trim()) return chalk.red("Usage: /switch <session-id>");
					return await this.switchSession(args.trim());
				},
			},
			{
				name: "/new",
				aliases: ["/reset"],
				description: "Start a new session",
				handler: async () => {
					this.setBusy(true, "creating session…", "session");
					const info = await this.agent.newSession();
					this.sessionId = info.id;
					this.sessionPath = info.path;
					this.messageCount = info.messageCount;
					this.tokenInput = 0;
					this.tokenOutput = 0;
					this.transcriptContainer.clear();
					this.activeTools.clear();
					this.toolBlocks.length = 0;
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
					this.setBusy(true, "compacting…", "compacting");
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
					this.setBusy(true, "restoring context…", "compacting");
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
				name: "/cache",
				description: "Show prompt-cache hit statistics",
				handler: async () => {
					const stats = await this.agent.getCacheStats();
					this.cacheStats = stats;
					this.renderStatusBar();
					const cumulativeRate =
						formatCacheRate(stats.hitRate);
					const latestRate =
						formatCacheRate(stats.latestHitRate);
					return [
						`cache hit rate ${cumulativeRate} cumulative, ${latestRate} latest`,
						`prompt tokens ${stats.promptTokens}: read ${stats.cacheReadTokens}, write ${stats.cacheWriteTokens}, uncached ${stats.uncachedInputTokens}`,
						`provider requests ${stats.requestCount}; telemetry coverage ${formatCacheRate(stats.telemetryCoverage)}`,
					].join("\n");
				},
			},
			{
				name: "/cache-report",
				description: "Group cache performance by operational dimensions",
				usage: "/cache-report [release]",
				handler: async (args) => {
					const release = args.trim() || undefined;
					return formatCacheOperationsReport(
						await this.agent.getCacheReport(release),
					);
				},
			},
			{
				name: "/cache-compare",
				description: "Compare cache performance between releases",
				usage: "/cache-compare <baseline-release> [current-release]",
				handler: async (args) => {
					const releases = args.trim().split(/\s+/).filter(Boolean);
					if (releases.length < 1 || releases.length > 2) {
						return chalk.red(
							"Usage: /cache-compare <baseline-release> [current-release]",
						);
					}
					return formatCacheReleaseComparison(
						await this.agent.compareCacheReleases(
							releases[0]!,
							releases[1] ?? this.agent.getCacheRelease(),
						),
					);
				},
			},
			{
				name: "/runs",
				description: "List TaskRuns in the current session",
				handler: async () => {
					const runs = await this.agent.listTaskRuns();
					if (runs.length === 0) return "no task runs in this session";
					return runs
						.slice(0, 10)
						.map(
							(run) =>
								`${run.id} · ${run.status}/${run.phase} · ${run.conclusion ?? "pending"} · ${run.assurance} · ${run.goal}`,
						)
						.join("\n");
				},
			},
			{
				name: "/run",
				description: "Inspect one TaskRun",
				usage: "/run <run-id>",
				handler: async (args) => {
					const runId = args.trim();
					if (!runId) return chalk.red("Usage: /run <run-id>");
					return formatTaskRun(await this.agent.getTaskRun(runId));
				},
			},
			{
				name: "/queue",
				description: "Inspect or edit prompts queued behind the current turn",
				usage: "/queue [clear|remove <n>|edit <n>]",
				handler: (args) => this.managePromptQueue(args),
			},
			{
				name: "/learn",
				aliases: ["/progress"],
				description: "Show the current observe/propose/apply/verify trace",
				handler: () => {
					const snapshot = this.progress.snapshot();
					return `learning trace: ${formatLearningTrace(snapshot)} · ${formatDuration(snapshot.elapsedMs)}`;
				},
			},
			{
				name: "/trace",
				description: "Show or hide successful tool audit records",
				usage: "/trace [on|off]",
				handler: (args) => {
					const value = args.trim().toLowerCase();
					if (value && value !== "on" && value !== "off") {
						return chalk.red("Usage: /trace [on|off]");
					}
					this.auditVisible = value ? value === "on" : !this.auditVisible;
					return `audit trace ${this.auditVisible ? "on" : "off"}; blocked and failed actions are always shown`;
				},
			},
			{
				name: "/permissions",
				aliases: ["/tools"],
				description: "Inspect and change the model's Learning Agent tool policy",
				handler: () => {
					this.showToolPolicyPicker();
					return undefined;
				},
			},
			{
				name: "/clear",
				aliases: ["/cls"],
				description: "Clear the transcript display (session is preserved)",
				handler: () => {
					this.transcriptContainer.clear();
					this.activeTools.clear();
					this.toolBlocks.length = 0;
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
		this.root.addChild(this.activityIndicator);
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
				chalk.dim("  ║  /learn    learning trace        ║"),
				chalk.dim("  ║  /sessions resume prior study    ║"),
				chalk.dim("  ║  /queue    queued guidance       ║"),
				chalk.bold.cyan("  ╚══════════════════════════════════╝"),
				"",
			].join("\n"),
			0,
			0,
		);
		this.transcriptContainer.addChild(logo);

		this.editorContainer.addChild(this.inputHintText);
		this.editorContainer.addChild(this.editor);

		// Autocomplete: slash commands
		const slashCommands = this.commands.map((cmd) => ({
			name: cmd.name.slice(1), // strip leading /
			description: cmd.description,
			...(cmd.usage
				? { argumentHint: cmd.usage.slice(cmd.name.length).trim() }
				: {}),
		}));
		this.editor.setAutocompleteProvider(
			new LearningAutocompleteProvider(
				slashCommands,
				this.agent.getWorkspaceRoot(),
				(active) => {
					if (this.referenceCompletionActive === active) return;
					this.referenceCompletionActive = active;
					this.renderInputHint();
				},
			),
		);

		this.tui.addChild(this.root);
		this.tui.setFocus(this.editor);

		this.editor.onSubmit = (text) => {
			void this.handleSubmit(text);
		};
		this.editor.onChange = (text) => {
			if (!text.includes("@")) this.referenceCompletionActive = false;
			this.renderInputHint();
		};
		this.renderInputHint();

		// Global input listener
		this.tui.addInputListener((data) => {
			if (this.sessionOverlay || this.policyOverlay) return undefined;

			if (this.pendingApprovalId) {
				if (appKeybindings.matches(data, "learningAgent.approveEdit")) {
					this.agent.respondToApproval(this.pendingApprovalId, true);
					return { consume: true };
				}
				if (appKeybindings.matches(data, "learningAgent.rejectEdit")) {
					this.agent.respondToApproval(this.pendingApprovalId, false);
					return { consume: true };
				}
				if (this.navigateApproval(data)) return { consume: true };
				if (appKeybindings.matches(data, "learningAgent.exit")) {
					void this.requestShutdown();
				}
				return { consume: true };
			}

			if (appKeybindings.matches(data, "learningAgent.toggleToolDetails")) {
				this.setToolOutputExpanded(!this.toolOutputExpanded);
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
			if (
				appKeybindings.matches(data, "learningAgent.abort") &&
				this.editor.isShowingAutocomplete()
			) {
				queueMicrotask(() => {
					if (this.editor.isShowingAutocomplete()) return;
					this.referenceCompletionActive = false;
					this.renderInputHint();
				});
				return undefined;
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
			this.stopProgressTimer();
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
		try {
			const [context, cacheStats] = await Promise.all([
				this.agent.getContextInfo(),
				this.agent.getCacheStats(),
			]);
			this.contextPercent = context.contextWindow > 0 ? context.percent : undefined;
			this.cacheStats = cacheStats;
		} catch {
			this.contextPercent = undefined;
			this.cacheStats = undefined;
		}
		this.renderStatusBar();
	}

	private renderStatusBar(): void {
		this.renderInputHint();
		if (this.statusOverride) {
			this.statusText.setText(this.statusOverride);
			this.tui.requestRender();
			return;
		}
		const parts: string[] = [];
		const progress = this.progress.snapshot();
		if (
			progress.observations > 0 ||
			progress.proposals > 0 ||
			progress.applications > 0 ||
			progress.verifications > 0
		) {
			parts.push(chalk.dim(formatLearningTrace(progress)));
		}
		if (this.promptQueue.length > 0) {
			parts.push(chalk.cyan(`queue ${this.promptQueue.length}`));
		}
		if (this.modelId) parts.push(chalk.dim(this.modelId));
		if (this.sessionId) parts.push(chalk.dim(`s:${truncateId(this.sessionId)}`));
		if (this.tokenInput > 0 || this.tokenOutput > 0) {
			parts.push(chalk.dim(`↑${this.tokenInput} ↓${this.tokenOutput}`));
		}
		if (this.cacheStats?.latestHitRate !== undefined) {
			parts.push(chalk.dim(`CH ${this.cacheStats.latestHitRate.toFixed(1)}%`));
		}
		if (this.contextPercent !== undefined) parts.push(`ctx ${colorContextPercent(this.contextPercent)}`);
		const statusLine = parts.join(" │ ");
		this.statusText.setText(statusLine || chalk.dim("idle"));
		this.tui.requestRender();
	}

	private renderInputHint(): void {
		const descriptor = describeLearningInput({
			text: this.editor.getText(),
			agentBusy: this.agent.isBusy() || this.promptRunning,
			commandRunning: this.commandRunning,
			drainingQueue: this.drainingQueue,
			pendingPolicyUpdates: this.pendingPolicyUpdates,
			policyUpdateFailed: this.policyUpdateFailed,
			sessionSwitchFailed: this.sessionSwitchFailed,
			queuedCount: this.promptQueue.length,
			referenceCompletionActive: this.referenceCompletionActive,
		});
		const color = this.inputModeColor(descriptor.mode);
		this.editor.borderColor = color;
		this.inputHintText.setText(
			`${color(chalk.bold(descriptor.label))} ${chalk.dim(descriptor.help)}`,
		);
		this.tui.requestRender();
	}

	private inputModeColor(mode: LearningInputMode): (text: string) => string {
		if (mode === "blocked") return chalk.red;
		if (mode === "guidance") return chalk.yellow;
		if (mode === "command") return chalk.magenta;
		if (mode === "reference") return chalk.blue;
		return chalk.cyan;
	}

	// ── progress and overlays ───────────────────────────────────────────────

	private applyProgress(event: LearningProgressEvent): void {
		const snapshot = this.progress.apply(event);
		this.activityIndicator.update(snapshot);
		if (snapshot.phase === "idle") {
			this.stopProgressTimer();
		} else {
			this.startProgressTimer();
		}
		this.renderStatusBar();
	}

	private startProgressTimer(): void {
		if (this.progressTimer) return;
		this.progressTimer = setInterval(() => this.renderActivity(), 120);
		this.progressTimer.unref();
	}

	private renderActivity(): void {
		if (this.activityIndicator.update(this.progress.snapshot())) {
			this.tui.requestRender();
		}
	}

	private stopProgressTimer(): void {
		if (!this.progressTimer) return;
		clearInterval(this.progressTimer);
		this.progressTimer = undefined;
	}

	private navigateApproval(data: string): boolean {
		const card = this.approvalCard;
		if (!card) return false;
		if (appKeybindings.matches(data, "learningAgent.approvalUp")) {
			card.scrollLines(-1);
		} else if (appKeybindings.matches(data, "learningAgent.approvalDown")) {
			card.scrollLines(1);
		} else if (appKeybindings.matches(data, "learningAgent.approvalPageUp")) {
			card.scrollPages(-1);
		} else if (appKeybindings.matches(data, "learningAgent.approvalPageDown")) {
			card.scrollPages(1);
		} else if (appKeybindings.matches(data, "learningAgent.approvalHome")) {
			card.scrollToStart();
		} else if (appKeybindings.matches(data, "learningAgent.approvalEnd")) {
			card.scrollToEnd();
		} else {
			return false;
		}
		this.tui.requestRender();
		return true;
	}

	private async showSessionPicker(): Promise<void> {
		if (this.promptRunning || this.drainingQueue || this.agent.isBusy()) {
			throw new Error("Cannot switch sessions while Learning Agent is working");
		}
		this.setBusy(true, "indexing sessions", "session");
		let sessions;
		try {
			sessions = await this.agent.listSessions();
		} finally {
			this.setBusy(false);
		}
		if (sessions.length === 0) {
			this.addSystemLine("no sessions found");
			return;
		}
		this.sessionOverlay?.hide();
		const picker = new LearningSessionPicker(sessions, this.sessionId);
		picker.onCancel = () => this.closeSessionPicker();
		picker.onSelect = (session) => {
			this.closeSessionPicker(false);
			this.sessionSwitchFailed = false;
			this.renderStatusBar();
			void this.switchSession(session.id)
				.then(async (message) => {
					this.addSystemLine(message);
					await this.drainPromptQueue();
				})
				.catch((error: unknown) => {
					this.sessionSwitchFailed = true;
					this.renderStatusBar();
					this.addSystemLine(
						chalk.red(
							`session error: ${error instanceof Error ? error.message : String(error)}`,
						),
					);
					if (this.promptQueue.length > 0) {
						this.addSystemLine(
							chalk.yellow(
								"queued guidance retained; resume the intended session before running it",
							),
						);
					}
				});
		};
		this.sessionOverlay = this.tui.showOverlay(picker, {
			width: "85%",
			minWidth: 48,
			maxHeight: "75%",
			anchor: "center",
			margin: 1,
		});
	}

	private closeSessionPicker(drainQueue = true): void {
		const overlay = this.sessionOverlay;
		this.sessionOverlay = undefined;
		overlay?.hide();
		if (drainQueue) void this.drainPromptQueue();
	}

	private showToolPolicyPicker(): void {
		this.policyOverlay?.hide();
		const picker = new LearningToolPolicyPicker(
			this.agent.getToolPolicies(),
			(toolName, permission) => {
				if (this.pendingPolicyUpdates === 0) this.policyUpdateFailed = false;
				this.pendingPolicyUpdates++;
				this.renderStatusBar();
				this.policyUpdate = this.policyUpdate
					.then(async () => {
						await this.agent.setToolPermission(toolName, permission);
						this.addSystemLine(
							`tool policy ${toolName}: ${permission ?? "default"}`,
						);
					})
					.catch((error: unknown) => {
						this.policyUpdateFailed = true;
						this.renderStatusBar();
						this.addSystemLine(
							chalk.red(
								`tool policy error: ${error instanceof Error ? error.message : String(error)}`,
							),
						);
					})
					.finally(() => {
						this.pendingPolicyUpdates--;
						this.renderStatusBar();
						if (
							this.pendingPolicyUpdates === 0 &&
							!this.policyUpdateFailed
						) {
							void this.drainPromptQueue();
						} else if (
							this.pendingPolicyUpdates === 0 &&
							this.promptQueue.length > 0
						) {
							this.addSystemLine(
								chalk.yellow(
									"queued guidance retained until tool policy changes apply successfully",
								),
							);
						}
					});
			},
			() => this.closeToolPolicyPicker(),
		);
		this.policyOverlay = this.tui.showOverlay(picker, {
			width: "85%",
			minWidth: 52,
			maxHeight: "80%",
			anchor: "center",
			margin: 1,
		});
	}

	private closeToolPolicyPicker(drainQueue = true): void {
		const overlay = this.policyOverlay;
		this.policyOverlay = undefined;
		overlay?.hide();
		if (drainQueue) void this.drainPromptQueue();
	}

	private async switchSession(id: string): Promise<string> {
		this.setBusy(true, "loading session", "session");
		try {
			const info = await this.agent.switchSession(id);
			this.sessionSwitchFailed = false;
			this.sessionId = info.id;
			this.sessionPath = info.path;
			this.messageCount = info.messageCount;
			this.tokenInput = 0;
			this.tokenOutput = 0;
			this.transcriptContainer.clear();
			this.activeTools.clear();
			this.toolBlocks.length = 0;
			await this.renderHistory(await this.agent.getMessages());
			await this.updateStatusBar();
			this.updateHeader();
			return `resumed learning session ${info.id} (${info.messageCount} messages)`;
		} finally {
			this.setBusy(false);
		}
	}

	private managePromptQueue(args: string): string {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		if (parts.length === 0) {
			if (this.promptQueue.length === 0) return "prompt queue is empty";
			return [
				chalk.bold("Queued guidance:"),
				...this.promptQueue.map(
					(prompt, index) =>
						`${index + 1}. ${truncateToWidth(sanitizeTerminalText(prompt).replace(/\s+/g, " "), 72, "…")}`,
				),
			].join("\n");
		}
		if (parts[0] === "clear" && parts.length === 1) {
			const count = this.promptQueue.length;
			this.promptQueue.length = 0;
			this.renderStatusBar();
			return `cleared ${count} queued prompt${count === 1 ? "" : "s"}`;
		}
		const index = Number(parts[1]) - 1;
		if (
			(parts[0] === "remove" || parts[0] === "edit") &&
			parts.length === 2 &&
			Number.isInteger(index) &&
			index >= 0 &&
			index < this.promptQueue.length
		) {
			const [prompt] = this.promptQueue.splice(index, 1);
			if (parts[0] === "edit" && prompt !== undefined) this.editor.setText(prompt);
			this.renderStatusBar();
			return `${parts[0] === "edit" ? "moved" : "removed"} queued prompt ${index + 1}${parts[0] === "edit" ? " to the editor" : ""}`;
		}
		return chalk.red("Usage: /queue [clear|remove <n>|edit <n>]");
	}

	private queuePrompt(text: string): void {
		this.promptQueue.push(text);
		const preview = sanitizeTerminalText(text).replace(/\s+/g, " ");
		this.addSystemLine(
			chalk.cyan(
				`queued guidance ${this.promptQueue.length}: ${truncateToWidth(preview, 64, "…")}`,
			),
		);
		this.renderStatusBar();
	}

	private setToolOutputExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;
		for (const block of this.toolBlocks) block.setExpanded(expanded);
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
		lines.push(chalk.bold("Learning controls:"));
		lines.push(chalk.dim("Esc interrupt · Ctrl+O tool detail · queued prompts run after the turn"));
		lines.push(chalk.dim("During approval: y approve · n/Esc reject · arrows/PgUp/PgDn review"));
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
		const safeWhileBusy = new Set(["/help", "/queue", "/learn", "/trace"]);
		if (this.commandRunning) {
			this.addSystemLine(chalk.yellow("another command is still running"));
			return true;
		}
		if (
			(this.promptRunning || this.agent.isBusy() || this.pendingPolicyUpdates > 0) &&
			!safeWhileBusy.has(cmd.name)
		) {
			this.addSystemLine(
				chalk.yellow(
					`${cmd.name} is unavailable during a turn; submit plain guidance to queue it`,
				),
			);
			return true;
		}

		this.commandRunning = true;
		this.renderInputHint();
		try {
			const result = await cmd.handler(args);
			if (result !== undefined) {
				this.addSystemLine(result);
			}
		} catch (error) {
			this.addSystemLine(
				chalk.red(`command error: ${error instanceof Error ? error.message : String(error)}`),
			);
		} finally {
			this.commandRunning = false;
			this.renderInputHint();
			if (!this.agent.isBusy() && !this.pendingApprovalId && !this.shuttingDown) {
				this.setBusy(false);
			}
		}
		return true;
	}

	// ── rendering ───────────────────────────────────────────────────────────

	private async renderHistory(messages: AgentMessage[]): Promise<void> {
		const pendingTools = new Map<string, TranscriptToolBlock>();
		for (const message of messages) {
			if (message.role === "user") this.addUserMessage(getMessageText(message));
			if (message.role === "assistant") {
				const text = getMessageText(message);
				if (text || message.errorMessage) {
					this.addAssistantMessage(text, message.errorMessage);
				}
				for (const content of message.content) {
					if (content.type !== "toolCall") continue;
					const component = new TranscriptToolBlock(
						content.name,
						content.arguments as Record<string, unknown>,
						this.toolOutputExpanded,
					);
					this.transcriptContainer.addChild(new Spacer(1));
					this.transcriptContainer.addChild(component);
					this.toolBlocks.push(component);
					pendingTools.set(content.id, component);
				}
			}
			if (message.role === "toolResult") {
				const component = pendingTools.get(message.toolCallId);
				if (!component) continue;
				component.complete(message, message.isError);
				pendingTools.delete(message.toolCallId);
			}
		}
		for (const component of pendingTools.values()) {
			component.complete(
				{
					content: [
						{ type: "text", text: "Tool result is unavailable in this saved session" },
					],
				},
				true,
			);
		}
	}

	private addUserMessage(text: string): void {
		this.transcriptContainer.addChild(new Spacer(1));
		this.transcriptContainer.addChild(new Text(chalk.gray.bold("You"), 1, 0));
		this.transcriptContainer.addChild(new LearningAgentUserMessage(text));
		this.tui.requestRender();
	}

	private addAssistantMessage(text: string, errorMessage?: string): Markdown {
		const safeText = sanitizeTerminalText(text);
		const content = errorMessage
			? `${safeText}\n\nError: ${sanitizeTerminalText(errorMessage)}`.trim()
			: safeText;
		const component = new Markdown(content, 1, 1, markdownTheme);
		this.transcriptContainer.addChild(new Spacer(1));
		this.transcriptContainer.addChild(component);
		this.tui.requestRender();
		return component;
	}

	private addSystemLine(text: string): void {
		this.transcriptContainer.addChild(new Text(chalk.dim(`· ${text}`), 1, 0));
		this.tui.requestRender();
	}

	private addToolCallCard(
		toolCallId: string,
		toolName: string,
		args: Record<string, unknown>,
	): void {
		const component = new TranscriptToolBlock(
			toolName,
			args,
			this.toolOutputExpanded,
		);
		this.transcriptContainer.addChild(new Spacer(1));
		this.transcriptContainer.addChild(component);
		this.toolBlocks.push(component);
		this.activeTools.set(toolCallId, { component, startedAt: Date.now() });
		this.tui.requestRender();
	}

	private updateToolCallCard(
		toolCallId: string,
		_toolName: string,
		partialResult: unknown,
	): void {
		const card = this.activeTools.get(toolCallId);
		if (!card) return;
		card.component.updateResult(partialResult);
		this.tui.requestRender();
	}

	private finishToolCallCard(
		toolCallId: string,
		toolName: string,
		result: unknown,
		isError: boolean,
	): void {
		const card = this.activeTools.get(toolCallId);
		if (card) {
			card.component.complete(result, isError, Date.now() - card.startedAt);
			this.activeTools.delete(toolCallId);
		} else {
			const component = new TranscriptToolBlock(
				toolName,
				{},
				this.toolOutputExpanded,
			);
			component.complete(result, isError);
			this.transcriptContainer.addChild(component);
			this.toolBlocks.push(component);
		}
		this.tui.requestRender();
	}

	private setBusy(
		busy: boolean,
		label = busy ? "understanding the request" : "ready",
		phase: Exclude<LearningPhase, "idle"> = "reasoning",
	): void {
		this.editor.disableSubmit = this.shuttingDown;
		this.applyProgress(
			busy
				? { type: "phase_changed", phase, detail: label }
				: { type: "turn_finished" },
		);
	}

	// ── input handling ──────────────────────────────────────────────────────

	private async handleSubmit(rawText: string): Promise<void> {
		const text = rawText.trim();
		if (!text) return;

		if (text.startsWith("/")) {
			this.editor.setText("");
			const handled = await this.executeCommand(text);
			if (!handled) {
				const commandName = text.split(/\s+/)[0] ?? text;
				const suggestion = findCommandSuggestion(
					commandName,
					this.commands.flatMap((command) => [command.name, ...(command.aliases ?? [])]),
				);
				this.addSystemLine(
					chalk.red(
						`unknown command ${commandName}${suggestion ? `; did you mean ${suggestion}?` : "; use /help"}`,
					),
				);
				this.editor.setText(text);
				return;
			}
			this.recordInput(text);
			await this.drainPromptQueue();
			return;
		}

		this.recordInput(text);
		this.editor.setText("");
		if (
			this.promptRunning ||
			this.commandRunning ||
			this.drainingQueue ||
			this.pendingPolicyUpdates > 0 ||
			this.policyUpdateFailed ||
			this.sessionSwitchFailed ||
			this.agent.isBusy()
		) {
			this.queuePrompt(text);
			return;
		}
		await this.runPrompt(text);
		await this.drainPromptQueue();
	}

	private recordInput(text: string): void {
		this.editor.addToHistory(text);
	}

	private async runPrompt(text: string, continuing = false): Promise<void> {
		this.promptRunning = true;
		try {
			this.lastStopReason = undefined;
			if (!continuing) this.applyProgress({ type: "turn_started" });
			await this.agent.prompt(text);
		} catch (error) {
			this.addSystemLine(
				chalk.red(`error: ${error instanceof Error ? error.message : String(error)}`),
			);
			this.applyProgress({ type: "turn_aborted" });
		} finally {
			this.promptRunning = false;
			await this.updateStatusBar();
		}
	}

	private async drainPromptQueue(): Promise<void> {
		if (
			this.drainingQueue ||
			this.promptRunning ||
			this.commandRunning ||
			this.pendingPolicyUpdates > 0 ||
			this.policyUpdateFailed ||
			this.sessionSwitchFailed ||
			this.sessionOverlay !== undefined ||
			this.policyOverlay !== undefined ||
			this.shuttingDown
		) {
			return;
		}
		this.drainingQueue = true;
		try {
			while (!this.shuttingDown) {
				if (this.pendingContinue && this.promptQueue.length > 0) {
					this.pendingContinue = false;
					this.addSystemLine(
						chalk.yellow("automatic continuation skipped in favor of queued guidance"),
					);
				}
				if (this.pendingContinue) {
					this.pendingContinue = false;
					this.addSystemLine(chalk.yellow("continuing truncated response"));
					await this.runPrompt("continue", true);
					continue;
				}
				const next = this.promptQueue.shift();
				if (next === undefined) break;
				this.addSystemLine(
					chalk.cyan(
						`running queued guidance: ${truncateToWidth(sanitizeTerminalText(next).replace(/\s+/g, " "), 64, "…")}`,
					),
				);
				this.renderStatusBar();
				await this.runPrompt(next);
			}
		} finally {
			this.drainingQueue = false;
			this.renderStatusBar();
		}
	}

	private async requestShutdown(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		this.editor.disableSubmit = true;
		this.closeSessionPicker(false);
		this.closeToolPolicyPicker(false);
		this.approvalOverlay?.hide();
		this.addSystemLine(chalk.dim("shutting down…"));
		try {
			if (this.agent.isBusy()) await this.agent.abort();
			await this.policyUpdate;
		} catch (error) {
			this.addSystemLine(`shutdown error: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.done?.();
		}
	}

	// ── agent events ────────────────────────────────────────────────────────

	private handleAgentEvent(event: LearningAgentUiEvent): void {
		if (event.type === "cache_observation_error") {
			this.addSystemLine(
				chalk.yellow(`cache observation was not persisted: ${event.message}`),
			);
			return;
		}
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
				"compacting",
			);
			this.tui.requestRender();
			return;
		}
		if (event.type === "approval_request") {
			this.pendingApprovalId = event.request.id;
			const subject = event.request.subject;
			this.approvalOverlay?.hide();
			this.approvalCard = new LearningApprovalCard(subject);
			this.approvalOverlay = this.tui.showOverlay(this.approvalCard, {
				width: "92%",
				minWidth: 48,
				maxHeight: "85%",
				anchor: "center",
				margin: 1,
			});
			this.applyProgress({ type: "approval_requested", subjectKind: subject.kind });
			const approvalKind =
				subject.kind === "edit" ? "Edit" : subject.kind === "task" ? "Task" : "Tool";
			this.statusOverride = chalk.bold.yellow(
				`${approvalKind} review · y approve once · n/Esc reject · arrows/PgUp/PgDn inspect`,
			);
			this.renderStatusBar();
			return;
		}
		if (event.type === "approval_resolved") {
			if (this.pendingApprovalId === event.requestId) this.pendingApprovalId = undefined;
			this.statusOverride = undefined;
			const overlay = this.approvalOverlay;
			this.approvalOverlay = undefined;
			this.approvalCard = undefined;
			overlay?.hide();
			this.addSystemLine(
				event.approved
					? chalk.green(`${event.subjectKind} approved once`)
					: chalk.red(`${event.subjectKind} rejected`),
			);
			this.applyProgress({ type: "approval_resolved", approved: event.approved });
			this.tui.requestRender();
			return;
		}
		if (event.type === "audit") {
			const isProblem =
				event.record.phase === "decision"
					? event.record.decision !== "allowed"
					: event.record.outcome !== "completed";
			if (!this.auditVisible && !isProblem) return;
			if (event.record.phase === "decision") {
				const decision =
					event.record.decision === "allowed"
						? chalk.green("allowed")
						: chalk.red(event.record.decision);
				this.addSystemLine(`audit ${event.record.toolName}: ${decision}`);
			} else {
				const outcome =
					event.record.outcome === "completed"
						? chalk.green("completed")
						: chalk.red(event.record.outcome);
				this.addSystemLine(`audit ${event.record.toolName}: ${outcome}`);
			}
			return;
		}
		if (event.type === "message_start") {
			this.messageCount++;
			this.updateHeader();
			if (event.message.role === "user") this.addUserMessage(getMessageText(event.message));
			if (event.message.role === "assistant") {
				this.applyProgress({
					type: "phase_changed",
					phase: "reasoning",
					detail: "explaining from collected evidence",
				});
				this.activeAssistant = this.addAssistantMessage(getMessageText(event.message));
			}
		} else if (event.type === "message_update" && this.activeAssistant) {
			this.activeAssistant.setText(sanitizeTerminalText(getMessageText(event.message)));
			this.tui.requestRender();
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const msg = event.message;
			this.lastStopReason = msg.stopReason;
			this.activeAssistant?.setText(
				msg.errorMessage
					? `${sanitizeTerminalText(getMessageText(msg))}\n\nError: ${sanitizeTerminalText(msg.errorMessage)}`.trim()
					: sanitizeTerminalText(getMessageText(msg)),
			);
			this.activeAssistant = undefined;
			if (msg.usage) {
				this.tokenInput += msg.usage.input;
				this.tokenOutput += msg.usage.output;
			}

			// Auto-continue when model hits output length limit
			if (msg.stopReason === "length" && !this.shuttingDown) {
				this.pendingContinue = true;
				this.addSystemLine(chalk.yellow("response truncated; continuation is pending"));
				return;
			}
		} else if (event.type === "tool_execution_start") {
			this.applyProgress({ type: "tool_started", toolName: event.toolName });
			this.addToolCallCard(
				event.toolCallId,
				event.toolName,
				event.args as Record<string, unknown>,
			);
		} else if (event.type === "tool_execution_update") {
			this.updateToolCallCard(event.toolCallId, event.toolName, event.partialResult);
		} else if (event.type === "tool_execution_end") {
			this.finishToolCallCard(
				event.toolCallId,
				event.toolName,
				event.result,
				event.isError,
			);
			this.applyProgress({
				type: "tool_finished",
				toolName: event.toolName,
				isError: event.isError,
			});
		} else if (event.type === "agent_end") {
			const progress = this.progress.snapshot();
			if (
				this.lastStopReason !== "aborted" &&
				this.lastStopReason !== "error" &&
				this.lastStopReason !== "length"
			) {
				this.addSystemLine(
					chalk.dim(
						`learning loop · ${formatLearningTrace(progress)} · ${formatDuration(progress.elapsedMs)}`,
					),
				);
			}
			this.applyProgress({ type: "turn_finished" });
			this.updateHeader();
		} else if (event.type === "abort") {
			this.applyProgress({ type: "turn_aborted" });
			this.addSystemLine(chalk.yellow("turn aborted"));
		}
	}
}
