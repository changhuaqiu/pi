import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	decodeTaskRunEvidence,
	decodeTaskRunManifest,
	type TaskRunEvidence,
	type TaskRunEvidenceInput,
	type TaskRunManifest,
} from "./task-run.ts";

export const EXECUTION_EVENT_VERSION = 1;

export type ExecutionOutcome = "completed" | "failed" | "aborted" | "timed_out";
export type ExecutionStatus = "active" | "terminal";
export type ExecutionMessageRole = "user" | "assistant" | "tool_result";

export interface ExecutionStrategyIdentity {
	version: string;
	manifest: TaskRunManifest;
	thinkingLevel: string;
	streamOptionsHash: string;
	contextPolicyHash: string;
}

interface ExecutionEventBase {
	version: 1;
	id: string;
	executionId: string;
	sequence: number;
	timestamp: string;
	idempotencyKey?: string;
}

export interface ExecutionStartedEvent extends ExecutionEventBase {
	type: "started";
	sessionId: string;
	branchParentEntryId: string | null;
	strategy: ExecutionStrategyIdentity;
}

export interface ExecutionSessionEntryLinkedEvent extends ExecutionEventBase {
	type: "session_entry_linked";
	entryId: string;
	role: ExecutionMessageRole;
}

export interface ExecutionFactRecordedEvent extends ExecutionEventBase {
	type: "fact_recorded";
	evidence: TaskRunEvidence;
}

export interface ExecutionTaskRunLinkedEvent extends ExecutionEventBase {
	type: "task_run_linked";
	runId: string;
}

export interface ExecutionFinishedEvent extends ExecutionEventBase {
	type: "finished";
	outcome: ExecutionOutcome;
	lastEntryId: string | null;
}

export type ExecutionEvent =
	| ExecutionStartedEvent
	| ExecutionSessionEntryLinkedEvent
	| ExecutionFactRecordedEvent
	| ExecutionTaskRunLinkedEvent
	| ExecutionFinishedEvent;

export interface ExecutionEntryLink {
	eventId: string;
	sequence: number;
	timestamp: string;
	entryId: string;
	role: ExecutionMessageRole;
}

export interface ExecutionFact {
	eventId: string;
	sequence: number;
	evidence: TaskRunEvidence;
}

export interface ExecutionState {
	id: string;
	sessionId: string;
	branchParentEntryId: string | null;
	strategy: ExecutionStrategyIdentity;
	status: ExecutionStatus;
	entryLinks: readonly ExecutionEntryLink[];
	facts: readonly ExecutionFact[];
	runId?: string;
	outcome?: ExecutionOutcome;
	lastEntryId?: string | null;
	sequence: number;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
}

export interface ExecutionStartInput {
	executionId: string;
	sessionId: string;
	branchParentEntryId: string | null;
	strategy: ExecutionStrategyIdentity;
	idempotencyKey?: string;
}

export type ExecutionUpdate =
	| { type: "link_session_entry"; entryId: string; role: ExecutionMessageRole }
	| { type: "fact"; evidence: TaskRunEvidenceInput }
	| { type: "link_task_run"; runId: string }
	| { type: "finish"; outcome: ExecutionOutcome; lastEntryId: string | null };

export interface ExecutionJournal {
	append(event: ExecutionEvent): Promise<void>;
	read(): Promise<readonly ExecutionEvent[]>;
}

export interface ExecutionControllerOptions {
	journal: ExecutionJournal;
	createId?: () => string;
	now?: () => Date;
}

export class ExecutionJournalError extends Error {
	readonly code:
		| "invalid_argument"
		| "invalid_event"
		| "invalid_transition"
		| "not_found";

