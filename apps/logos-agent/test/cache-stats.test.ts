import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	type SessionTreeEntry,
} from "../../../packages/agent/src/index.ts";
import {
	buildCacheOperationsReport,
	CACHE_OBSERVATION_CUSTOM_TYPE,
	type CacheObservation,
	CacheObservationTracker,
	compareCacheReleases,
	computeCacheStats,
} from "../src/cache-stats.ts";

function usage(input: number, cacheRead: number, cacheWrite: number): Usage {
	return {
		input,
		output: 10,
		cacheRead,
		cacheWrite,
		totalTokens: input + cacheRead + cacheWrite + 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(
	id: string,
	value: Usage,
	provider = "anthropic",
	api = provider === "anthropic" ? "anthropic-messages" : "openai-responses",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: id }],
		api,
		provider,
		model: "test",
		usage: value,
		stopReason: "stop",
		timestamp: 0,
	};
}

function assistantEntry(
	id: string,
	value: Usage,
	provider = "anthropic",
	api = provider === "anthropic" ? "anthropic-messages" : "openai-responses",
): SessionTreeEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: assistantMessage(id, value, provider, api),
	};
}

function observationEntry(
	id: string,
	release: string,
	value: Usage,
	overrides: Partial<CacheObservation> = {},
): SessionTreeEntry {
	const observation: CacheObservation = {
		version: 1,
		sessionId: "session",
		startedAt: 1,
		completedAt: 2,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		telemetryAvailable: true,
		appVersion: "0.1.0",
		release,
		features: ["default"],
		systemPromptHash: "system",
		toolsHash: "tools",
		stopReason: "stop",
		usage: {
			input: value.input,
			output: value.output,
			cacheRead: value.cacheRead,
			cacheWrite: value.cacheWrite,
		},
		...overrides,
	};
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType: CACHE_OBSERVATION_CUSTOM_TYPE,
		data: observation,
	};
}

test("computes cumulative and latest cache hit rates from prompt tokens", () => {
	const stats = computeCacheStats([
		assistantEntry("first", usage(800, 0, 200)),
		assistantEntry("second", usage(100, 900, 0)),
	]);

	assert.equal(stats.requestCount, 2);
	assert.equal(stats.promptTokens, 2_000);
	assert.equal(stats.uncachedInputTokens, 900);
	assert.equal(stats.cacheReadTokens, 900);
	assert.equal(stats.cacheWriteTokens, 200);
	assert.equal(stats.hitRate, 45);
	assert.equal(stats.latestHitRate, 90);
});

test("does not claim a miss when the provider reports no cache metrics", () => {
	const stats = computeCacheStats([
		assistantEntry("first", usage(1_000, 0, 0), "custom", "custom-api"),
	]);

	assert.equal(stats.requestCount, 1);
	assert.equal(stats.hitRate, undefined);
	assert.equal(stats.latestHitRate, undefined);
});

test("does not mix cache telemetry availability across providers", () => {
	const stats = computeCacheStats([
		assistantEntry("anthropic", usage(100, 900, 0)),
		assistantEntry("unreported", usage(1_000, 0, 0), "custom", "custom-api"),
	]);

	assert.equal(stats.requestCount, 2);
	assert.equal(stats.promptTokens, 1_000);
	assert.equal(stats.hitRate, 90);
	assert.equal(stats.latestHitRate, undefined);
});

test("excludes background usage that has no persisted provider identity", () => {
	const stats = computeCacheStats([
		assistantEntry("first", usage(100, 900, 0)),
		{
			type: "compaction",
			id: "compact",
			parentId: "first",
			timestamp: "2026-01-01T00:00:01.000Z",
			summary: "summary",
			tokensBefore: 1_000,
			usage: usage(200, 800, 0),
		},
	]);

	assert.equal(stats.requestCount, 1);
	assert.equal(stats.promptTokens, 1_000);
	assert.equal(stats.hitRate, 90);
	assert.equal(stats.latestHitRate, 90);
});

