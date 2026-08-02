import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	analyzeCodeGraphEditImpact,
	createCodeGraphEnvironment,
	createCodeGraphExploreTool,
	createCodeGraphImpactTool,
	createCodeGraphNodeTool,
	createCodeGraphProvider,
	createCodeGraphSearchTool,
	createCodeGraphSyncCoordinator,
	createCodeGraphWorkspaceManager,
	createNodeCodeGraphCommandRunner,
	parseCodeGraphExploreInput,
	parseCodeGraphImpactInput,
	parseCodeGraphNodeInput,
	parseCodeGraphSearchInput,
	resolveCodeGraphExecutable,
	type CodeGraphCommandRequest,
	type CodeGraphCommandRunner,
	type CodeIntelligenceProvider,
	type CodeGraphWorkspaceManager,
} from "../src/code-intelligence.ts";

let workspaceRoot = "";
let executableRoot = "";

before(async () => {
	workspaceRoot = await mkdtemp(join(tmpdir(), "logos-agent-codegraph-"));
	executableRoot = await mkdtemp(join(tmpdir(), "logos-agent-codegraph-bin-"));
});

test("CodeGraph process environment excludes model credentials and disables network telemetry", () => {
	const environment = createCodeGraphEnvironment({
		PATH: "C:\\tools",
		USERPROFILE: "C:\\Users\\tester",
		OPENAI_API_KEY: "secret",
		ANTHROPIC_API_KEY: "secret",
	});

	assert.equal(environment.PATH, "C:\\tools");
	assert.equal(environment.USERPROFILE, "C:\\Users\\tester");
	assert.equal(environment.OPENAI_API_KEY, undefined);
	assert.equal(environment.ANTHROPIC_API_KEY, undefined);
	assert.equal(environment.CODEGRAPH_TELEMETRY, "0");
	assert.equal(environment.CODEGRAPH_NO_UPDATE_CHECK, "1");
	assert.equal(environment.DO_NOT_TRACK, "1");
});

