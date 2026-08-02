import {
	type Component,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import type {
	LogosPhase,
	LogosProgressSnapshot,
} from "./logos-progress.ts";
import { sanitizeTerminalText } from "./transcript-tool-block.ts";

const spinnerFrames = ["✢", "✣", "✤", "✥"] as const;
const frameDurationMs = 120;
const reviewFrameDurationMs = 1_000;
const verbDurationMs = 1_800;
const tipDurationMs = 8_000;

const phaseVerbs: Record<Exclude<LogosPhase, "idle">, readonly string[]> = {
	reasoning: ["Nebulizing", "Connecting evidence", "Reflecting", "Synthesizing"],
	observing: ["Inspecting evidence", "Tracing sources", "Reading workspace"],
	proposing: ["Shaping proposal", "Drafting change", "Checking scope"],
	reviewing: ["Awaiting review", "Holding the safety gate"],
	applying: ["Applying approved change", "Updating workspace"],
	verifying: ["Verifying result", "Checking acceptance criteria"],
	compacting: ["Compressing context", "Preserving logos state"],
	session: ["Loading logos session", "Rebuilding context"],
};

const logosTips = [
	"Use @path to anchor the goal in workspace evidence",
	"State the outcome, evidence, and acceptance criteria",
	"Shift+Enter adds detail without submitting",
	"/learn shows observe → propose → apply → verify",
] as const;

const genericDetails = new Set([
	"understanding the request",
	"reflecting on evidence",
	"explaining from collected evidence",
	"approval granted",
	"revising after rejection",
	"ready",
]);

export interface LogosActivityDescription {
	frame: string;
	verb: string;
	timing: string;
	secondary: string;
	phase: Exclude<LogosPhase, "idle">;
}

function formatElapsed(elapsedMs: number): string {
	const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${seconds % 60}s`;
}

function timingLabel(phase: Exclude<LogosPhase, "idle">): string {
	if (phase === "reasoning") return "thought";
	if (phase === "reviewing") return "waited";
	return "worked";
}

function concreteDetail(detail: string | undefined): string | undefined {
	if (!detail || genericDetails.has(detail)) return undefined;
	const sanitized = sanitizeTerminalText(detail);
	return sanitized || undefined;
}

export function describeLogosActivity(
	snapshot: LogosProgressSnapshot,
): LogosActivityDescription | undefined {
	if (snapshot.phase === "idle") return undefined;
	const elapsedMs = snapshot.phaseElapsedMs;
	const verbs = phaseVerbs[snapshot.phase];
	const detail = concreteDetail(snapshot.detail);
	const tip =
		logosTips[Math.floor(elapsedMs / tipDurationMs) % logosTips.length] ??
		logosTips[0];
	const activeFrameDurationMs =
		snapshot.phase === "reviewing" ? reviewFrameDurationMs : frameDurationMs;
	return {
		frame:
			spinnerFrames[
				Math.floor(elapsedMs / activeFrameDurationMs) % spinnerFrames.length
			] ??
			spinnerFrames[0],
		verb:
			verbs[Math.floor(elapsedMs / verbDurationMs) % verbs.length] ??
			verbs[0],
		timing: `${timingLabel(snapshot.phase)} for ${formatElapsed(elapsedMs)}`,
		secondary: detail ?? `Tip: ${tip}`,
		phase: snapshot.phase,
	};
}

function phaseColor(
	phase: Exclude<LogosPhase, "idle">,
): (text: string) => string {
	if (phase === "reviewing") return chalk.yellow;
	if (phase === "applying") return chalk.magenta;
	if (phase === "verifying") return chalk.green;
	if (phase === "compacting" || phase === "session") return chalk.blue;
	return chalk.cyan;
}

export class LogosActivityIndicator implements Component {
	private description?: LogosActivityDescription;

	update(snapshot: LogosProgressSnapshot): boolean {
		const next = describeLogosActivity(snapshot);
		if (
			this.description?.frame === next?.frame &&
			this.description?.verb === next?.verb &&
			this.description?.timing === next?.timing &&
			this.description?.secondary === next?.secondary &&
			this.description?.phase === next?.phase
		) {
			return false;
		}
		this.description = next;
		return true;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const description = this.description;
		if (!description) return [];
		const safeWidth = Math.max(1, width);
		const color = phaseColor(description.phase);
		return [
			truncateToWidth(
				`${color(description.frame)} ${chalk.bold(description.verb)}… ${chalk.dim(`(${description.timing})`)}`,
				safeWidth,
				"…",
			),
			truncateToWidth(
				chalk.dim(`  ⎿ ${description.secondary}`),
				safeWidth,
				"…",
			),
		];
	}
}
