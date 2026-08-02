import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	CacheOperationsReport,
	CacheReleaseComparison,
	LogosAgentCacheStats,
} from "../src/cache-stats.ts";
import {
	formatCacheOperationsReport,
	formatCacheReleaseComparison,
} from "../src/tui-app.ts";

function cacheStats(hitRate: number): LogosAgentCacheStats {
	return {
		requestCount: 2,
		telemetryRequestCount: 2,
		telemetryCoverage: 100,
		promptTokens: 2_000,
		uncachedInputTokens: 2_000 - hitRate * 20,
		cacheReadTokens: hitRate * 20,
		cacheWriteTokens: 0,
		hitRate,
		latestHitRate: hitRate,
	};
}

test("formats grouped cache operations reports", () => {
	const report: CacheOperationsReport = {
		release: "release-b",
		availableReleases: ["release-a", "release-b"],
		observationCount: 2,
		stats: cacheStats(80),
		segments: [
			{
				key: "segment",
				label: "feature=new-cache model=anthropic/test idle=<1m",
				features: "new-cache",
				model: "anthropic/test",
				idleBucket: "<1m",
				systemPromptHash: "system",
				toolsHash: "tools",
				cacheRetention: "short",
				stats: cacheStats(80),
			},
		],
	};

	const output = formatCacheOperationsReport(report);
	assert.match(output, /cache report \(release release-b\)/);
	assert.match(output, /hit rate 80\.0% · telemetry coverage 100\.0%/);
	assert.match(output, /feature=new-cache/);
});

test("formats release comparison attribution", () => {
	const comparison: CacheReleaseComparison = {
		baselineRelease: "release-a",
		currentRelease: "release-b",
		baseline: cacheStats(50),
		current: cacheStats(80),
		deltaPercentagePoints: 30,
		trafficMixPercentagePoints: 10,
		withinSegmentPercentagePoints: 20,
		contributors: [
			{
				segment: "feature=new-cache",
				impactPercentagePoints: 30,
				trafficMixPercentagePoints: 10,
				withinSegmentPercentagePoints: 20,
			},
		],
	};

	const output = formatCacheReleaseComparison(comparison);
	assert.match(output, /50\.0% → 80\.0% \(\+30\.0pp\)/);
	assert.match(output, /traffic mix \+10\.0pp · within segment \+20\.0pp/);
	assert.match(output, /\+30\.0pp \(mix \+10\.0, within \+20\.0\) · feature=new-cache/);
});
