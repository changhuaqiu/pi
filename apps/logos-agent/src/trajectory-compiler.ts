import { createHmac } from "node:crypto";
import type {
	AgentMessage,
	SessionTreeEntry,
} from "../../../packages/agent/src/index.ts";
import type {
	ExecutionEvent,
	ExecutionMessageRole,
	ExecutionState,
} from "./execution-journal.ts";
import type {
	TaskRunEvidence,
	TaskRunEvidenceKind,
	TaskRunEvidenceOutcome,
	TaskRunEvent,
	TaskRunState,
} from "./task-run.ts";

export const TRAJECTORY_SCHEMA_VERSION = 1;
export const TRAJECTORY_COMPILER_VERSION = "p1-v1";
export const TRAJECTORY_PROJECTION_VERSION = "private-v1";

export type TrajectoryStatus = "active" | "terminal";
export type TrajectoryOutcome = "completed" | "failed" | "aborted" | "timed_out";
export type TrajectoryPhase = "discover" | "execute" | "verify" | "deliver";

export interface CanonicalTrajectoryRecordV1 {
	schemaVersion: 1;
	compilerVersion: string;
	projectionVersion: string;
	projectionDomainId: string;
	digestScheme: "hmac_sha256";
	digestKeyVersion: string;
	executionId: string;
	sessionId: string;
	runId?: string;
	strategy: TrajectoryStrategyIdentity;
	task: TrajectoryTaskDefinition;
	contentIndex: readonly TrajectoryContentReference[];
	steps: readonly TrajectoryStep[];
	evidenceIndex: readonly TrajectoryEvidenceReference[];
	coverage: readonly TrajectoryCoverageAttestation[];
	artifacts: readonly TrajectoryArtifactReference[];
	metrics?: TrajectoryMetrics;
	completeness: TrajectoryCompleteness;
	status: TrajectoryStatus;
	outcome?: TrajectoryOutcome;
	sourceSnapshotDigest: string;
	trajectoryDigest: string;
	startedAt: string;
	completedAt?: string;
}

export interface TrajectoryStrategyIdentity {
	version: string;
	release: string;
	appVersion: string;
	commit?: string;
	features: readonly string[];
	api: string;
	provider: string;
	model: string;
	modelRevision: string;
	thinkingLevel: string;
	systemPromptHash: string;
	toolsHash: string;
	policyHash: string;
	contextPolicyHash: string;
	streamOptionsHash: string;
	budgetHash: string;
}

export interface TrajectoryTaskDefinition {
	originalGoalRef: string;
	constraints: readonly TrajectoryTaskRequirement[];
	acceptanceCriteria: readonly TrajectoryTaskRequirement[];
}

export interface TrajectoryTaskRequirement {
	id: string;
	statementRef: string;
	source: "user" | "workspace_instruction" | "test_oracle" | "generated";
	required: boolean;
}

export interface TrajectoryContentReference {
	id: string;
	digest: string;
	digestScheme: "hmac_sha256";
	storage: "session";
	sourceId: string;
	available: boolean;
	sensitivity: "workspace_private" | "user_private";
	exportPolicy: "local_only";
}

export interface TrajectoryStep {
	id: string;
	sequence: number;
	phase: TrajectoryPhase;
	kind:
		| "model_request"
		| "assistant_message"
		| "tool_decision"
		| "tool_result"
		| "workspace_change"
		| "verification"
		| "approval"
		| "user_input"
		| "checkpoint";
	name?: string;
	outcome: TaskRunEvidenceOutcome | "completed" | "aborted";
	evidenceRefs: readonly string[];
	evidenceKind?: TaskRunEvidenceKind;
	subjectFingerprint?: string;
}

export interface TrajectoryMetrics {
	providerRequests: number;
	toolCalls: number;
	approvals: number;
	changes: number;
	verifications: number;
	networkQueries: number;
	durationMs: number;
}

export interface TrajectoryLogicalLocator {
	kind: "session_entry" | "execution_event" | "task_run_event";
	value: string;
}

