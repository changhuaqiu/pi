import { randomUUID } from "node:crypto";

export const TASK_RUN_EVENT_VERSION = 1;

export type TaskRunStatus = "active" | "waiting" | "terminal";
export type TaskRunPhase = "discover" | "execute" | "verify" | "deliver";
export type TaskRunWaitReason = "approval" | "user" | "resource";
export type TaskRunConclusion = "success" | "failure" | "aborted" | "timed_out";
export type TaskRunAssurance = "unverified" | "partial" | "verified";
export type TaskRunEvidenceKind =
	| "provider_request"
	| "tool_decision"
	| "tool_result"
	| "approval"
	| "change"
	| "verification"
	| "cache"
	| "assistant"
	| "policy_violation";
export type TaskRunEvidenceOutcome =
	| "started"
	| "allowed"
	| "blocked"
	| "completed"
	| "failed"
	| "approved"
	| "rejected"
	| "passed";

export interface TaskRunBudget {
	maxDurationMs?: number;
	maxProviderRequests?: number;
	maxToolCalls?: number;
}

export interface TaskRunManifest {
	release: string;
	appVersion: string;
	commit?: string;
	features: readonly string[];
	model: {
		api: string;
		provider: string;
		id: string;
	};
	systemPromptHash: string;
	toolsHash: string;
	policyHash: string;
	workspaceHash: string;
	budget?: TaskRunBudget;
}

export interface TaskRunEvidence {
	id: string;
	kind: TaskRunEvidenceKind;
	sourceId: string;
	outcome: TaskRunEvidenceOutcome;
	subjectFingerprint?: string;
	metadata?: Readonly<Record<string, unknown>>;
	recordedAt: string;
}

export interface TaskRunMetrics {
	providerRequests: number;
	toolCalls: number;
	approvals: number;
	changes: number;
	verifications: number;
	durationMs: number;
}

export interface TaskRunState {
	id: string;
	sessionId: string;
	goal: string;
	status: TaskRunStatus;
	phase: TaskRunPhase;
	waitReason?: TaskRunWaitReason;
	conclusion?: TaskRunConclusion;
	completionReason?: string;
	assurance: TaskRunAssurance;
	manifest: TaskRunManifest;
	evidence: readonly TaskRunEvidence[];
	currentSubjectFingerprint?: string;
	lastVerifiedSubjectFingerprint?: string;
	sequence: number;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	metrics: TaskRunMetrics;
}

interface TaskRunEventBase {
	version: 1;
	id: string;
	runId: string;
	sequence: number;
	timestamp: string;
	idempotencyKey?: string;
}

export interface TaskRunStartedEvent extends TaskRunEventBase {
	type: "started";
	sessionId: string;
	goal: string;
	manifest: TaskRunManifest;
}

export interface TaskRunPhaseChangedEvent extends TaskRunEventBase {
	type: "phase_changed";
	phase: TaskRunPhase;
}

export interface TaskRunWaitingEvent extends TaskRunEventBase {
	type: "waiting";
	reason: TaskRunWaitReason;
}

export interface TaskRunResumedEvent extends TaskRunEventBase {
	type: "resumed";
}

export interface TaskRunEvidenceRecordedEvent extends TaskRunEventBase {
	type: "evidence_recorded";
	evidence: TaskRunEvidence;
}

export interface TaskRunFinishedEvent extends TaskRunEventBase {
	type: "finished";
	conclusion: TaskRunConclusion;
	reason?: string;
}

export type TaskRunEvent =
	| TaskRunStartedEvent
	| TaskRunPhaseChangedEvent
	| TaskRunWaitingEvent
	| TaskRunResumedEvent
	| TaskRunEvidenceRecordedEvent
	| TaskRunFinishedEvent;

export type TaskRunUpdate =
	| { type: "phase"; phase: TaskRunPhase }
	| { type: "wait"; reason: TaskRunWaitReason }
	| { type: "resume" }
	| {
			type: "evidence";
			evidence: Omit<TaskRunEvidence, "id" | "recordedAt">;
	  }
	| { type: "finish"; conclusion: TaskRunConclusion; reason?: string };

export interface TaskRunStartInput {
	sessionId: string;
	goal: string;
	manifest: TaskRunManifest;
	idempotencyKey?: string;
}

export interface TaskRunApplyOptions {
	idempotencyKey?: string;
}

export interface TaskRunJournal {
	append(event: TaskRunEvent): Promise<void>;
	read(): Promise<readonly TaskRunEvent[]>;
}

