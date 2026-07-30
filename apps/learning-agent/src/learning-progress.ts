export type LearningPhase =
	| "idle"
	| "reasoning"
	| "observing"
	| "proposing"
	| "reviewing"
	| "applying"
	| "verifying"
	| "compacting"
	| "session";

export type LearningProgressEvent =
	| { type: "turn_started" }
	| { type: "phase_changed"; phase: Exclude<LearningPhase, "idle">; detail?: string }
	| { type: "tool_started"; toolName: string }
	| { type: "tool_finished"; toolName: string; isError: boolean }
	| { type: "approval_requested"; subjectKind: "edit" | "task" | "tool" }
	| { type: "approval_resolved"; approved: boolean }
	| { type: "turn_finished" }
	| { type: "turn_aborted" };

export interface LearningProgressSnapshot {
	phase: LearningPhase;
	detail?: string;
	elapsedMs: number;
	phaseElapsedMs: number;
	observations: number;
	proposals: number;
	applications: number;
	verifications: number;
	failures: number;
}

interface LearningProgressState {
	phase: LearningPhase;
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

const observingTools = new Set([
	"workspace_info",
	"list_files",
	"read_file",
	"search_text",
	"git_status",
	"git_diff",
	"git_log",
	"git_show",
	"git_blame",
]);

const proposingTools = new Set([
	"propose_patch",
	"propose_create_file",
	"propose_delete_file",
]);

function classifyTool(toolName: string): Exclude<LearningPhase, "idle"> {
	if (observingTools.has(toolName)) return "observing";
	if (proposingTools.has(toolName)) return "proposing";
	if (toolName === "apply_edit") return "applying";
	if (toolName === "run_task") return "verifying";
	return "reasoning";
}

function resetTurn(state: LearningProgressState, now: number): void {
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

export class LearningProgress {
	private readonly state: LearningProgressState;

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

	apply(event: LearningProgressEvent, now = Date.now()): LearningProgressSnapshot {
		if (event.type === "turn_started") {
			resetTurn(this.state, now);
		} else if (event.type === "phase_changed") {
			this.transition(event.phase, event.detail, now);
		} else if (event.type === "tool_started") {
			const phase = classifyTool(event.toolName);
			this.transition(phase, event.toolName, now);
			if (phase === "observing") this.state.observations++;
			if (phase === "proposing") this.state.proposals++;
			if (phase === "applying") this.state.applications++;
			if (phase === "verifying") this.state.verifications++;
		} else if (event.type === "tool_finished") {
			if (event.isError) this.state.failures++;
			this.transition("reasoning", event.isError ? `${event.toolName} failed` : "reflecting on evidence", now);
		} else if (event.type === "approval_requested") {
			this.transition("reviewing", `${event.subjectKind} approval`, now);
		} else if (event.type === "approval_resolved") {
			this.transition(
				"reasoning",
				event.approved ? "approval granted" : "revising after rejection",
				now,
			);
		} else {
			if (event.type === "turn_aborted") this.state.failures++;
			this.state.phase = "idle";
			this.state.detail = event.type === "turn_aborted" ? "turn aborted" : undefined;
			this.state.phaseStartedAt = now;
			this.state.turnFinishedAt = now;
		}
		return this.snapshot(now);
	}

	snapshot(now = Date.now()): LearningProgressSnapshot {
		const startedAt = this.state.turnStartedAt ?? this.state.phaseStartedAt;
		const endedAt = this.state.turnFinishedAt ?? now;
		return {
			phase: this.state.phase,
			...(this.state.detail === undefined ? {} : { detail: this.state.detail }),
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

	private transition(
		phase: Exclude<LearningPhase, "idle">,
		detail: string | undefined,
		now: number,
	): void {
		const activityChanged =
			this.state.phase !== phase || this.state.detail !== detail;
		this.state.phase = phase;
		this.state.detail = detail;
		if (activityChanged) this.state.phaseStartedAt = now;
		this.state.turnFinishedAt = undefined;
	}
}

export function formatLearningPhase(phase: LearningPhase): string {
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

export function formatLearningTrace(snapshot: LearningProgressSnapshot): string {
	const parts = [
		`observe ${snapshot.observations}`,
		`propose ${snapshot.proposals}`,
		`apply ${snapshot.applications}`,
		`verify ${snapshot.verifications}`,
	];
	if (snapshot.failures > 0) parts.push(`fail ${snapshot.failures}`);
	return parts.join(" / ");
}
