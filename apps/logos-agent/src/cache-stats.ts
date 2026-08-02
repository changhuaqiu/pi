import { createHash } from "node:crypto";
import type {
	AssistantMessage,
	CacheRetention,
} from "@earendil-works/pi-ai";
import type { SessionTreeEntry } from "../../../packages/agent/src/index.ts";

export const CACHE_OBSERVATION_CUSTOM_TYPE = "cache_observation";
const CACHE_OBSERVATION_VERSION = 1;

export interface LogosAgentCacheStats {
	requestCount: number;
	telemetryRequestCount: number;
	telemetryCoverage: number | undefined;
	promptTokens: number;
	uncachedInputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	hitRate: number | undefined;
	latestHitRate: number | undefined;
}

export interface CacheObservationEnvironment {
	appVersion: string;
	release: string;
	commit?: string;
	features: readonly string[];
}

export interface CacheRequestSnapshot {
	sessionId: string;
	runId?: string;
	api: string;
	provider: string;
	model: string;
	telemetryAvailable: boolean;
	systemPromptHash: string;
	toolsHash: string;
	cacheRetention?: CacheRetention;
	startedAt: number;
}

interface CacheObservationUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface CacheObservation {
	version: 1;
	sessionId: string;
	runId?: string;
	startedAt: number;
	completedAt: number;
	idleMs?: number;
	api: string;
	provider: string;
	model: string;
	telemetryAvailable: boolean;
	appVersion: string;
	release: string;
	commit?: string;
	features: string[];
	systemPromptHash: string;
	toolsHash: string;
	cacheRetention?: CacheRetention;
	stopReason: AssistantMessage["stopReason"];
	usage: CacheObservationUsage;
}

interface CacheUsageSample {
	usage: CacheObservationUsage;
	telemetryAvailable: boolean;
}

export type CacheIdleBucket = "first" | "<1m" | "1-5m" | ">5m";

export interface CacheReportSegment {
	key: string;
	label: string;
	features: string;
	model: string;
	idleBucket: CacheIdleBucket;
	systemPromptHash: string;
	toolsHash: string;
	cacheRetention: string;
	stats: LogosAgentCacheStats;
}

export interface CacheOperationsReport {
	release?: string;
	availableReleases: string[];
	observationCount: number;
	stats: LogosAgentCacheStats;
	segments: CacheReportSegment[];
}

export interface CacheComparisonContributor {
	segment: string;
	impactPercentagePoints: number;
	trafficMixPercentagePoints: number;
	withinSegmentPercentagePoints: number;
}

export interface CacheReleaseComparison {
	baselineRelease: string;
	currentRelease: string;
	baseline: LogosAgentCacheStats;
	current: LogosAgentCacheStats;
	deltaPercentagePoints: number | undefined;
	trafficMixPercentagePoints: number | undefined;
	withinSegmentPercentagePoints: number | undefined;
	contributors: CacheComparisonContributor[];
}

interface PendingCacheRequest {
	snapshot: CacheRequestSnapshot;
	idleMs?: number;
}

export class CacheObservationTracker {
	private readonly environment: CacheObservationEnvironment;
	private readonly pending: PendingCacheRequest[] = [];
	private previousRequestCompletedAt?: number;

	constructor(environment: CacheObservationEnvironment) {
		this.environment = {
			...environment,
			features: [...environment.features].sort(),
		};
	}

	beginRequest(snapshot: CacheRequestSnapshot): void {
		const idleMs =
			this.previousRequestCompletedAt === undefined
				? undefined
				: Math.max(0, snapshot.startedAt - this.previousRequestCompletedAt);
		this.pending.push({ snapshot, idleMs });
	}

	hydrate(observations: readonly CacheObservation[]): void {
		this.previousRequestCompletedAt = observations.reduce<number | undefined>(
			(latest, observation) =>
				latest === undefined
					? observation.completedAt
					: Math.max(latest, observation.completedAt),
			undefined,
		);
	}

