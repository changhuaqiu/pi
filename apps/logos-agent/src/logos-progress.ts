export type LogosPhase =
	| "idle"
	| "reasoning"
	| "observing"
	| "proposing"
	| "reviewing"
	| "applying"
	| "verifying"
	| "compacting"
	| "session";

export type LogosProgressEvent =
	| { type: "turn_started" }
	| { type: "phase_changed"; phase: Exclude<LogosPhase, "idle">; detail?: string }
	| { type: "tool_started"; toolName: string }
	| { type: "tool_finished"; toolName: string; isError: boolean }
	| {
			type: "approval_requested";
			subjectKind: string;
	  }
	| {
			type: "approval_resolved";
			outcome: "approved" | "rejected" | "failed";
	  }
	| { type: "turn_finished" }
	| { type: "turn_aborted" };

export interface LogosProgressSnapshot {
	phase: LogosPhase;
	detail?: string;
	elapsedMs: number;
	phaseElapsedMs: number;
	observations: number;
	proposals: number;
	applications: number;
	verifications: number;
	failures: number;
}

interface LogosProgressState {
	phase: LogosPhase;
	detail?: string;
	phaseStartedAt: number;
	turnStartedAt?: number;
	turnFinishedAt?: number;
	observations: number;
	proposals: number;
	applications: number;
	verifications: number;
	failures: number;
}

// ── tool classification ─────────────────────────────────────────────────
// Each tool maps to the phase it drives. Unknown tools default to
// "reasoning" (deliberation / answer tools).

const toolPhase: Record<string, Exclude<LogosPhase, "idle">> = {
	workspace_info: "observing",
	list_files: "observing",
	read_file: "observing",
	grep: "observing",
	codegraph_search: "observing",
	codegraph_node: "observing",
	codegraph_explore: "observing",
	codegraph_impact: "observing",
	git_status: "observing",
	git_diff: "observing",
	git_log: "observing",
	git_show: "observing",
	git_blame: "observing",
	web_search: "observing",
	command_status: "observing",
	propose_patch: "proposing",
	propose_create_file: "proposing",
	propose_delete_file: "proposing",
	apply_edit: "applying",
	create_directories: "applying",
	run_command: "applying",
	stop_command: "applying",
	run_task: "verifying",
};

function classifyTool(toolName: string): Exclude<LogosPhase, "idle"> {
	return toolPhase[toolName] ?? "reasoning";
}

function incrementCounter(
	state: LogosProgressState,
	phase: LogosPhase,
): void {
	if (phase === "observing") state.observations++;
	else if (phase === "proposing") state.proposals++;
	else if (phase === "applying") state.applications++;
	else if (phase === "verifying") state.verifications++;
}

// ── turn lifecycle ──────────────────────────────────────────────────────

function startTurn(state: LogosProgressState, now: number): void {
	state.phase = "reasoning";
	state.detail = "understanding the request";
	state.phaseStartedAt = now;
	state.turnStartedAt = now;
	state.turnFinishedAt = undefined;
	state.observations = 0;
	state.proposals = 0;
	state.applications = 0;
	state.verifications = 0;
	state.failures = 0;
}

/**
 * End the current turn and enter idle. Idempotent — callers such as
 * setBusy() may fire turn_finished outside a formal turn and the state
 * machine records the idle boundary regardless.
 */
function finishTurn(
	state: LogosProgressState,
	aborted: boolean,
	now: number,
): void {
	if (aborted) state.failures++;
	state.phase = "idle";
	state.detail = aborted ? "turn aborted" : undefined;
	state.phaseStartedAt = now;
	state.turnFinishedAt = now;
}

// ── phase transition ────────────────────────────────────────────────────

/**
 * Enter an active phase. The phase clock resets only when the (phase,
 * detail) pair actually changes so that repeated identical updates (e.g.
 * compaction progress callbacks) preserve the original start time.
 *
 * Always clears turnFinishedAt — while work is in progress the elapsed
 * counter in snapshot() keeps ticking.
 */
function transition(
	state: LogosProgressState,
	phase: Exclude<LogosPhase, "idle">,
	detail: string | undefined,
	now: number,
): void {
	const activityChanged =
		state.phase !== phase || state.detail !== detail;
	state.phase = phase;
	state.detail = detail;
	if (activityChanged) state.phaseStartedAt = now;
	state.turnFinishedAt = undefined;
}

// ── public API ──────────────────────────────────────────────────────────

export class LogosProgress {
	private readonly state: LogosProgressState;

	constructor(now = Date.now()) {
		this.state = {
			phase: "idle",
			phaseStartedAt: now,
			observations: 0,
			proposals: 0,
			applications: 0,
			verifications: 0,
			failures: 0,
		};
	}

	apply(
		event: LogosProgressEvent,
		now = Date.now(),
	): LogosProgressSnapshot {
		switch (event.type) {
			case "turn_started":
				startTurn(this.state, now);
				break;

			case "turn_finished":
				finishTurn(this.state, false, now);
				break;

			case "turn_aborted":
				finishTurn(this.state, true, now);
				break;

			case "phase_changed":
				transition(this.state, event.phase, event.detail, now);
				break;

			case "tool_started": {
				const phase = classifyTool(event.toolName);
				transition(this.state, phase, event.toolName, now);
				incrementCounter(this.state, phase);
				break;
			}

			case "tool_finished":
				if (event.isError) this.state.failures++;
				transition(
					this.state,
					"reasoning",
					event.isError
						? `${event.toolName} failed`
						: "reflecting on evidence",
					now,
				);
				break;

			case "approval_requested":
				transition(
					this.state,
					"reviewing",
					`${event.subjectKind} approval`,
					now,
				);
				break;

			case "approval_resolved":
				if (event.outcome === "failed") this.state.failures++;
				transition(
					this.state,
					"reasoning",
					event.outcome === "approved"
						? "approval granted"
						: event.outcome === "rejected"
							? "revising after rejection"
							: "approval failed",
					now,
				);
				break;
		}
		return this.snapshot(now);
	}

	snapshot(now = Date.now()): LogosProgressSnapshot {
		const startedAt =
			this.state.turnStartedAt ?? this.state.phaseStartedAt;
		const endedAt = this.state.turnFinishedAt ?? now;
		return {
			phase: this.state.phase,
			...(this.state.detail === undefined
				? {}
				: { detail: this.state.detail }),
			elapsedMs: Math.max(0, endedAt - startedAt),
			phaseElapsedMs:
				this.state.phase === "idle"
					? 0
					: Math.max(0, now - this.state.phaseStartedAt),
			observations: this.state.observations,
			proposals: this.state.proposals,
			applications: this.state.applications,
			verifications: this.state.verifications,
			failures: this.state.failures,
		};
	}
}

export function formatLogosPhase(phase: LogosPhase): string {
	switch (phase) {
		case "idle":
			return "ready";
		case "reasoning":
			return "reason";
		case "observing":
			return "observe";
		case "proposing":
			return "propose";
		case "reviewing":
			return "review";
		case "applying":
			return "apply";
		case "verifying":
			return "verify";
		case "compacting":
			return "compact";
		case "session":
			return "session";
	}
}

export function formatLogosTrace(snapshot: LogosProgressSnapshot): string {
	const parts = [
		`observe ${snapshot.observations}`,
		`propose ${snapshot.proposals}`,
		`apply ${snapshot.applications}`,
		`verify ${snapshot.verifications}`,
	];
	if (snapshot.failures > 0) parts.push(`fail ${snapshot.failures}`);
	return parts.join(" / ");
}