export interface TrajectoryEvidenceReference {
	id: string;
	source: "session_entry" | "execution_event" | "task_run_event";
	sourceId: string;
	digest: string;
	digestScheme: "hmac_sha256";
	locator: TrajectoryLogicalLocator;
	available: boolean;
	sensitive: true;
	exportPolicy: "local_only";
}

export interface TrajectoryArtifactReference {
	id: string;
	kind: "final_answer";
	digest: string;
	digestScheme: "hmac_sha256";
	locator: TrajectoryLogicalLocator;
	evidenceRef: string;
	sensitive: true;
	exportPolicy: "local_only";
}

export interface TrajectoryCompleteness {
	canonicalFacts: "complete" | "partial";
	missingSources: readonly string[];
}

export interface TrajectoryCoverageAttestation {
	capability:
		| "filesystem"
		| "process"
		| "network"
		| "approval"
		| "external_mutation";
	status: "complete" | "partial" | "unknown";
	enforcementVersion: string;
	evidenceRefs: readonly string[];
}

export interface TrajectoryCompilerOptions {
	digestKey: Uint8Array;
	digestKeyVersion?: string;
}

export interface TrajectoryCompileInput {
	execution: ExecutionState;
	executionEvents?: readonly ExecutionEvent[];
	sessionEntries: readonly SessionTreeEntry[];
	taskRun?: TaskRunState;
	taskRunEvents?: readonly TaskRunEvent[];
}

interface LinkedMessage {
	sequence: number;
	timestamp: string;
	eventId: string;
	entryId: string;
	role: ExecutionMessageRole;
	entry?: Extract<SessionTreeEntry, { type: "message" }>;
	projectedContent?: unknown;
	evidenceId: string;
	contentId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCanonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeCanonicalValue);
	if (typeof value === "string") {
		return value.normalize("NFC").replace(/\r\n?/g, "\n");
	}
	if (
		value === null ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (!isRecord(value)) return String(value);
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, child]) => [key, normalizeCanonicalValue(child)]),
	);
}

export function canonicalTrajectoryJson(value: unknown): string {
	return JSON.stringify(normalizeCanonicalValue(value));
}

function projectMessageContent(message: AgentMessage): unknown {
	if (message.role === "user") {
		if (typeof message.content === "string") return message.content;
		return message.content.map((item) => {
			if (item.type === "text") return { type: "text", text: item.text };
			return {
				type: "image",
				mimeType: item.mimeType,
				data: item.data,
			};
		});
	}
	if (message.role === "assistant") {
		const content: unknown[] = [];
		for (const item of message.content) {
			if (item.type === "thinking") continue;
			if (item.type === "text") {
				content.push({ type: "text", text: item.text });
				continue;
			}
			content.push({
				type: "tool_call",
				id: item.id,
				name: item.name,
				arguments: item.arguments,
			});
		}
		return content;
	}
	if (message.role === "toolResult") {
		return {
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			isError: message.isError,
			content: message.content.map((item) =>
				item.type === "text"
					? { type: "text", text: item.text }
					: { type: "image", mimeType: item.mimeType, data: item.data },
			),
		};
	}
	return { role: message.role };
}

function phaseForEvidence(evidence: TaskRunEvidence): TrajectoryPhase {
	if (evidence.kind === "change") return "execute";
	if (evidence.kind === "verification") return "verify";
	if (evidence.kind === "assistant") return "deliver";
	return "discover";
}

function kindForEvidence(evidence: TaskRunEvidence): TrajectoryStep["kind"] {
	if (evidence.kind === "provider_request") return "model_request";
	if (evidence.kind === "tool_decision") return "tool_decision";
	if (evidence.kind === "change") return "workspace_change";
	if (evidence.kind === "verification") return "verification";
	if (evidence.kind === "approval") return "approval";
	if (evidence.kind === "assistant") return "assistant_message";
	return "tool_result";
}

function roleForEntry(
	entry: Extract<SessionTreeEntry, { type: "message" }>,
): ExecutionMessageRole | undefined {
	if (entry.message.role === "user") return "user";
	if (entry.message.role === "assistant") return "assistant";
	if (entry.message.role === "toolResult") return "tool_result";
	return undefined;
}