test("tracks operational metadata and request idle time without prompt contents", () => {
	const tracker = new CacheObservationTracker({
		appVersion: "0.2.0",
		release: "release-b",
		commit: "abc123",
		features: ["new-cache", "tools"],
	});
	tracker.beginRequest({
		sessionId: "session",
		runId: "run-1",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		telemetryAvailable: true,
		systemPromptHash: "system-hash",
		toolsHash: "tools-hash",
		cacheRetention: "short",
		startedAt: 1_000,
	});
	const first = tracker.completeRequest(
		assistantMessage("first", usage(100, 900, 0)),
		2_000,
	);
	tracker.beginRequest({
		sessionId: "session",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		telemetryAvailable: true,
		systemPromptHash: "system-hash",
		toolsHash: "tools-hash",
		cacheRetention: "short",
		startedAt: 62_000,
	});
	const second = tracker.completeRequest(
		assistantMessage("second", usage(200, 800, 0)),
		63_000,
	);

	assert.equal(first?.release, "release-b");
	assert.equal(first?.runId, "run-1");
	assert.equal(first?.commit, "abc123");
	assert.deepEqual(first?.features, ["new-cache", "tools"]);
	assert.equal(first?.idleMs, undefined);
	assert.equal(second?.idleMs, 60_000);
	assert.equal(second?.completedAt, 63_000);
	assert.equal("content" in (second ?? {}), false);
});

test("hydrates idle time from the latest persisted Session observation", () => {
	const tracker = new CacheObservationTracker({
		appVersion: "0.2.0",
		release: "release-b",
		features: [],
	});
	const persistedEntry = observationEntry(
		"persisted",
		"release-a",
		usage(100, 900, 0),
		{ completedAt: 1_000 },
	);
	if (persistedEntry.type !== "custom") throw new Error("expected custom entry");
	tracker.hydrate([persistedEntry.data as CacheObservation]);
	tracker.beginRequest({
		sessionId: "session",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		telemetryAvailable: true,
		systemPromptHash: "system-hash",
		toolsHash: "tools-hash",
		startedAt: 301_001,
	});
	const observation = tracker.completeRequest(
		assistantMessage("next", usage(100, 900, 0)),
		302_000,
	);

	assert.equal(observation?.idleMs, 300_001);
});

test("cache observations remain outside the model context", () => {
	const assistant = assistantEntry("assistant", usage(100, 900, 0));
	const observation = observationEntry("observation", "release-a", usage(100, 900, 0));
	const context = buildSessionContext([assistant, observation]);

	assert.equal(context.messages.length, 1);
	assert.equal(context.messages[0]?.role, "assistant");
});

test("builds release reports and decomposes release changes", () => {
	const entries = [
		observationEntry("baseline", "release-a", usage(800, 200, 0)),
		observationEntry("current", "release-b", usage(200, 800, 0)),
	];
	const report = buildCacheOperationsReport(entries, "release-b");
	const comparison = compareCacheReleases(entries, "release-a", "release-b");

	assert.deepEqual(report.availableReleases, ["release-a", "release-b"]);
	assert.equal(report.observationCount, 1);
	assert.equal(report.stats.hitRate, 80);
	assert.equal(comparison.baseline.hitRate, 20);
	assert.equal(comparison.current.hitRate, 80);
	assert.equal(comparison.deltaPercentagePoints, 60);
	assert.equal(
		(comparison.trafficMixPercentagePoints ?? 0) +
			(comparison.withinSegmentPercentagePoints ?? 0),
		60,
	);
	assert.equal(comparison.contributors.length, 1);
});

test("later telemetry does not retroactively reinterpret an unavailable baseline", () => {
	const entries = [
		observationEntry("baseline", "release-a", usage(1_000, 0, 0), {
			telemetryAvailable: false,
		}),
		observationEntry("current", "release-b", usage(200, 800, 0), {
			telemetryAvailable: true,
		}),
	];
	const comparison = compareCacheReleases(entries, "release-a", "release-b");

	assert.equal(comparison.baseline.hitRate, undefined);
	assert.equal(comparison.baseline.telemetryCoverage, 0);
	assert.equal(comparison.current.hitRate, 80);
	assert.equal(comparison.deltaPercentagePoints, undefined);
});

test("decomposes traffic mix and within-segment changes exactly", () => {
	const entries = [
		observationEntry("baseline-a", "release-a", usage(800, 200, 0), {
			features: ["a"],
		}),
		observationEntry("baseline-b", "release-a", usage(200, 800, 0), {
			features: ["b"],
		}),
		observationEntry("current-a", "release-b", usage(300, 200, 0), {
			features: ["a"],
		}),
		observationEntry("current-b", "release-b", usage(300, 1_200, 0), {
			features: ["b"],
		}),
	];
	const comparison = compareCacheReleases(entries, "release-a", "release-b");

	assert.equal(comparison.baseline.hitRate, 50);
	assert.equal(comparison.current.hitRate, 70);
	assert.equal(comparison.deltaPercentagePoints, 20);
	assert.equal(comparison.trafficMixPercentagePoints, 12.5);
	assert.equal(comparison.withinSegmentPercentagePoints, 7.5);
	assert.equal(
		comparison.contributors.reduce(
			(total, contributor) => total + contributor.impactPercentagePoints,
			0,
		),
		20,
	);
});