	completeRequest(
		message: AssistantMessage,
		completedAt = Date.now(),
	): CacheObservation | undefined {
		const pendingIndex = this.pending.findIndex(
			({ snapshot }) =>
				snapshot.api === message.api &&
				snapshot.provider === message.provider &&
				snapshot.model === message.model,
		);
		if (pendingIndex < 0) return undefined;
		const [pending] = this.pending.splice(pendingIndex, 1);
		if (!pending) return undefined;
		this.previousRequestCompletedAt = completedAt;
		return {
			version: CACHE_OBSERVATION_VERSION,
			sessionId: pending.snapshot.sessionId,
			runId: pending.snapshot.runId,
			startedAt: pending.snapshot.startedAt,
			completedAt,
			idleMs: pending.idleMs,
			api: message.api,
			provider: message.provider,
			model: message.model,
			telemetryAvailable: pending.snapshot.telemetryAvailable,
			appVersion: this.environment.appVersion,
			release: this.environment.release,
			commit: this.environment.commit,
			features: [...this.environment.features],
			systemPromptHash: pending.snapshot.systemPromptHash,
			toolsHash: pending.snapshot.toolsHash,
			cacheRetention: pending.snapshot.cacheRetention,
			stopReason: message.stopReason,
			usage: {
				input: message.usage.input,
				output: message.usage.output,
				cacheRead: message.usage.cacheRead,
				cacheWrite: message.usage.cacheWrite,
			},
		};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!isRecord(value)) {
		if (
			value === null ||
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			return value;
		}
		return String(value);
	}
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, stableValue(child)]),
	);
}

export function cacheStructureHash(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(stableValue(value)), "utf8")
		.digest("hex");
}

export function cacheTelemetryAvailable(api: string): boolean {
	return (
		api === "anthropic-messages" ||
		api === "openai-responses" ||
		api === "openai-completions"
	);
}

function assistantEntrySample(entry: SessionTreeEntry): CacheUsageSample | undefined {
	if (entry.type !== "message" || entry.message.role !== "assistant") return undefined;
	return {
		usage: entry.message.usage,
		telemetryAvailable: cacheTelemetryAvailable(entry.message.api),
	};
}