export interface TaskRunControllerOptions {
	journal: TaskRunJournal;
	createId?: () => string;
	now?: () => Date;
}

export class TaskRunError extends Error {
	readonly code:
		| "invalid_argument"
		| "invalid_event"
		| "invalid_transition"
		| "not_found";

	constructor(code: TaskRunError["code"], message: string) {
		super(message);
		this.name = "TaskRunError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

function isIsoTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isTaskRunPhase(value: unknown): value is TaskRunPhase {
	return (
		value === "discover" ||
		value === "execute" ||
		value === "verify" ||
		value === "deliver"
	);
}

function isTaskRunWaitReason(value: unknown): value is TaskRunWaitReason {
	return value === "approval" || value === "user" || value === "resource";
}

function isTaskRunConclusion(value: unknown): value is TaskRunConclusion {
	return (
		value === "success" ||
		value === "failure" ||
		value === "aborted" ||
		value === "timed_out"
	);
}

function isTaskRunEvidenceKind(value: unknown): value is TaskRunEvidenceKind {
	return (
		value === "provider_request" ||
		value === "tool_decision" ||
		value === "tool_result" ||
		value === "approval" ||
		value === "change" ||
		value === "verification" ||
		value === "cache" ||
		value === "assistant" ||
		value === "policy_violation"
	);
}

function isTaskRunEvidenceOutcome(value: unknown): value is TaskRunEvidenceOutcome {
	return (
		value === "started" ||
		value === "allowed" ||
		value === "blocked" ||
		value === "completed" ||
		value === "failed" ||
		value === "approved" ||
		value === "rejected" ||
		value === "passed"
	);
}

function parseBudget(value: unknown): TaskRunBudget | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new TaskRunError("invalid_event", "TaskRun budget is invalid");
	for (const field of ["maxDurationMs", "maxProviderRequests", "maxToolCalls"] as const) {
		if (value[field] !== undefined && !isPositiveInteger(value[field])) {
			throw new TaskRunError("invalid_event", `TaskRun budget ${field} is invalid`);
		}
	}
	return {
		...(value.maxDurationMs === undefined
			? {}
			: { maxDurationMs: value.maxDurationMs as number }),
		...(value.maxProviderRequests === undefined
			? {}
			: { maxProviderRequests: value.maxProviderRequests as number }),
		...(value.maxToolCalls === undefined
			? {}
			: { maxToolCalls: value.maxToolCalls as number }),
	};
}

function parseManifest(value: unknown): TaskRunManifest {
	if (!isRecord(value) || !isRecord(value.model)) {
		throw new TaskRunError("invalid_event", "TaskRun manifest is invalid");
	}
	if (
		!isNonEmptyString(value.release) ||
		!isNonEmptyString(value.appVersion) ||
		!isOptionalString(value.commit) ||
		!Array.isArray(value.features) ||
		!value.features.every((feature) => typeof feature === "string") ||
		!isNonEmptyString(value.model.api) ||
		!isNonEmptyString(value.model.provider) ||
		!isNonEmptyString(value.model.id) ||
		!isNonEmptyString(value.systemPromptHash) ||
		!isNonEmptyString(value.toolsHash) ||
		!isNonEmptyString(value.policyHash) ||
		!isNonEmptyString(value.workspaceHash)
	) {
		throw new TaskRunError("invalid_event", "TaskRun manifest fields are invalid");
	}
	return {
		release: value.release,
		appVersion: value.appVersion,
		...(value.commit === undefined ? {} : { commit: value.commit }),
		features: [...value.features] as string[],
		model: {
			api: value.model.api,
			provider: value.model.provider,
			id: value.model.id,
		},
		systemPromptHash: value.systemPromptHash,
		toolsHash: value.toolsHash,
		policyHash: value.policyHash,
		workspaceHash: value.workspaceHash,
		...(value.budget === undefined ? {} : { budget: parseBudget(value.budget) }),
	};
}

function parseEvidence(value: unknown): TaskRunEvidence {
	if (
		!isRecord(value) ||
		!isNonEmptyString(value.id) ||
		!isTaskRunEvidenceKind(value.kind) ||
		!isNonEmptyString(value.sourceId) ||
		!isTaskRunEvidenceOutcome(value.outcome) ||
		!isOptionalString(value.subjectFingerprint) ||
		(value.metadata !== undefined && !isRecord(value.metadata)) ||
		!isIsoTimestamp(value.recordedAt)
	) {
		throw new TaskRunError("invalid_event", "TaskRun evidence is invalid");
	}
	return {
		id: value.id,
		kind: value.kind,
		sourceId: value.sourceId,
		outcome: value.outcome,
		...(value.subjectFingerprint === undefined
			? {}
			: { subjectFingerprint: value.subjectFingerprint }),
		...(value.metadata === undefined
			? {}
			: { metadata: structuredClone(value.metadata) }),
		recordedAt: value.recordedAt,
	};
}

export function decodeTaskRunEvent(value: unknown): TaskRunEvent {
	if (
		!isRecord(value) ||
		value.version !== TASK_RUN_EVENT_VERSION ||
		!isNonEmptyString(value.id) ||
		!isNonEmptyString(value.runId) ||
		!isPositiveInteger(value.sequence) ||
		!isIsoTimestamp(value.timestamp) ||
		!isOptionalString(value.idempotencyKey)
	) {
		throw new TaskRunError("invalid_event", "TaskRun event envelope is invalid");
	}
	const base = {
		version: TASK_RUN_EVENT_VERSION,
		id: value.id,
		runId: value.runId,
		sequence: value.sequence,
		timestamp: value.timestamp,
		...(value.idempotencyKey === undefined
			? {}
			: { idempotencyKey: value.idempotencyKey }),
	} as const;
	if (value.type === "started") {
		if (
			!isNonEmptyString(value.sessionId) ||
			!isNonEmptyString(value.goal)
		) {
			throw new TaskRunError("invalid_event", "TaskRun start event is invalid");
		}
		return {
			...base,
			type: "started",
			sessionId: value.sessionId,
			goal: value.goal,
			manifest: parseManifest(value.manifest),
		};
	}
	if (value.type === "phase_changed" && isTaskRunPhase(value.phase)) {
		return { ...base, type: "phase_changed", phase: value.phase };
	}
	if (value.type === "waiting" && isTaskRunWaitReason(value.reason)) {
		return { ...base, type: "waiting", reason: value.reason };
	}
	if (value.type === "resumed") return { ...base, type: "resumed" };
	if (value.type === "evidence_recorded") {
		return {
			...base,
			type: "evidence_recorded",
			evidence: parseEvidence(value.evidence),
		};
	}
	if (value.type === "finished" && isTaskRunConclusion(value.conclusion)) {
		if (!isOptionalString(value.reason)) {
			throw new TaskRunError("invalid_event", "TaskRun finish reason is invalid");
		}
		return {
			...base,
			type: "finished",
			conclusion: value.conclusion,
			...(value.reason === undefined ? {} : { reason: value.reason }),
		};
	}
	throw new TaskRunError("invalid_event", `Unknown or invalid TaskRun event: ${String(value.type)}`);
}

function elapsedMs(startedAt: string, updatedAt: string): number {
	return Math.max(0, Date.parse(updatedAt) - Date.parse(startedAt));
}

function initialMetrics(): TaskRunMetrics {
	return {
		providerRequests: 0,
		toolCalls: 0,
		approvals: 0,
		changes: 0,
		verifications: 0,
		durationMs: 0,
	};
}

function addEvidenceMetrics(
	metrics: TaskRunMetrics,
	evidence: TaskRunEvidence,
): TaskRunMetrics {
	return {
		...metrics,
		providerRequests:
			metrics.providerRequests + (evidence.kind === "provider_request" ? 1 : 0),
		toolCalls:
			metrics.toolCalls +
			(evidence.kind === "tool_decision" && evidence.outcome === "allowed" ? 1 : 0),
		approvals:
			metrics.approvals +
			(evidence.kind === "approval" && evidence.outcome === "started" ? 1 : 0),
		changes:
			metrics.changes +
			(evidence.kind === "change" && evidence.outcome === "completed" ? 1 : 0),
		verifications:
			metrics.verifications +
			(evidence.kind === "verification" ? 1 : 0),
	};
}

function computeAssurance(
	state: TaskRunState,
	conclusion: TaskRunConclusion,
): TaskRunAssurance {
	if (conclusion !== "success") return "unverified";
	let latestCurrentVerification: TaskRunEvidence | undefined;
	for (let index = state.evidence.length - 1; index >= 0; index--) {
		const evidence = state.evidence[index];
		if (
			evidence?.kind === "verification" &&
			evidence.subjectFingerprint === state.currentSubjectFingerprint
		) {
			latestCurrentVerification = evidence;
			break;
		}
	}
	if (latestCurrentVerification?.outcome === "passed") {
		return "verified";
	}
	if (latestCurrentVerification !== undefined) return "unverified";
	if (
		state.evidence.some(
			(evidence) =>
				evidence.kind === "verification" && evidence.outcome === "passed",
		)
	) {
		return "partial";
	}
	return "unverified";
}

function evolveTaskRun(
	state: TaskRunState | undefined,
	event: TaskRunEvent,
): TaskRunState {
	if (state === undefined) {
		if (event.type !== "started" || event.sequence !== 1) {
			throw new TaskRunError("invalid_event", "TaskRun must begin with sequence 1 start event");
		}
		return {
			id: event.runId,
			sessionId: event.sessionId,
			goal: event.goal,
			status: "active",
			phase: "discover",
			assurance: "unverified",
			manifest: event.manifest,
			evidence: [],
			currentSubjectFingerprint: event.manifest.workspaceHash,
			sequence: event.sequence,
			startedAt: event.timestamp,
			updatedAt: event.timestamp,
			metrics: initialMetrics(),
		};
	}
	if (event.runId !== state.id || event.sequence !== state.sequence + 1) {
		throw new TaskRunError("invalid_event", "TaskRun event sequence is not contiguous");
	}
	if (state.status === "terminal") {
		throw new TaskRunError("invalid_transition", "Terminal TaskRun cannot accept more events");
	}
	const common = {
		...state,
		sequence: event.sequence,
		updatedAt: event.timestamp,
		metrics: {
			...state.metrics,
			durationMs: elapsedMs(state.startedAt, event.timestamp),
		},
	};
	if (event.type === "started") {
		throw new TaskRunError("invalid_transition", "TaskRun cannot be started twice");
	}
	if (event.type === "phase_changed") {
		if (state.status !== "active") {
			throw new TaskRunError("invalid_transition", "Waiting TaskRun must resume before changing phase");
		}
		return { ...common, phase: event.phase };
	}
	if (event.type === "waiting") {
		if (state.status !== "active") {
			throw new TaskRunError("invalid_transition", "Only active TaskRun can begin waiting");
		}
		return { ...common, status: "waiting", waitReason: event.reason };
	}
	if (event.type === "resumed") {
		if (state.status !== "waiting") {
			throw new TaskRunError("invalid_transition", "Only waiting TaskRun can resume");
		}
		return { ...common, status: "active", waitReason: undefined };
	}
	if (event.type === "evidence_recorded") {
		if (state.evidence.some((evidence) => evidence.id === event.evidence.id)) {
			throw new TaskRunError("invalid_event", `Duplicate evidence: ${event.evidence.id}`);
		}
		const evidence = [...state.evidence, event.evidence];
		const metrics = addEvidenceMetrics(common.metrics, event.evidence);
		if (
			event.evidence.kind === "change" &&
			event.evidence.outcome === "completed"
		) {
			if (!event.evidence.subjectFingerprint) {
				throw new TaskRunError(
					"invalid_event",
					"Completed change evidence requires a subject fingerprint",
				);
			}
			return {
				...common,
				evidence,
				metrics,
				currentSubjectFingerprint: event.evidence.subjectFingerprint,
			};
		}
		if (
			event.evidence.kind === "verification" &&
			event.evidence.outcome === "passed" &&
			event.evidence.subjectFingerprint !== undefined
		) {
			return {
				...common,
				evidence,
				metrics,
				lastVerifiedSubjectFingerprint: event.evidence.subjectFingerprint,
			};
		}
		return { ...common, evidence, metrics };
	}
	const assurance = computeAssurance(state, event.conclusion);
	return {
		...common,
		status: "terminal",
		waitReason: undefined,
		conclusion: event.conclusion,
		...(event.reason === undefined ? {} : { completionReason: event.reason }),
		assurance,
		completedAt: event.timestamp,
	};
}

export function reduceTaskRunEvents(
	events: readonly TaskRunEvent[],
): TaskRunState {
	if (events.length === 0) {
		throw new TaskRunError("not_found", "TaskRun has no events");
	}
	let state: TaskRunState | undefined;
	for (const event of events) state = evolveTaskRun(state, event);
	if (!state) throw new TaskRunError("not_found", "TaskRun has no state");
	return state;
}

function validateStartInput(input: TaskRunStartInput): void {
	if (!isNonEmptyString(input.sessionId)) {
		throw new TaskRunError("invalid_argument", "TaskRun sessionId is required");
	}
	if (!isNonEmptyString(input.goal)) {
		throw new TaskRunError("invalid_argument", "TaskRun goal is required");
	}
	parseManifest(input.manifest);
}

function taskRunEvents(
	events: readonly TaskRunEvent[],
	runId: string,
): TaskRunEvent[] {
	return events
		.filter((event) => event.runId === runId)
		.sort((left, right) => left.sequence - right.sequence);
}

export class TaskRunController {
	private readonly journal: TaskRunJournal;
	private readonly createId: () => string;
	private readonly now: () => Date;
	private mutation = Promise.resolve();