function evidenceName(evidence: TaskRunEvidence): string | undefined {
	const toolName = evidence.metadata?.toolName;
	return typeof toolName === "string" ? toolName : undefined;
}

function comparableEvidence(evidence: TaskRunEvidence): TaskRunEvidenceInputShape {
	const { id: _id, recordedAt: _recordedAt, ...input } = evidence;
	return input;
}

type TaskRunEvidenceInputShape = Omit<TaskRunEvidence, "id" | "recordedAt">;

interface StepCandidate {
	anchorSequence: number;
	sourceOrder: number;
	sourceSequence: number;
	step: Omit<TrajectoryStep, "sequence">;
}

export class TrajectoryCompiler {
	private readonly digestKey: Uint8Array;
	private readonly digestKeyVersion: string;
	private readonly projectionDomainId: string;

	constructor(options: TrajectoryCompilerOptions) {
		if (options.digestKey.byteLength < 32) {
			throw new Error("Trajectory digest key must contain at least 32 bytes");
		}
		this.digestKey = new Uint8Array(options.digestKey);
		this.digestKeyVersion = options.digestKeyVersion ?? "local-v1";
		this.projectionDomainId = this.digest("logos-agent:private-domain").slice(
			0,
			24,
		);
	}

	compile(input: TrajectoryCompileInput): CanonicalTrajectoryRecordV1 {
		const { execution, taskRun } = input;
		if (taskRun !== undefined && taskRun.executionId !== execution.id) {
			throw new Error(
				`TaskRun ${taskRun.id} belongs to execution ${taskRun.executionId}, not ${execution.id}`,
			);
		}
		if (taskRun !== undefined && execution.runId !== taskRun.id) {
			throw new Error(
				`Execution ${execution.id} does not link TaskRun ${taskRun.id}`,
			);
		}

		const missingSources: string[] = [];
		if (execution.status === "active") {
			missingSources.push("execution_finished");
		}
		const executionEventsById = new Map<string, ExecutionEvent>();
		for (const event of input.executionEvents ?? []) {
			if (event.executionId !== execution.id) {
				missingSources.push(`source_conflict:execution_event:${event.id}`);
				continue;
			}
			const existing = executionEventsById.get(event.id);
			if (existing === undefined) {
				executionEventsById.set(event.id, event);
				continue;
			}
			if (canonicalTrajectoryJson(existing) !== canonicalTrajectoryJson(event)) {
				missingSources.push(`source_conflict:execution_event:${event.id}`);
			}
		}
		const executionEvents = [...executionEventsById.values()].sort(
			(left, right) => left.sequence - right.sequence,
		);
		if (executionEvents.length === 0) {
			missingSources.push(`execution_events:${execution.id}`);
		}
		const entriesById = new Map<string, SessionTreeEntry>();
		for (const entry of input.sessionEntries) {
			const existing = entriesById.get(entry.id);
			if (existing === undefined) {
				entriesById.set(entry.id, entry);
				continue;
			}
			if (canonicalTrajectoryJson(existing) !== canonicalTrajectoryJson(entry)) {
				missingSources.push(`source_conflict:session_entry:${entry.id}`);
			}
		}
		const taskRunEventsById = new Map<string, TaskRunEvent>();
		for (const event of input.taskRunEvents ?? []) {
			if (execution.runId !== undefined && event.runId !== execution.runId) {
				missingSources.push(`source_conflict:task_run_event:${event.id}`);
				continue;
			}
			const existing = taskRunEventsById.get(event.id);
			if (existing === undefined) {
				taskRunEventsById.set(event.id, event);
				continue;
			}
			if (canonicalTrajectoryJson(existing) !== canonicalTrajectoryJson(event)) {
				missingSources.push(`source_conflict:task_run_event:${event.id}`);
			}
		}
		const taskRunEvents = [...taskRunEventsById.values()].sort(
			(left, right) => left.sequence - right.sequence,
		);
		const branchEntryIds = new Set<string>();
		const branchEndId =
			execution.lastEntryId ??
			execution.entryLinks[execution.entryLinks.length - 1]?.entryId ??
			null;
		let branchCursor: string | null = branchEndId;
		while (
			branchCursor !== null &&
			branchCursor !== execution.branchParentEntryId
		) {
			const entry = entriesById.get(branchCursor);
			if (entry === undefined) {
				missingSources.push(`session_branch_entry:${branchCursor}`);
				break;
			}
			branchEntryIds.add(entry.id);
			branchCursor = entry.parentId;
		}
		if (branchCursor !== execution.branchParentEntryId) {
			missingSources.push(`session_branch:${execution.id}`);
		}
		const linkedMessages: LinkedMessage[] = execution.entryLinks.map((link) => {
			const candidate = entriesById.get(link.entryId);
			const entry =
				candidate?.type === "message" && branchEntryIds.has(link.entryId)
					? candidate
					: undefined;
			const actualRole = entry === undefined ? undefined : roleForEntry(entry);
			if (entry === undefined || actualRole !== link.role) {
				missingSources.push(`session_entry:${link.entryId}`);
			}
			return {
				sequence: link.sequence,
				timestamp: link.timestamp,
				eventId: link.eventId,
				entryId: link.entryId,
				role: link.role,
				...(entry === undefined ? {} : { entry }),
				...(entry === undefined
					? {}
					: { projectedContent: projectMessageContent(entry.message) }),
				evidenceId: this.opaqueId("evidence", `entry:${link.entryId}`),
				contentId: this.opaqueId("content", `entry:${link.entryId}`),
			};
		});
		if (execution.runId !== undefined && taskRun === undefined) {
			missingSources.push(`task_run:${execution.runId}`);
		}
		if (
			execution.runId !== undefined &&
			taskRun !== undefined &&
			taskRunEvents.length === 0
		) {
			missingSources.push(`task_run_events:${execution.runId}`);
		}

		const contentIndex = linkedMessages.map(
			(message): TrajectoryContentReference => ({
				id: message.contentId,
				digest: this.digest(
					message.projectedContent ?? { redacted: true, entryId: message.entryId },
				),
				digestScheme: "hmac_sha256",
				storage: "session",
				sourceId: message.entryId,
				available: message.entry !== undefined,
				sensitivity:
					message.role === "user" ? "user_private" : "workspace_private",
				exportPolicy: "local_only",
			}),
		);
		let originalGoal = linkedMessages.find(
			(message) => message.role === "user" && message.entry !== undefined,
		);
		if (originalGoal === undefined) {
			const contentId = this.opaqueId("content", `missing-goal:${execution.id}`);
			contentIndex.push({
				id: contentId,
				digest: this.digest({ redacted: true, executionId: execution.id }),
				digestScheme: "hmac_sha256",
				storage: "session",
				sourceId: execution.id,
				available: false,
				sensitivity: "user_private",
				exportPolicy: "local_only",
			});
			originalGoal = {
				sequence: 0,
				timestamp: execution.startedAt,
				eventId: execution.id,
				entryId: execution.id,
				role: "user",
				evidenceId: this.opaqueId("evidence", `missing-goal:${execution.id}`),
				contentId,
			};
			missingSources.push("original_goal");
		}

		const evidenceIndex: TrajectoryEvidenceReference[] = linkedMessages.map(
			(message) => ({
				id: message.evidenceId,
				source: "session_entry",
				sourceId: message.entryId,
				digest: this.digest(
					message.projectedContent ?? { redacted: true, entryId: message.entryId },
				),
				digestScheme: "hmac_sha256",
				locator: { kind: "session_entry", value: message.entryId },
				available: message.entry !== undefined,
				sensitive: true,
				exportPolicy: "local_only",
			}),
		);
		for (const fact of execution.facts) {
			evidenceIndex.push({
				id: this.opaqueId("evidence", `fact:${fact.eventId}`),
				source: "execution_event",
				sourceId: fact.eventId,
				digest: this.digest(fact.evidence),
				digestScheme: "hmac_sha256",
				locator: { kind: "execution_event", value: fact.eventId },
				available: true,
				sensitive: true,
				exportPolicy: "local_only",
			});
		}
		const lifecycleEvents = executionEvents.filter(
			(event) =>
				event.type === "started" ||
				event.type === "task_run_linked" ||
				event.type === "finished",
		);
		for (const event of lifecycleEvents) {
			evidenceIndex.push({
				id: this.opaqueId("evidence", `execution-lifecycle:${event.id}`),
				source: "execution_event",
				sourceId: event.id,
				digest: this.digest(event),
				digestScheme: "hmac_sha256",
				locator: { kind: "execution_event", value: event.id },
				available: true,
				sensitive: true,
				exportPolicy: "local_only",
			});
		}

		const stepCandidates: StepCandidate[] = [
			...lifecycleEvents.map((event): StepCandidate => {
				const name =
					event.type === "started"
						? "execution_started"
						: event.type === "task_run_linked"
							? "task_run_linked"
							: `execution_finished:${event.outcome}`;
				const outcome =
					event.type === "started"
						? ("started" as const)
						: event.type === "finished" && event.outcome === "aborted"
							? ("aborted" as const)
							: event.type === "finished" && event.outcome !== "completed"
								? ("failed" as const)
								: ("completed" as const);
				return {
					anchorSequence: event.sequence,
					sourceOrder: 0,
					sourceSequence: event.sequence,
					step: {
						id: this.opaqueId("step", `execution-lifecycle:${event.id}`),
						phase: event.type === "finished" ? "deliver" : "discover",
						kind: "checkpoint",
						name,
						outcome,
						evidenceRefs: [
							this.opaqueId("evidence", `execution-lifecycle:${event.id}`),
						],
					},
				};
			}),
			...linkedMessages.map(
				(message): StepCandidate => ({
					anchorSequence: message.sequence,
					sourceOrder: 0,
					sourceSequence: message.sequence,
					step: {
					id: this.opaqueId("step", `entry-link:${message.eventId}`),
					phase:
						message.role === "assistant" ? "deliver" : "discover",
					kind:
						message.role === "user"
							? "user_input"
							: message.role === "assistant"
								? "assistant_message"
								: "tool_result",
					outcome: "completed",
					evidenceRefs: [message.evidenceId],
					},
				}),
			),
			...execution.facts.map((fact): StepCandidate => {
				const name = evidenceName(fact.evidence);
				return {
					anchorSequence: fact.sequence,
					sourceOrder: 0,
					sourceSequence: fact.sequence,
					step: {
						id: this.opaqueId("step", `fact:${fact.eventId}`),
						phase: phaseForEvidence(fact.evidence),
						kind: kindForEvidence(fact.evidence),
						...(name === undefined ? {} : { name }),
						outcome: fact.evidence.outcome,
						evidenceKind: fact.evidence.kind,
						evidenceRefs: [
							this.opaqueId("evidence", `fact:${fact.eventId}`),
						],
						...(fact.evidence.subjectFingerprint === undefined
							? {}
							: {
									subjectFingerprint: this.rekeyFingerprint(
										"subject",
										fact.evidence.subjectFingerprint,
									),
								}),
					},
				};
			}),
		];
		const factsByEventId = new Map(
			execution.facts.map((fact) => [fact.eventId, fact]),
		);
		let taskAnchorSequence =
			executionEvents.find(
				(event) =>
					event.type === "task_run_linked" && event.runId === execution.runId,
			)?.sequence ?? execution.sequence;
		let taskPhase: TrajectoryPhase = "discover";
		for (const event of taskRunEvents) {
			if (event.type === "phase_changed") taskPhase = event.phase;
			if (event.type === "evidence_recorded") {
				const mirroredFactId = event.idempotencyKey?.startsWith("execution-fact:")
					? event.idempotencyKey.slice("execution-fact:".length)
					: undefined;
				const mirroredFact =
					mirroredFactId === undefined
						? undefined
						: factsByEventId.get(mirroredFactId);
				if (mirroredFact !== undefined) {
					if (
						canonicalTrajectoryJson(comparableEvidence(mirroredFact.evidence)) !==
						canonicalTrajectoryJson(comparableEvidence(event.evidence))
					) {
						missingSources.push(`source_conflict:task_run_event:${event.id}`);
					}
					taskAnchorSequence = mirroredFact.sequence;
					continue;
				}
				if (mirroredFactId !== undefined) {
					missingSources.push(`execution_fact:${mirroredFactId}`);
				}
				const evidenceId = this.opaqueId("evidence", `task-run-event:${event.id}`);
				evidenceIndex.push({
					id: evidenceId,
					source: "task_run_event",
					sourceId: event.id,
					digest: this.digest(event),
					digestScheme: "hmac_sha256",
					locator: { kind: "task_run_event", value: event.id },
					available: true,
					sensitive: true,
					exportPolicy: "local_only",
				});
				const name = evidenceName(event.evidence);
				stepCandidates.push({
					anchorSequence: taskAnchorSequence,
					sourceOrder: 1,
					sourceSequence: event.sequence,
					step: {
						id: this.opaqueId("step", `task-run-event:${event.id}`),
						phase: phaseForEvidence(event.evidence),
						kind: kindForEvidence(event.evidence),
						...(name === undefined ? {} : { name }),
						outcome: event.evidence.outcome,
						evidenceKind: event.evidence.kind,
						evidenceRefs: [evidenceId],
						...(event.evidence.subjectFingerprint === undefined
							? {}
							: {
									subjectFingerprint: this.rekeyFingerprint(
										"subject",
										event.evidence.subjectFingerprint,
									),
								}),
					},
				});
				continue;
			}
			const evidenceId = this.opaqueId("evidence", `task-run-event:${event.id}`);
			evidenceIndex.push({
				id: evidenceId,
				source: "task_run_event",
				sourceId: event.id,
				digest: this.digest(event),
				digestScheme: "hmac_sha256",
				locator: { kind: "task_run_event", value: event.id },
				available: true,
				sensitive: true,
				exportPolicy: "local_only",
			});
			const checkpoint =
				event.type === "started"
					? { name: "task_run_started", outcome: "started" as const }
					: event.type === "phase_changed"
						? { name: `phase:${event.phase}`, outcome: "completed" as const }
						: event.type === "waiting"
							? { name: `waiting:${event.reason}`, outcome: "started" as const }
							: event.type === "resumed"
								? { name: "task_run_resumed", outcome: "completed" as const }
								: {
										name: `task_run_finished:${event.conclusion}`,
										outcome:
											event.conclusion === "success"
												? ("completed" as const)
												: event.conclusion === "aborted"
													? ("aborted" as const)
													: ("failed" as const),
									};
			stepCandidates.push({
				anchorSequence: taskAnchorSequence,
				sourceOrder: 1,
				sourceSequence: event.sequence,
				step: {
					id: this.opaqueId("step", `task-run-event:${event.id}`),
					phase: taskPhase,
					kind: "checkpoint",
					name: checkpoint.name,
					outcome: checkpoint.outcome,
					evidenceRefs: [evidenceId],
				},
			});
		}
		const steps = stepCandidates
			.sort((left, right) =>
				left.anchorSequence !== right.anchorSequence
					? left.anchorSequence - right.anchorSequence
					: left.sourceOrder !== right.sourceOrder
						? left.sourceOrder - right.sourceOrder
						: left.sourceSequence !== right.sourceSequence
							? left.sourceSequence - right.sourceSequence
							: left.step.id < right.step.id
								? -1
								: left.step.id > right.step.id
									? 1
									: 0,
			)
			.map((candidate, index): TrajectoryStep => ({
				...candidate.step,
				sequence: index + 1,
			}));

		const finalMessage = [...linkedMessages]
			.reverse()
			.find(
				(message) => message.role === "assistant" && message.entry !== undefined,
			);
		const artifacts: TrajectoryArtifactReference[] =
			finalMessage === undefined
				? []
				: [
						{
							id: this.opaqueId("artifact", `final:${finalMessage.entryId}`),
							kind: "final_answer",
							digest: this.digest(finalMessage.projectedContent),
							digestScheme: "hmac_sha256",
							locator: {
								kind: "session_entry",
								value: finalMessage.entryId,
							},
							evidenceRef: finalMessage.evidenceId,
							sensitive: true,
							exportPolicy: "local_only",
						},
					];

		const sourceSnapshotDigest = this.digest({
			executionEvents,
			linkedEntries: linkedMessages.map((message) => ({
				entryId: message.entryId,
				parentId: message.entry?.parentId,
				role: message.role,
				projectedContent: message.projectedContent,
			})),
			taskRunEvents,
			taskRun:
				taskRun === undefined
					? undefined
					: {
							id: taskRun.id,
							executionId: taskRun.executionId,
							status: taskRun.status,
							phase: taskRun.phase,
							conclusion: taskRun.conclusion,
							assurance: taskRun.assurance,
							currentSubjectFingerprint: taskRun.currentSubjectFingerprint,
							lastVerifiedSubjectFingerprint:
								taskRun.lastVerifiedSubjectFingerprint,
							sequence: taskRun.sequence,
							startedAt: taskRun.startedAt,
							completedAt: taskRun.completedAt,
						},
		});
		const manifest = execution.strategy.manifest;
		const recordWithoutDigest: Omit<
			CanonicalTrajectoryRecordV1,
			"trajectoryDigest"
		> = {
			schemaVersion: TRAJECTORY_SCHEMA_VERSION,
			compilerVersion: TRAJECTORY_COMPILER_VERSION,
			projectionVersion: TRAJECTORY_PROJECTION_VERSION,
			projectionDomainId: this.projectionDomainId,
			digestScheme: "hmac_sha256" as const,
			digestKeyVersion: this.digestKeyVersion,
			executionId: execution.id,
			sessionId: execution.sessionId,
			...(execution.runId === undefined ? {} : { runId: execution.runId }),
			strategy: {
				version: execution.strategy.version,
				release: manifest.release,
				appVersion: manifest.appVersion,
				...(manifest.commit === undefined ? {} : { commit: manifest.commit }),
				features: [...manifest.features],
				api: manifest.model.api,
				provider: manifest.model.provider,
				model: manifest.model.id,
				modelRevision: `unreported:${manifest.model.id}`,
				thinkingLevel: execution.strategy.thinkingLevel,
				systemPromptHash: this.rekeyFingerprint("system-prompt", manifest.systemPromptHash),
				toolsHash: this.rekeyFingerprint("tools", manifest.toolsHash),
				policyHash: this.rekeyFingerprint("policy", manifest.policyHash),
				contextPolicyHash: this.rekeyFingerprint(
					"context-policy",
					execution.strategy.contextPolicyHash,
				),
				streamOptionsHash: this.rekeyFingerprint(
					"stream-options",
					execution.strategy.streamOptionsHash,
				),
				budgetHash: this.digest(manifest.budget ?? {}),
			},
			task: {
				originalGoalRef: originalGoal.contentId,
				constraints: [],
				acceptanceCriteria: [],
			},
			contentIndex,
			steps,
			evidenceIndex,
			coverage: [
				"filesystem",
				"process",
				"network",
				"approval",
				"external_mutation",
			].map(
				(capability): TrajectoryCoverageAttestation => ({
					capability: capability as TrajectoryCoverageAttestation["capability"],
					status: "unknown",
					enforcementVersion: "p0-observe-only",
					evidenceRefs: [],
				}),
			),
			artifacts,
			...(taskRun === undefined
				? {}
				: { metrics: structuredClone(taskRun.metrics) }),
			completeness: {
				canonicalFacts: missingSources.length === 0 ? "complete" : "partial",
				missingSources: [...new Set(missingSources)].sort(),
			},
			status: execution.status,
			...(execution.outcome === undefined ? {} : { outcome: execution.outcome }),
			sourceSnapshotDigest,
			startedAt: execution.startedAt,
			...(execution.completedAt === undefined
				? {}
				: { completedAt: execution.completedAt }),
		};
		return {
			...recordWithoutDigest,
			trajectoryDigest: this.digest(recordWithoutDigest),
		};
	}

	private opaqueId(kind: string, source: string): string {
		return `${kind}-${this.digest(`${kind}:${source}`).slice(0, 24)}`;
	}

	private rekeyFingerprint(kind: string, fingerprint: string): string {
		return this.digest({ kind, fingerprint });
	}

	private digest(value: unknown): string {
		return createHmac("sha256", this.digestKey)
			.update(canonicalTrajectoryJson(value), "utf8")
			.digest("hex");
	}
}