function parseCacheRetention(value: unknown): CacheRetention | undefined {
	return value === "none" || value === "short" || value === "long" ? value : undefined;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStopReason(value: unknown): value is AssistantMessage["stopReason"] {
	return (
		value === "stop" ||
		value === "length" ||
		value === "toolUse" ||
		value === "error" ||
		value === "aborted"
	);
}

function parseCacheObservation(value: unknown): CacheObservation | undefined {
	if (!isRecord(value) || value.version !== CACHE_OBSERVATION_VERSION) return undefined;
	if (
		typeof value.sessionId !== "string" ||
		(value.runId !== undefined && typeof value.runId !== "string") ||
		!isNonNegativeFiniteNumber(value.startedAt) ||
		!isNonNegativeFiniteNumber(value.completedAt) ||
		(value.idleMs !== undefined && !isNonNegativeFiniteNumber(value.idleMs)) ||
		typeof value.api !== "string" ||
		typeof value.provider !== "string" ||
		typeof value.model !== "string" ||
		typeof value.telemetryAvailable !== "boolean" ||
		typeof value.appVersion !== "string" ||
		typeof value.release !== "string" ||
		(value.commit !== undefined && typeof value.commit !== "string") ||
		!Array.isArray(value.features) ||
		!value.features.every((feature) => typeof feature === "string") ||
		typeof value.systemPromptHash !== "string" ||
		typeof value.toolsHash !== "string" ||
		!isStopReason(value.stopReason) ||
		!isRecord(value.usage) ||
		!isNonNegativeFiniteNumber(value.usage.input) ||
		!isNonNegativeFiniteNumber(value.usage.output) ||
		!isNonNegativeFiniteNumber(value.usage.cacheRead) ||
		!isNonNegativeFiniteNumber(value.usage.cacheWrite)
	) {
		return undefined;
	}
	const cacheRetention = parseCacheRetention(value.cacheRetention);
	if (value.cacheRetention !== undefined && cacheRetention === undefined) return undefined;
	return {
		version: CACHE_OBSERVATION_VERSION,
		sessionId: value.sessionId,
		runId: value.runId as string | undefined,
		startedAt: value.startedAt,
		completedAt: value.completedAt,
		idleMs: value.idleMs as number | undefined,
		api: value.api,
		provider: value.provider,
		model: value.model,
		telemetryAvailable: value.telemetryAvailable,
		appVersion: value.appVersion,
		release: value.release,
		commit: value.commit as string | undefined,
		features: [...value.features] as string[],
		systemPromptHash: value.systemPromptHash,
		toolsHash: value.toolsHash,
		cacheRetention,
		stopReason: value.stopReason,
		usage: {
			input: value.usage.input,
			output: value.usage.output,
			cacheRead: value.usage.cacheRead,
			cacheWrite: value.usage.cacheWrite,
		},
	};
}

export function collectCacheObservations(
	entries: readonly SessionTreeEntry[],
): CacheObservation[] {
	const observations: CacheObservation[] = [];
	for (const entry of entries) {
		if (
			entry.type !== "custom" ||
			entry.customType !== CACHE_OBSERVATION_CUSTOM_TYPE
		) {
			continue;
		}
		const observation = parseCacheObservation(entry.data);
		if (observation) observations.push(observation);
	}
	return observations;
}

function sampleFromObservation(observation: CacheObservation): CacheUsageSample {
	return {
		usage: observation.usage,
		telemetryAvailable: observation.telemetryAvailable,
	};
}

function computeSampleStats(
	samples: readonly CacheUsageSample[],
): LogosAgentCacheStats {
	let requestCount = 0;
	let telemetryRequestCount = 0;
	let promptTokens = 0;
	let uncachedInputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let latestHitRate: number | undefined;

	for (const { usage, telemetryAvailable } of samples) {
		const requestPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		if (requestPromptTokens <= 0) continue;
		requestCount++;
		latestHitRate = telemetryAvailable
			? (usage.cacheRead / requestPromptTokens) * 100
			: undefined;
		if (!telemetryAvailable) continue;
		telemetryRequestCount++;
		promptTokens += requestPromptTokens;
		uncachedInputTokens += usage.input;
		cacheReadTokens += usage.cacheRead;
		cacheWriteTokens += usage.cacheWrite;
	}

	return {
		requestCount,
		telemetryRequestCount,
		telemetryCoverage:
			requestCount > 0 ? (telemetryRequestCount / requestCount) * 100 : undefined,
		promptTokens,
		uncachedInputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		hitRate: promptTokens > 0 ? (cacheReadTokens / promptTokens) * 100 : undefined,
		latestHitRate,
	};
}

/**
 * Computes prompt-cache statistics from persisted provider usage.
 *
 * Cache writes are misses because those tokens were not served from cache. A
 * The API adapter identity determines whether zero means a measured miss or
 * unavailable telemetry, so later observations never retroactively reinterpret
 * earlier releases.
 */
export function computeCacheStats(
	entries: readonly SessionTreeEntry[],
): LogosAgentCacheStats {
	const samples = entries.flatMap((entry) => {
		const sample = assistantEntrySample(entry);
		return sample ? [sample] : [];
	});
	return computeSampleStats(samples);
}

export function cacheIdleBucket(idleMs: number | undefined): CacheIdleBucket {
	if (idleMs === undefined) return "first";
	if (idleMs < 60_000) return "<1m";
	if (idleMs <= 5 * 60_000) return "1-5m";
	return ">5m";
}

function observationSegment(observation: CacheObservation): Omit<CacheReportSegment, "stats"> {
	const features = observation.features.length > 0 ? observation.features.join(",") : "default";
	const model = `${observation.provider}/${observation.model}`;
	const idleBucket = cacheIdleBucket(observation.idleMs);
	const cacheRetention = observation.cacheRetention ?? "default";
	const key = cacheStructureHash({
		features: observation.features,
		model,
		idleBucket,
		systemPromptHash: observation.systemPromptHash,
		toolsHash: observation.toolsHash,
		cacheRetention,
	});
	return {
		key,
		label: [
			`feature=${features}`,
			`model=${model}`,
			`idle=${idleBucket}`,
			`system=${observation.systemPromptHash.slice(0, 8)}`,
			`tools=${observation.toolsHash.slice(0, 8)}`,
			`retention=${cacheRetention}`,
		].join(" "),
		features,
		model,
		idleBucket,
		systemPromptHash: observation.systemPromptHash,
		toolsHash: observation.toolsHash,
		cacheRetention,
	};
}

function buildSegments(
	observations: readonly CacheObservation[],
): CacheReportSegment[] {
	const groups = new Map<
		string,
		{ segment: Omit<CacheReportSegment, "stats">; samples: CacheUsageSample[] }
	>();
	for (const observation of observations) {
		const segment = observationSegment(observation);
		const group = groups.get(segment.key) ?? { segment, samples: [] };
		group.samples.push(sampleFromObservation(observation));
		groups.set(segment.key, group);
	}
	return [...groups.values()]
		.map(({ segment, samples }) => ({
			...segment,
			stats: computeSampleStats(samples),
		}))
		.sort((left, right) => right.stats.promptTokens - left.stats.promptTokens);
}

export function buildCacheOperationsReport(
	entries: readonly SessionTreeEntry[],
	release?: string,
): CacheOperationsReport {
	const allObservations = collectCacheObservations(entries);
	const observations = release
		? allObservations.filter((observation) => observation.release === release)
		: allObservations;
	const samples = observations.map(sampleFromObservation);
	return {
		release,
		availableReleases: [...new Set(allObservations.map((observation) => observation.release))].sort(),
		observationCount: observations.length,
		stats: computeSampleStats(samples),
		segments: buildSegments(observations),
	};
}

interface ComparisonSegment {
	label: string;
	share: number;
	hitRate: number;
}

function comparisonSegments(report: CacheOperationsReport): Map<string, ComparisonSegment> {
	const result = new Map<string, ComparisonSegment>();
	if (report.stats.promptTokens <= 0) return result;
	for (const segment of report.segments) {
		if (segment.stats.hitRate === undefined || segment.stats.promptTokens <= 0) continue;
		result.set(segment.key, {
			label: segment.label,
			share: segment.stats.promptTokens / report.stats.promptTokens,
			hitRate: segment.stats.hitRate,
		});
	}
	return result;
}

export function compareCacheReleases(
	entries: readonly SessionTreeEntry[],
	baselineRelease: string,
	currentRelease: string,
): CacheReleaseComparison {
	const baselineReport = buildCacheOperationsReport(entries, baselineRelease);
	const currentReport = buildCacheOperationsReport(entries, currentRelease);
	const baselineSegments = comparisonSegments(baselineReport);
	const currentSegments = comparisonSegments(currentReport);
	const contributors: CacheComparisonContributor[] = [];
	let trafficMixPercentagePoints = 0;
	let withinSegmentPercentagePoints = 0;

	for (const key of new Set([...baselineSegments.keys(), ...currentSegments.keys()])) {
		const baseline = baselineSegments.get(key);
		const current = currentSegments.get(key);
		const baselineShare = baseline?.share ?? 0;
		const currentShare = current?.share ?? 0;
		const baselineRate = baseline?.hitRate ?? current?.hitRate ?? 0;
		const currentRate = current?.hitRate ?? baseline?.hitRate ?? 0;
		const trafficMix =
			(currentShare - baselineShare) * ((baselineRate + currentRate) / 2);
		const withinSegment =
			((baselineShare + currentShare) / 2) * (currentRate - baselineRate);
		trafficMixPercentagePoints += trafficMix;
		withinSegmentPercentagePoints += withinSegment;
		contributors.push({
			segment: current?.label ?? baseline?.label ?? key,
			impactPercentagePoints: trafficMix + withinSegment,
			trafficMixPercentagePoints: trafficMix,
			withinSegmentPercentagePoints: withinSegment,
		});
	}

	contributors.sort(
		(left, right) =>
			Math.abs(right.impactPercentagePoints) -
			Math.abs(left.impactPercentagePoints),
	);
	const deltaPercentagePoints =
		baselineReport.stats.hitRate === undefined ||
		currentReport.stats.hitRate === undefined
			? undefined
			: currentReport.stats.hitRate - baselineReport.stats.hitRate;
	return {
		baselineRelease,
		currentRelease,
		baseline: baselineReport.stats,
		current: currentReport.stats,
		deltaPercentagePoints,
		trafficMixPercentagePoints:
			deltaPercentagePoints === undefined ? undefined : trafficMixPercentagePoints,
		withinSegmentPercentagePoints:
			deltaPercentagePoints === undefined ? undefined : withinSegmentPercentagePoints,
		contributors: deltaPercentagePoints === undefined ? [] : contributors,
	};
}