	constructor(options: TaskRunControllerOptions) {
		this.journal = options.journal;
		this.createId = options.createId ?? randomUUID;
		this.now = options.now ?? (() => new Date());
	}

	async start(input: TaskRunStartInput): Promise<TaskRunState> {
		validateStartInput(input);
		return await this.serialized(async () => {
			const existing = input.idempotencyKey
				? (await this.journal.read()).find(
						(event) =>
							event.type === "started" &&
							event.idempotencyKey === input.idempotencyKey,
					)
				: undefined;
			if (existing) return await this.get(existing.runId);
			const runId = this.createId();
			const event: TaskRunStartedEvent = {
				version: TASK_RUN_EVENT_VERSION,
				id: this.createId(),
				runId,
				sequence: 1,
				timestamp: this.now().toISOString(),
				...(input.idempotencyKey === undefined
					? {}
					: { idempotencyKey: input.idempotencyKey }),
				type: "started",
				sessionId: input.sessionId,
				goal: input.goal.trim(),
				manifest: structuredClone(input.manifest),
			};
			await this.journal.append(event);
			return reduceTaskRunEvents([event]);
		});
	}

	async apply(
		runId: string,
		update: TaskRunUpdate,
		options: TaskRunApplyOptions = {},
	): Promise<TaskRunState> {
		if (!isNonEmptyString(runId)) {
			throw new TaskRunError("invalid_argument", "TaskRun id is required");
		}
		return await this.serialized(async () => {
			const allEvents = await this.journal.read();
			const events = taskRunEvents(allEvents, runId);
			if (events.length === 0) throw new TaskRunError("not_found", `TaskRun not found: ${runId}`);
			if (options.idempotencyKey) {
				const duplicate = events.find(
					(event) => event.idempotencyKey === options.idempotencyKey,
				);
				if (duplicate) return reduceTaskRunEvents(events);
			}
			const state = reduceTaskRunEvents(events);
			const base = {
				version: TASK_RUN_EVENT_VERSION,
				id: this.createId(),
				runId,
				sequence: state.sequence + 1,
				timestamp: this.now().toISOString(),
				...(options.idempotencyKey === undefined
					? {}
					: { idempotencyKey: options.idempotencyKey }),
			} as const;
			let event: TaskRunEvent;
			if (update.type === "phase") {
				event = { ...base, type: "phase_changed", phase: update.phase };
			} else if (update.type === "wait") {
				event = { ...base, type: "waiting", reason: update.reason };
			} else if (update.type === "resume") {
				event = { ...base, type: "resumed" };
			} else if (update.type === "evidence") {
				event = {
					...base,
					type: "evidence_recorded",
					evidence: {
						...structuredClone(update.evidence),
						id: this.createId(),
						recordedAt: base.timestamp,
					},
				};
			} else {
				event = {
					...base,
					type: "finished",
					conclusion: update.conclusion,
					...(update.reason === undefined ? {} : { reason: update.reason }),
				};
			}
			const next = evolveTaskRun(state, event);
			await this.journal.append(event);
			return next;
		});
	}

	async get(runId: string): Promise<TaskRunState> {
		const events = taskRunEvents(await this.journal.read(), runId);
		if (events.length === 0) throw new TaskRunError("not_found", `TaskRun not found: ${runId}`);
		return reduceTaskRunEvents(events);
	}

	async list(): Promise<TaskRunState[]> {
		const events = await this.journal.read();
		const runIds = [...new Set(events.map((event) => event.runId))];
		const states = runIds.map((runId) =>
			reduceTaskRunEvents(taskRunEvents(events, runId)),
		);
		return states.sort((left, right) =>
			right.startedAt.localeCompare(left.startedAt),
		);
	}

	private async serialized<TResult>(
		operation: () => Promise<TResult>,
	): Promise<TResult> {
		const previous = this.mutation;
		let release = () => {};
		this.mutation = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

export class InMemoryTaskRunJournal implements TaskRunJournal {
	private readonly events: TaskRunEvent[] = [];

	async append(event: TaskRunEvent): Promise<void> {
		this.events.push(structuredClone(event));
	}

	async read(): Promise<readonly TaskRunEvent[]> {
		return structuredClone(this.events);
	}
}
