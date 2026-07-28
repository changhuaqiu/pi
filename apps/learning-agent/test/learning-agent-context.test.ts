import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { shouldRunManualCompaction } from "../src/learning-agent.ts";

test("manual compaction threshold uses the unrounded context ratio", () => {
	assert.equal(
		shouldRunManualCompaction(
			{ tokenCount: 6_999, contextWindow: 10_000, percent: 70 },
			false,
		),
		false,
	);
	assert.equal(
		shouldRunManualCompaction(
			{ tokenCount: 7_000, contextWindow: 10_000, percent: 70 },
			false,
		),
		true,
	);
	assert.equal(
		shouldRunManualCompaction(
			{ tokenCount: 1, contextWindow: 10_000, percent: 0 },
			true,
		),
		true,
	);
});

test("direct Node runtime loads the workspace Agent Harness source", async () => {
	const source = await readFile(new URL("../src/learning-agent.ts", import.meta.url), "utf8");
	assert.match(source, /from "\.\.\/\.\.\/\.\.\/packages\/agent\/src\/index\.ts"/);
	assert.match(source, /from "\.\.\/\.\.\/\.\.\/packages\/agent\/src\/node\.ts"/);

	const result = spawnSync(
		process.execPath,
		[fileURLToPath(new URL("./fixtures/direct-node-runtime.ts", import.meta.url))],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "runtime import ok");
});