	constructor(code: ExecutionJournalError["code"], message: string) {
		super(message);
		this.name = "ExecutionJournalError";
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

function isExecutionOutcome(value: unknown): value is ExecutionOutcome {
	return (
		value === "completed" ||
		value === "failed" ||
		value === "aborted" ||
		value === "timed_out"
	);
}

function isExecutionMessageRole(value: unknown): value is ExecutionMessageRole {
	return value === "user" || value === "assistant" || value === "tool_result";
}

function decodeStrategy(value: unknown): ExecutionStrategyIdentity {
	if (
		!isRecord(value) ||
		!isNonEmptyString(value.version) ||
		!isNonEmptyString(value.thinkingLevel) ||
		!isNonEmptyString(value.streamOptionsHash) ||
		!isNonEmptyString(value.contextPolicyHash)
	) {
		throw new ExecutionJournalError(
			"invalid_event",
			"Execution strategy identity is invalid",
		);
	}
	return {
		version: value.version,
		manifest: decodeTaskRunManifest(value.manifest),
		thinkingLevel: value.thinkingLevel,
		streamOptionsHash: value.streamOptionsHash,
		contextPolicyHash: value.contextPolicyHash,
	};
}

export function decodeExecutionEvent(value: unknown): ExecutionEvent {
	if (
		!isRecord(value) ||
		value.version !== EXECUTION_EVENT_VERSION ||
		!isNonEmptyString(value.id) ||
		!isNonEmptyString(value.executionId) ||
		!isPositiveInteger(value.sequence) ||
		!isIsoTimestamp(value.timestamp) ||
		!isOptionalString(value.idempotencyKey)
	) {
		throw new ExecutionJournalError(
			"invalid_event",
			"Execution event envelope is invalid",
		);
	}
	const base = {
		version: EXECUTION_EVENT_VERSION,
		id: value.id,
		executionId: value.executionId,
		sequence: value.sequence,
		timestamp: value.timestamp,
		...(value.idempotencyKey === undefined
			? {}
			: { idempotencyKey: value.idempotencyKey }),
	} as const;
	if (value.type === "started") {
		if (
			!isNonEmptyString(value.sessionId) ||
			(value.branchParentEntryId !== null &&
				!isNonEmptyString(value.branchParentEntryId))
		) {
			throw new ExecutionJournalError(
				"invalid_event",
				"Execution start event is invalid",
			);
		}
		return {
			...base,
			type: "started",
			sessionId: value.sessionId,
			branchParentEntryId: value.branchParentEntryId,
			strategy: decodeStrategy(value.strategy),
		};
	}
	if (
		value.type === "session_entry_linked" &&
		isNonEmptyString(value.entryId) &&
		isExecutionMessageRole(value.role)
	) {
		return {
			...base,
			type: "session_entry_linked",
			entryId: value.entryId,
			role: value.role,
		};
	}
	if (value.type === "fact_recorded") {
		return {
			...base,
			type: "fact_recorded",
			evidence: decodeTaskRunEvidence(value.evidence),
		};
	}
	if (value.type === "task_run_linked" && isNonEmptyString(value.runId)) {
		return { ...base, type: "task_run_linked", runId: value.runId };
	}
	if (
		value.type === "finished" &&
		isExecutionOutcome(value.outcome) &&
		(value.lastEntryId === null || isNonEmptyString(value.lastEntryId))
	) {
		return {
			...base,
			type: "finished",
			outcome: value.outcome,
			lastEntryId: value.lastEntryId,
		};
	}
	throw new ExecutionJournalError(
		"invalid_event",
		`Unknown or invalid Execution event: ${String(value.type)}`,
	);
}

function evolveExecution(
	state: ExecutionState | undefined,
	event: ExecutionEvent,
): ExecutionState {
	if (state === undefined) {
		if (event.type !== "started" || event.sequence !== 1) {
			throw new ExecutionJournalError(
				"invalid_event",
				"Execution must begin with sequence 1 start event",
			);
		}
		return {
			id: event.executionId,
			sessionId: event.sessionId,
			branchParentEntryId: event.branchParentEntryId,
			strategy: event.strategy,
			status: "active",
			entryLinks: [],
			facts: [],
			sequence: 1,
			startedAt: event.timestamp,
			updatedAt: event.timestamp,
		};
	}
	if (
		event.executionId !== state.id ||
		event.sequence !== state.sequence + 1
	) {
		throw new ExecutionJournalError(
			"invalid_event",
			"Execution event sequence is not contiguous",
		);
	}
	if (state.status === "terminal") {
		throw new ExecutionJournalError(
			"invalid_transition",
			"Terminal Execution cannot accept more events",
		);
	}
	const common = {
		...state,
		sequence: event.sequence,
		updatedAt: event.timestamp,
	};
	if (event.type === "started") {
		throw new ExecutionJournalError(
			"invalid_transition",
			"Execution cannot be started twice",
		);
	}
	if (event.type === "session_entry_linked") {
		if (state.entryLinks.some((link) => link.entryId === event.entryId)) {
			throw new ExecutionJournalError(
				"invalid_event",
				`Session entry is already linked: ${event.entryId}`,
			);
		}
		return {
			...common,
			entryLinks: [
				...state.entryLinks,
				{
					eventId: event.id,
					sequence: event.sequence,
					timestamp: event.timestamp,
					entryId: event.entryId,
					role: event.role,
				},
			],
		};
	}
	if (event.type === "fact_recorded") {
		if (state.facts.some((fact) => fact.evidence.id === event.evidence.id)) {
			throw new ExecutionJournalError(
				"invalid_event",
				`Execution fact is already recorded: ${event.evidence.id}`,
			);
		}
		return {
			...common,
			facts: [
				...state.facts,
				{
					eventId: event.id,
					sequence: event.sequence,
					evidence: event.evidence,
				},
			],
		};
	}
	if (event.type === "task_run_linked") {
		if (state.runId !== undefined) {
			throw new ExecutionJournalError(
				"invalid_transition",
				"Execution already has a TaskRun",
			);
		}
		return { ...common, runId: event.runId };
	}
	return {
		...common,
		status: "terminal",
		outcome: event.outcome,
		lastEntryId: event.lastEntryId,
		completedAt: event.timestamp,
	};
}

export function reduceExecutionEvents(
	events: readonly ExecutionEvent[],
): ExecutionState {
	if (events.length === 0) {
		throw new ExecutionJournalError("not_found", "Execution has no events");
	}
	let state: ExecutionState | undefined;
	for (const event of events) state = evolveExecution(state, event);
	if (!state) {
		throw new ExecutionJournalError("not_found", "Execution has no state");
	}
	return state;
}

function executionEvents(
	events: readonly ExecutionEvent[],
	executionId: string,
): ExecutionEvent[] {
	return events
		.filter((event) => event.executionId === executionId)
		.sort((left, right) => left.sequence - right.sequence);
}

function validateStartInput(input: ExecutionStartInput): void {
	if (!isNonEmptyString(input.executionId)) {
		throw new ExecutionJournalError(
			"invalid_argument",
			"Execution id is required",
		);
	}
	if (!isNonEmptyString(input.sessionId)) {
		throw new ExecutionJournalError(
			"invalid_argument",
			"Execution sessionId is required",
		);
	}
	if (
		input.branchParentEntryId !== null &&
		!isNonEmptyString(input.branchParentEntryId)
	) {
		throw new ExecutionJournalError(
			"invalid_argument",
			"Execution branch parent is invalid",
		);
	}
	decodeStrategy(input.strategy);
}

function startMatchesInput(
	event: ExecutionStartedEvent,
	input: ExecutionStartInput,
): boolean {
	return (
		event.executionId === input.executionId &&
		event.sessionId === input.sessionId &&
		event.branchParentEntryId === input.branchParentEntryId &&
		isDeepStrictEqual(event.strategy, input.strategy)
	);
}

function eventMatchesUpdate(
	event: ExecutionEvent,
	update: ExecutionUpdate,
): boolean {
	if (event.type === "session_entry_linked" && update.type === "link_session_entry") {
		return event.entryId === update.entryId && event.role === update.role;
	}
	if (event.type === "fact_recorded" && update.type === "fact") {
		const { id: _id, recordedAt: _recordedAt, ...evidence } = event.evidence;
		return isDeepStrictEqual(evidence, update.evidence);
	}
	if (event.type === "task_run_linked" && update.type === "link_task_run") {
		return event.runId === update.runId;
	}
	if (event.type === "finished" && update.type === "finish") {
		return event.outcome === update.outcome && event.lastEntryId === update.lastEntryId;
	}
	return false;
}

export class ExecutionController {
	private readonly journal: ExecutionJournal;
	private readonly createId: () => string;
	private readonly now: () => Date;
	private mutation = Promise.resolve();

	constructor(options: ExecutionControllerOptions) {
		this.journal = options.journal;
		this.createId = options.createId ?? randomUUID;
		this.now = options.now ?? (() => new Date());
	}

	async start(input: ExecutionStartInput): Promise<ExecutionState> {
		validateStartInput(input);
		return await this.serialized(async () => {
			const allEvents = await this.journal.read();
			const existingEvents = executionEvents(allEvents, input.executionId);
			if (existingEvents.length > 0) {
				const existingStart = existingEvents[0];
				if (
					input.idempotencyKey !== undefined &&
					existingStart?.type === "started" &&
					existingStart.idempotencyKey === input.idempotencyKey
				) {
					if (!startMatchesInput(existingStart, input)) {
						throw new ExecutionJournalError(
							"invalid_event",
							`Execution idempotency key reused with different start input: ${input.idempotencyKey}`,
						);
					}
					return reduceExecutionEvents(existingEvents);
				}
				throw new ExecutionJournalError(
					"invalid_transition",
					`Execution already exists: ${input.executionId}`,
				);
			}
			const event: ExecutionStartedEvent = {
				version: EXECUTION_EVENT_VERSION,
				id: this.createId(),
				executionId: input.executionId,
				sequence: 1,
				timestamp: this.now().toISOString(),
				...(input.idempotencyKey === undefined
					? {}
					: { idempotencyKey: input.idempotencyKey }),
				type: "started",
				sessionId: input.sessionId,
				branchParentEntryId: input.branchParentEntryId,
				strategy: structuredClone(input.strategy),
			};
			await this.journal.append(event);
			return reduceExecutionEvents([event]);
		});
	}

	async apply(
		executionId: string,
		update: ExecutionUpdate,
		options: { idempotencyKey?: string } = {},
	): Promise<ExecutionState> {
		if (!isNonEmptyString(executionId)) {
			throw new ExecutionJournalError(
				"invalid_argument",
				"Execution id is required",
			);
		}
		return await this.serialized(async () => {
			const events = executionEvents(await this.journal.read(), executionId);
			if (events.length === 0) {
				throw new ExecutionJournalError(
					"not_found",
					`Execution not found: ${executionId}`,
				);
			}
			if (options.idempotencyKey !== undefined) {
				const duplicate = events.find(
					(event) => event.idempotencyKey === options.idempotencyKey,
				);
				if (duplicate) {
					if (!eventMatchesUpdate(duplicate, update)) {
						throw new ExecutionJournalError(
							"invalid_event",
							`Execution idempotency key reused with different update: ${options.idempotencyKey}`,
						);
					}
					return reduceExecutionEvents(events);
				}
			}
			const state = reduceExecutionEvents(events);
			const base = {
				version: EXECUTION_EVENT_VERSION,
				id: this.createId(),
				executionId,
				sequence: state.sequence + 1,
				timestamp: this.now().toISOString(),
				...(options.idempotencyKey === undefined
					? {}
					: { idempotencyKey: options.idempotencyKey }),
			} as const;
			let event: ExecutionEvent;
			if (update.type === "link_session_entry") {
				event = {
					...base,
					type: "session_entry_linked",
					entryId: update.entryId,
					role: update.role,
				};
			} else if (update.type === "fact") {
				event = {
					...base,
					type: "fact_recorded",
					evidence: {
						...structuredClone(update.evidence),
						id: this.createId(),
						recordedAt: base.timestamp,
					},
				};
			} else if (update.type === "link_task_run") {
				event = { ...base, type: "task_run_linked", runId: update.runId };
			} else {
				event = {
					...base,
					type: "finished",
					outcome: update.outcome,
					lastEntryId: update.lastEntryId,
				};
			}
			const next = evolveExecution(state, event);
			await this.journal.append(event);
			return next;
		});
	}

	async get(executionId: string): Promise<ExecutionState> {
		const events = await this.getEvents(executionId);
		if (events.length === 0) {
			throw new ExecutionJournalError(
				"not_found",
				`Execution not found: ${executionId}`,
			);
		}
		return reduceExecutionEvents(events);
	}

	async getEvents(executionId: string): Promise<readonly ExecutionEvent[]> {
		if (!isNonEmptyString(executionId)) {
			throw new ExecutionJournalError(
				"invalid_argument",
				"Execution id is required",
			);
		}
		return executionEvents(await this.journal.read(), executionId);
	}

	async list(): Promise<ExecutionState[]> {
		const events = await this.journal.read();
		const executionIds = [
			...new Set(events.map((event) => event.executionId)),
		];
		return executionIds
			.map((executionId) =>
				reduceExecutionEvents(executionEvents(events, executionId)),
			)
			.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
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

export class InMemoryExecutionJournal implements ExecutionJournal {
	private readonly events: ExecutionEvent[] = [];

	async append(event: ExecutionEvent): Promise<void> {
		this.events.push(structuredClone(event));
	}

	async read(): Promise<readonly ExecutionEvent[]> {
		return structuredClone(this.events);
	}
}
