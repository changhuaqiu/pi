import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import {
	createNodeRunTaskOperations,
	createRunTaskTool,
	describeRunTask,
	parseRunTaskInput,
	type RunTaskOperations,
} from "../src/run-task-tool.ts";

test("run_task exposes only fixed validation tasks and reports progress", async () => {
	const operations: RunTaskOperations = {
		async run(task) {
			return {
				task,
				exitCode: 1,
				stdout: "test output",
				stderr: "test failure",
				truncated: false,
				durationMs: 25,
			};
		},
	};
	const stages: string[] = [];
	const result = await createRunTaskTool(operations).execute(
		"task",
		{ task: "learning_agent_test" },
		undefined,
		(update) => stages.push(update.details.stage),
	);

	assert.deepEqual(stages, ["validating", "running"]);
	assert.equal(result.details.exitCode, 1);
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /test failure/);
	assert.throws(
		() => parseRunTaskInput({ task: "learning_agent_test", cmd: "rm -rf ." }),
		/execution-time validation/,
	);
	assert.equal(describeRunTask("learning_agent_typecheck").cwd, ".");
});

test("run_task stops before its adapter when already aborted", async () => {
	let called = false;
	const operations: RunTaskOperations = {
		async run(task) {
			called = true;
			return {
				task,
				exitCode: 0,
				stdout: "",
				stderr: "",
				truncated: false,
				durationMs: 0,
			};
		},
	};
	const controller = new AbortController();
	controller.abort();

	await assert.rejects(
		createRunTaskTool(operations).execute(
			"task",
			{ task: "learning_agent_typecheck" },
			controller.signal,
		),
		{ name: "AbortError" },
	);
	assert.equal(called, false);
});

test("node run_task adapter executes the fixed Learning Agent typecheck", async () => {
	const workspaceRoot = resolve(import.meta.dirname, "..", "..", "..");
	const result = await createNodeRunTaskOperations(workspaceRoot).run(
		"learning_agent_typecheck",
	);

	assert.equal(result.exitCode, 0, result.stderr || result.stdout);
	assert.ok(result.durationMs > 0);
});

test("node run_task adapter aborts the fixed task process tree", async () => {
	const workspaceRoot = resolve(import.meta.dirname, "..", "..", "..");
	const controller = new AbortController();
	const startedAt = Date.now();
	const task = createNodeRunTaskOperations(workspaceRoot).run(
		"learning_agent_typecheck",
		controller.signal,
	);
	setTimeout(() => controller.abort(), 25);

	await assert.rejects(task, { name: "AbortError" });
	assert.ok(Date.now() - startedAt < 5_000);
});

test("node run_task adapter rejects promptly when tree termination fails", async () => {
	const workspaceRoot = resolve(import.meta.dirname, "..", "..", "..");
	const controller = new AbortController();
	const operations = createNodeRunTaskOperations(workspaceRoot, {
		async terminateProcessTree() {
			throw new Error("taskkill failed");
		},
	});
	const task = operations.run("learning_agent_typecheck", controller.signal);
	setTimeout(() => controller.abort(), 25);

	await assert.rejects(task, { name: "AbortError" });
});

test(
	"node run_task adapter executes tests without Provider credentials",
	{ skip: process.env.LEARNING_AGENT_FIXED_TASK === "1" },
	async () => {
		const workspaceRoot = resolve(import.meta.dirname, "..", "..", "..");
		const previousKey = process.env.DEEPSEEK_API_KEY;
		process.env.DEEPSEEK_API_KEY = "must-not-reach-child";
		try {
			const result = await createNodeRunTaskOperations(workspaceRoot).run(
				"learning_agent_test",
			);
			assert.equal(result.exitCode, 0, result.stderr || result.stdout);
			assert.equal(result.truncated, true);
			assert.doesNotMatch(result.stdout, /\uFFFD/);
			if (process.platform === "win32") {
				const descendantPid = Number(
					/JOB_DESCENDANT_PID=(\d+)/u.exec(result.stdout)?.[1],
				);
				assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
				let descendantAlive = true;
				for (let attempt = 0; attempt < 20 && descendantAlive; attempt += 1) {
					try {
						process.kill(descendantPid, 0);
						await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
					} catch {
						descendantAlive = false;
					}
				}
				assert.equal(descendantAlive, false, "Windows Job Object left a descendant alive");
			}
		} finally {
			if (previousKey === undefined) {
				delete process.env.DEEPSEEK_API_KEY;
			} else {
				process.env.DEEPSEEK_API_KEY = previousKey;
			}
		}
	},
);

test(
	"fixed task child receives a scrubbed environment",
	{ skip: process.env.LEARNING_AGENT_FIXED_TASK !== "1" },
	() => {
		assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
		if (process.platform === "win32") {
			const descendant = spawn(
				process.execPath,
				["-e", "setInterval(() => {}, 1000)"],
				{ stdio: "ignore", windowsHide: true },
			);
			descendant.unref();
			process.stdout.write(`JOB_DESCENDANT_PID=${descendant.pid}\n`);
		}
		process.stdout.write("\u{1F600}".repeat(9_000));
	},
);