after(async () => {
	await rm(workspaceRoot, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
	await rm(executableRoot, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});

test("CodeGraph executable resolution pins an absolute standalone binary outside the workspace", async () => {
	const executable = join(executableRoot, "codegraph.exe");
	await writeFile(executable, "test executable placeholder");

	assert.deepEqual(
		await resolveCodeGraphExecutable(
			workspaceRoot,
			{ PATH: executableRoot },
			"win32",
		),
		{ executable, prefixArgs: [] },
	);
});

test("CodeGraph executable resolution supports the official Windows bundle without running its cmd shim", async () => {
	const bundleRoot = join(executableRoot, "official-bundle");
	const executable = join(bundleRoot, "node.exe");
	const entryPoint = join(bundleRoot, "lib", "dist", "bin", "codegraph.js");
	await mkdir(join(bundleRoot, "lib", "dist", "bin"), { recursive: true });
	await writeFile(executable, "bundled node placeholder");
	await writeFile(entryPoint, "entry point placeholder");

	assert.deepEqual(
		await resolveCodeGraphExecutable(
			workspaceRoot,
			{ LOGOS_AGENT_CODEGRAPH_PATH: executable },
			"win32",
		),
		{
			executable,
			prefixArgs: [
				"--liftoff-only",
				"--disable-warning=ExperimentalWarning",
				entryPoint,
			],
		},
	);
});

test("CodeGraph executable resolution discovers the official default Windows install", async () => {
	const bundleRoot = join(executableRoot, "codegraph", "current");
	const executable = join(bundleRoot, "node.exe");
	const entryPoint = join(bundleRoot, "lib", "dist", "bin", "codegraph.js");
	await mkdir(join(bundleRoot, "lib", "dist", "bin"), { recursive: true });
	await writeFile(executable, "bundled node placeholder");
	await writeFile(entryPoint, "entry point placeholder");

	assert.deepEqual(
		await resolveCodeGraphExecutable(
			workspaceRoot,
			{ LOCALAPPDATA: executableRoot },
			"win32",
		),
		{
			executable,
			prefixArgs: [
				"--liftoff-only",
				"--disable-warning=ExperimentalWarning",
				entryPoint,
			],
		},
	);
});

test("CodeGraph executable resolution rejects workspace binaries and Windows cmd shims", async () => {
	const workspaceExecutable = join(workspaceRoot, "codegraph.exe");
	const commandShim = join(executableRoot, "codegraph.cmd");
	await writeFile(workspaceExecutable, "workspace executable placeholder");
	await writeFile(commandShim, "@echo off");

	await assert.rejects(
		resolveCodeGraphExecutable(
			workspaceRoot,
			{ PATH: workspaceRoot },
			"win32",
		),
		/inside the workspace/,
	);
	await assert.rejects(
		resolveCodeGraphExecutable(
			workspaceRoot,
			{ LOGOS_AGENT_CODEGRAPH_PATH: commandShim },
			"win32",
		),
		/standalone CodeGraph \.exe/,
	);
});

test("CodeGraph command runner enforces a hard timeout without shell execution", async () => {
	const runner = createNodeCodeGraphCommandRunner(
		workspaceRoot,
		{
			PATH: process.env.PATH,
			SYSTEMROOT: process.env.SYSTEMROOT,
			WINDIR: process.env.WINDIR,
		},
		async () => ({ executable: process.execPath, prefixArgs: [] }),
	);
	const startedAt = Date.now();

	await assert.rejects(
		runner({
			args: ["-e", "setInterval(() => {}, 1000)"],
			cwd: workspaceRoot,
			timeoutMs: 50,
		}),
		/command timed out/,
	);
	assert.ok(Date.now() - startedAt < 1_000);
});

test("CodeGraph command deadline includes executable resolution", async () => {
	const runner = createNodeCodeGraphCommandRunner(
		workspaceRoot,
		{},
		async () => await new Promise<never>(() => {}),
	);
	const startedAt = Date.now();

	await assert.rejects(
		runner({
			args: ["status", "--json"],
			cwd: workspaceRoot,
			timeoutMs: 30,
		}),
		/command timed out/,
	);
	assert.ok(Date.now() - startedAt < 1_000);
});

test("CodeGraph command runner aborts an active process within a bounded time", async () => {
	const runner = createNodeCodeGraphCommandRunner(
		workspaceRoot,
		{
			PATH: process.env.PATH,
			SYSTEMROOT: process.env.SYSTEMROOT,
			WINDIR: process.env.WINDIR,
		},
		async () => ({ executable: process.execPath, prefixArgs: [] }),
	);
	const controller = new AbortController();
	const startedAt = Date.now();
	const running = runner({
		args: ["-e", "setInterval(() => {}, 1000)"],
		cwd: workspaceRoot,
		timeoutMs: 5_000,
		signal: controller.signal,
	});
	setTimeout(() => controller.abort(), 25);

	await assert.rejects(running, { name: "AbortError" });
	assert.ok(Date.now() - startedAt < 1_000);
});

test("CodeGraph tool inputs preserve native semantics and reject fake scope", () => {
	assert.deepEqual(parseCodeGraphSearchInput({ query: " ToolSystem ", limit: 5 }), {
		operation: "search",
		query: "ToolSystem",
		limit: 5,
	});
	assert.deepEqual(
		parseCodeGraphNodeInput({ file: "apps\\logos-agent\\src\\tool-system.ts", symbolsOnly: true }),
		{
			operation: "node",
			file: "apps/logos-agent/src/tool-system.ts",
			symbolsOnly: true,
		},
	);
	assert.deepEqual(parseCodeGraphExploreInput({ query: " ToolSystem onToolCall ", maxFiles: 2 }), {
		operation: "explore",
		query: "ToolSystem onToolCall",
		maxFiles: 2,
	});
	assert.deepEqual(parseCodeGraphImpactInput({ symbol: "ToolSystem", depth: 3 }), {
		operation: "impact",
		symbol: "ToolSystem",
		depth: 3,
	});
	assert.throws(
		() => parseCodeGraphExploreInput({ query: "trace", scope: ["src"] }),
		/execution-time validation/,
	);
	assert.throws(
		() => parseCodeGraphNodeInput({ symbol: "ToolSystem", symbolsOnly: true }),
		/require file mode/,
	);
	assert.throws(
		() => parseCodeGraphSearchInput({ query: "unsafe\nquery" }),
		/safe single-line/,
	);
});

test("CodeGraph provider maps native operations, caches status, and deduplicates within a turn", async () => {
	const requests: CodeGraphCommandRequest[] = [];
	const runner: CodeGraphCommandRunner = async (request) => {
		requests.push(request);
		return request.args[0] === "status"
			? {
					exitCode: 0,
					stdout: JSON.stringify({
						initialized: true,
						pendingChanges: { added: 0, modified: 0, removed: 0 },
						worktreeMismatch: null,
						index: {
							reindexRecommended: false,
							state: "complete",
							pendingRefs: 0,
						},
					}),
					stderr: "",
				}
			: {
					exitCode: 0,
					stdout: "src/cache.ts: observe() -> completeRequest()",
					stderr: "",
				};
	};
	const provider = createCodeGraphProvider(workspaceRoot, runner);
	provider.beginTurn();
	const request = {
		operation: "explore" as const,
		query: "trace cache observations",
		maxFiles: 2,
	};
	const result = await provider.run(request);
	const reused = await provider.run(request);
	const search = await provider.run({
		operation: "search",
		query: "CacheObservationTracker",
		limit: 5,
	});

	assert.equal(result.availability, "ready");
	assert.equal(result.freshness, "fresh");
	assert.match(result.text, /completeRequest/);
	assert.equal(result.reused, false);
	assert.equal(reused.reused, true);
	assert.equal(reused.resultKey, result.resultKey);
	assert.equal(search.reused, false);
	assert.equal(requests.length, 3);
	assert.deepEqual(requests[0]?.args, ["status", "--json"]);
	assert.deepEqual(requests[1]?.args, [
		"explore",
		"--max-files",
		"2",
		"--",
		"trace cache observations",
	]);
	assert.deepEqual(requests[2]?.args, [
		"query",
		"--limit",
		"5",
		"--json",
		"--",
		"CacheObservationTracker",
	]);
	assert.equal(requests.every((request) => request.cwd === workspaceRoot), true);

	provider.beginTurn();
	await provider.run(request);
	assert.equal(requests.length, 5);
	assert.deepEqual(requests[3]?.args, ["status", "--json"]);
});

test("CodeGraph workspace manager initializes and syncs only its fixed workspace", async () => {
	const requests: CodeGraphCommandRequest[] = [];
	const runner: CodeGraphCommandRunner = async (request) => {
		requests.push(request);
		if (request.args[0] === "status") {
			return {
				exitCode: 0,
				stdout: JSON.stringify({
					initialized: true,
					version: "1.5.0",
					projectPath: workspaceRoot,
					lastIndexed: "2026-07-31T00:00:00.000Z",
					fileCount: 10,
					nodeCount: 20,
					edgeCount: 30,
					pendingChanges: { added: 0, modified: 0, removed: 0 },
					worktreeMismatch: null,
					index: {
						reindexRecommended: false,
						state: "complete",
						pendingRefs: 0,
					},
				}),
				stderr: "",
			};
		}
		return { exitCode: 0, stdout: `${request.args[0]} complete`, stderr: "" };
	};
	const manager = createCodeGraphWorkspaceManager(workspaceRoot, runner);
	const initialized = await manager.initialize();
	const synced = await manager.sync();

	assert.deepEqual(requests.map((request) => request.args), [
		["init", workspaceRoot],
		["status", "--json"],
		["sync", workspaceRoot],
		["status", "--json"],
	]);
	assert.equal(requests.every((request) => request.cwd === workspaceRoot), true);
	assert.equal(initialized.status.availability, "ready");
	assert.equal(initialized.status.fileCount, 10);
	assert.equal(synced.status.freshness, "fresh");
});

test("CodeGraph provider reports missing indexes without attempting a native query", async () => {
	let calls = 0;
	const provider = createCodeGraphProvider(workspaceRoot, async () => {
		calls += 1;
		return {
			exitCode: 0,
			stdout: JSON.stringify({ initialized: false, lastIndexed: null }),
			stderr: "",
		};
	});
	provider.beginTurn();
	const result = await provider.run({
		operation: "explore",
		query: "trace login",
		maxFiles: 2,
	});

	assert.equal(result.availability, "unindexed");
	assert.equal(calls, 1);
});

test("CodeGraph freshness parsing does not treat an explicit negative as stale", async () => {
	const provider = createCodeGraphProvider(workspaceRoot, async (request) =>
		request.args[0] === "status"
			? { exitCode: 0, stdout: "stale: no", stderr: "" }
			: { exitCode: 0, stdout: "function staleCacheEntry() {}", stderr: "" },
	);
	provider.beginTurn();
	const result = await provider.run({
		operation: "search",
		query: "cacheEntry",
		limit: 10,
	});

	assert.equal(result.availability, "ready");
	assert.equal(result.freshness, "fresh");
});

test("CodeGraph result staleness overrides a previously current status", async () => {
	const provider = createCodeGraphProvider(workspaceRoot, async (request) =>
		request.args[0] === "status"
			? { exitCode: 0, stdout: "Index current", stderr: "" }
			: { exitCode: 0, stdout: "Warning: stale index\nsrc/cache.ts", stderr: "" },
	);
	provider.beginTurn();
	const result = await provider.run({
		operation: "node",
		symbol: "cacheEntry",
		symbolsOnly: false,
	});

	assert.equal(result.availability, "ready");
	assert.equal(result.freshness, "stale");
});

test("CodeGraph structured status marks pending workspace changes as stale", async () => {
	const provider = createCodeGraphProvider(workspaceRoot, async (request) =>
		request.args[0] === "status"
			? {
					exitCode: 0,
					stdout: JSON.stringify({
						initialized: true,
						pendingChanges: { added: 0, modified: 1, removed: 0 },
						worktreeMismatch: null,
						index: { state: "complete", reindexRecommended: false, pendingRefs: 0 },
					}),
					stderr: "",
				}
			: { exitCode: 0, stdout: "src/cache.ts", stderr: "" },
	);
	provider.beginTurn();
	const result = await provider.run({
		operation: "impact",
		symbol: "cacheEntry",
		depth: 2,
	});

	assert.equal(result.availability, "ready");
	assert.equal(result.freshness, "stale");
});

test("CodeGraph structured status remains unknown when health fields are incomplete", async () => {
	const provider = createCodeGraphProvider(workspaceRoot, async (request) =>
		request.args[0] === "status"
			? {
					exitCode: 0,
					stdout: JSON.stringify({ initialized: true }),
					stderr: "",
				}
			: { exitCode: 0, stdout: "src/cache.ts", stderr: "" },
	);
	provider.beginTurn();
	const result = await provider.run({
		operation: "search",
		query: "cacheEntry",
		limit: 10,
	});

	assert.equal(result.availability, "ready");
	assert.equal(result.freshness, "unknown");
});

test("native CodeGraph tools preserve operation-specific requests and freshness guidance", async () => {
	const stages: string[] = [];
	const requests: string[] = [];
	const provider: CodeIntelligenceProvider = {
		id: "test-index",
		displayName: "Test Index",
		beginTurn() {},
		async run(request, _signal, onStage) {
			requests.push(request.operation);
			onStage?.("checking_index");
			onStage?.("querying");
			return {
				availability: "ready",
				freshness: "stale",
				text: request.operation === "search"
					? JSON.stringify([{ node: {
						name: "login",
						kind: "function",
						filePath: "src/auth.ts",
						startLine: 7,
					} }])
					: "src/auth.ts: login -> verifySession",
				truncated: false,
				reused: false,
				resultKey: `result-${request.operation}`,
			};
		},
	};
	const search = await createCodeGraphSearchTool(provider).execute(
		"code-0",
		{ query: "login" },
	);
	const node = await createCodeGraphNodeTool(provider).execute(
		"code-1",
		{ symbol: "login" },
	);
	const result = await createCodeGraphExploreTool(provider).execute(
		"code-1",
		{ query: "login verifySession", maxFiles: 2 },
		undefined,
		(update) => stages.push(update.details.stage),
	);
	const impact = await createCodeGraphImpactTool(provider).execute(
		"code-2",
		{ symbol: "login" },
	);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.deepEqual(requests, ["search", "node", "explore", "impact"]);
	assert.deepEqual(stages, ["validating", "checking_index", "querying"]);
	assert.match(text, /relationshipFreshness=stale/);
	assert.match(text, /current disk/);
	assert.match(text, /verifySession/);
	assert.equal(result.details.availability, "ready");
	assert.equal(result.details.sourceMode, "current-on-disk-if-included");
	assert.equal(search.details.sourceMode, "not-included");
	assert.deepEqual(search.details.anchors, [
		{ name: "login", kind: "function", file: "src/auth.ts", line: 7 },
	]);
	assert.match(
		search.content[0]?.type === "text" ? search.content[0].text : "",
		/anchors=login@src\/auth\.ts:7/,
	);
	assert.equal(node.details.operation, "node");
	assert.equal(impact.details.operation, "impact");
});

test("CodeGraph tools return a compact reference for reused results", async () => {
	let calls = 0;
	const provider: CodeIntelligenceProvider = {
		id: "test-index",
		displayName: "Test Index",
		beginTurn() {},
		async run() {
			calls += 1;
			return {
				availability: "ready",
				freshness: "fresh",
				text: "large earlier result",
				truncated: false,
				reused: true,
				resultKey: "abc123",
			};
		},
	};
	const result = await createCodeGraphExploreTool(provider).execute(
		"code-2",
		{ query: "login verifySession" },
	);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.equal(calls, 1);
	assert.match(text, /already returned earlier/);
	assert.equal(text.includes("large earlier result"), false);
	assert.equal(result.details.reused, true);
});

test("CodeGraph provider stays stale after an edit until synchronization completes", async () => {
	const provider = createCodeGraphProvider(workspaceRoot, async (request) =>
		request.args[0] === "status"
			? { exitCode: 0, stdout: "Index current", stderr: "" }
			: { exitCode: 0, stdout: "[]", stderr: "" },
	);
	provider.markWorkspaceChanged?.();
	const stale = await provider.run({ operation: "search", query: "apply", limit: 1 });
	provider.markWorkspaceSynchronized?.();
	const fresh = await provider.run({ operation: "search", query: "apply", limit: 1 });

	assert.equal(stale.freshness, "stale");
	assert.equal(fresh.freshness, "fresh");
});

test("automatic CodeGraph sync is single-flight and runs one trailing refresh", async () => {
	let active = 0;
	let maxActive = 0;
	let syncCalls = 0;
	const releases: Array<() => void> = [];
	const manager: CodeGraphWorkspaceManager = {
		async status() {
			return { availability: "ready", freshness: "fresh" };
		},
		async initialize() {
			throw new Error("unused");
		},
		async sync() {
			syncCalls += 1;
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise<void>((resolve) => releases.push(resolve));
			active -= 1;
			return {
				operation: "sync" as const,
				output: "",
				truncated: false,
				status: { availability: "ready" as const, freshness: "fresh" as const },
			};
		},
	};
	let changed = 0;
	let synchronized = 0;
	const provider: CodeIntelligenceProvider = {
		id: "test-index",
		displayName: "Test Index",
		beginTurn() {},
		markWorkspaceChanged() { changed += 1; },
		markWorkspaceSynchronized() { synchronized += 1; },
		async run() { throw new Error("unused"); },
	};
	const coordinator = createCodeGraphSyncCoordinator(manager, provider);
	coordinator.schedule();
	coordinator.schedule();
	assert.equal(syncCalls, 1);
	releases.shift()?.();
	while (syncCalls < 2) await new Promise<void>((resolve) => setImmediate(resolve));
	releases.shift()?.();
	await coordinator.waitForIdle();

	assert.equal(changed, 2);
	assert.equal(syncCalls, 2);
	assert.equal(maxActive, 1);
	assert.equal(synchronized, 1);
});

test("edit impact preflight maps a fresh changed range to one symbol", async () => {
	const requests: string[] = [];
	const provider: CodeIntelligenceProvider = {
		id: "test-index",
		displayName: "Test Index",
		beginTurn() {},
		async run(request) {
			requests.push(request.operation === "impact" ? request.symbol : request.operation);
			return {
				availability: "ready",
				freshness: "fresh",
				text: request.operation === "node"
					? "**src/progress.ts**\n\n**Symbols**\n- `Progress` (class) — :1\n- `apply` (method) — :10\n- `render` (method) — :20"
					: request.operation === "search"
						? JSON.stringify([{ node: {
							name: "apply",
							kind: "method",
							qualifiedName: "Progress::apply",
							filePath: "src/progress.ts",
							startLine: 10,
							endLine: 18,
						} }])
						: JSON.stringify({ affected: [
						{ name: "apply", kind: "method", filePath: "src/progress.ts", startLine: 10 },
						{ name: "caller", kind: "function", filePath: "src/tui.ts", startLine: 42 },
						] }),
				truncated: false,
				reused: false,
				resultKey: request.operation,
			};
		},
	};
	const result = await analyzeCodeGraphEditImpact(provider, {
		id: "proposal",
		kind: "replace",
		path: "src/progress.ts",
		diff: "-old\n+new",
		changedRange: { startLine: 12, endLine: 12 },
		expiresAt: "2026-01-01T00:00:00.000Z",
	});

	assert.equal(result?.status, "available");
	assert.equal(result?.symbol?.name, "apply");
	assert.deepEqual(requests, ["node", "search", "Progress::apply"]);
	assert.deepEqual(result?.affected, [
		{ name: "caller", kind: "function", file: "src/tui.ts", line: 42 },
	]);
});

test("edit impact preflight rejects definitions that do not contain the full change", async () => {
	const provider: CodeIntelligenceProvider = {
		id: "test-index",
		displayName: "Test Index",
		beginTurn() {},
		async run(request) {
			return {
				availability: "ready",
				freshness: "fresh",
				text: request.operation === "node"
					? "**src/progress.ts**\n\n**Symbols**\n- `apply` (method) — :10"
					: JSON.stringify([{ node: {
						name: "apply",
						kind: "method",
						qualifiedName: "Progress::apply",
						filePath: "src/progress.ts",
						startLine: 10,
						endLine: 12,
					} }]),
				truncated: false,
				reused: false,
				resultKey: request.operation,
			};
		},
	};
	const result = await analyzeCodeGraphEditImpact(provider, {
		id: "proposal",
		kind: "replace",
		path: "src/progress.ts",
		diff: "-old\n+new",
		changedRange: { startLine: 12, endLine: 13 },
		expiresAt: "2026-01-01T00:00:00.000Z",
	});

	assert.equal(result?.status, "unavailable");
	assert.match(result?.reason ?? "", /unique indexed definition/);
});

test("edit impact preflight failure degrades without rejecting the edit", async () => {
	const provider: CodeIntelligenceProvider = {
		id: "test-index",
		displayName: "Test Index",
		beginTurn() {},
		async run() { throw new Error("index process failed"); },
	};
	const result = await analyzeCodeGraphEditImpact(provider, {
		id: "proposal",
		kind: "replace",
		path: "src/progress.ts",
		diff: "-old\n+new",
		changedRange: { startLine: 12, endLine: 12 },
		expiresAt: "2026-01-01T00:00:00.000Z",
	});

	assert.equal(result?.status, "unavailable");
	assert.match(result?.reason ?? "", /timed out or failed/);
});
