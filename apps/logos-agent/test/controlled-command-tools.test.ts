import assert from "node:assert/strict";
import { ChildProcess, spawnSync } from "node:child_process";
import {
	lstat,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	commandPlanApprovalSummary,
	createCommandStatusTool,
	createNodeControlledCommandManager,
	createRunCommandTool,
	createStopCommandTool,
	type ControlledCommandManager,
} from "../src/controlled-command-tools.ts";

const validationRoot = resolve(import.meta.dirname, "..", "..", "..");

async function createProject(
	scripts: Record<string, string> = {},
): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "logos-agent-command-"));
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({
			name: "controlled-command-fixture",
			version: "1.0.0",
			private: true,
			scripts,
		}),
		"utf8",
	);
	return root;
}

test("run_command exposes structured npm operations and streams bounded updates", async () => {
	const updates: string[] = [];
	const manager: ControlledCommandManager = {
		async prepare() {
			throw new Error("not used");
		},
		approve() {},
		async executeApproved(toolCallId, _signal, onOutput) {
			assert.equal(toolCallId, "command-1");
			onOutput?.({
				stream: "stdout",
				text: "ready at http://localhost:3000\n",
				stdoutBytes: 31,
				stderrBytes: 0,
				truncated: false,
			});
			return {
				operation: "npm_run",
				command: "npm run dev --",
				cwd: ".",
				mode: "service",
				status: "running",
				processId: "process-1",
				osPid: 123,
				stdout: "ready at http://localhost:3000\n",
				stderr: "",
				truncated: false,
				durationMs: 25,
				urls: ["http://localhost:3000"],
			};
		},
		listProcesses() {
			return [];
		},
		getProcess() {
			throw new Error("not used");
		},
		async stopProcess() {
			throw new Error("not used");
		},
		async shutdown() {},
	};
	const tool = createRunCommandTool(manager);
	assert.equal(tool.parameters.type, "object");
	assert.ok("properties" in tool.parameters);
	assert.match(
		JSON.stringify(tool.parameters),
		/"additionalProperties":false/,
	);
	const result = await tool.execute(
		"command-1",
		{
			operation: "npm_run",
			script: "dev",
			mode: "service",
		},
		undefined,
		(update) => {
			assert.equal(update.details.stream, "stdout");
			updates.push(
				update.content[0]?.type === "text"
					? update.content[0].text
					: "",
			);
		},
	);

	assert.match(updates[0] ?? "", /localhost:3000/);
	assert.equal(result.details.processId, "process-1");
	assert.match(
		result.content[0]?.type === "text" ? result.content[0].text : "",
		/Detected URLs/,
	);
	await assert.rejects(
		tool.execute(
			"command-injected",
			{
				operation: "npm_run",
				script: "dev",
				command: "npm run dev && rm -rf .",
			} as never,
		),
		/execution-time validation/,
	);
});

test("controlled command preparation shows every npm lifecycle script and safe install defaults", async () => {
	const root = await createProject({
		predev: "node scripts/check-config.js",
		dev: "vite --host 127.0.0.1",
		postdev: "node scripts/cleanup.js",
	});
	const manager = createNodeControlledCommandManager(root, validationRoot);
	try {
		const install = await manager.prepare({ operation: "npm_install" });
		assert.equal(
			install.command,
			"npm install --no-audit --no-fund --ignore-scripts",
		);
		assert.equal(install.mode, "foreground");
		assert.match(install.risks.join("\n"), /writes dependencies/);

		const run = await manager.prepare({
			operation: "npm_run",
			script: "dev",
			mode: "service",
			startupWaitMs: 250,
		});
		assert.deepEqual(run.scripts, [
			{ name: "predev", command: "node scripts/check-config.js" },
			{ name: "dev", command: "vite --host 127.0.0.1" },
			{ name: "postdev", command: "node scripts/cleanup.js" },
		]);
		assert.equal(commandPlanApprovalSummary(run).command, "npm run dev --");
		assert.match(run.risks.join("\n"), /long-running/);

		await assert.rejects(
			manager.prepare({
				operation: "npm_run",
				script: "missing",
			}),
			/does not define/,
		);
		await assert.rejects(
			manager.prepare({
				operation: "npm_install",
				script: "dev",
			}),
			/execution-time validation/,
		);
		await assert.rejects(
			manager.prepare({
				operation: "npm_install",
				timeoutMs: 300_001,
			}),
			/execution-time validation/,
		);
		await assert.rejects(
			manager.prepare({
				operation: "npm_run",
				script: "dev",
				lifecycleScripts: true,
			}),
			/execution-time validation/,
		);
		await assert.rejects(
			manager.prepare({
				operation: "npm_run",
				script: "dev",
				cwd: "../outside",
			}),
			/traversal/,
		);
	} finally {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});

test("controlled command executes npm install without lifecycle scripts", async () => {
	const root = await createProject({
		postinstall:
			'node -e "require(\'node:fs\').writeFileSync(\'lifecycle-ran\', \'yes\')"',
	});
	const manager = createNodeControlledCommandManager(root, validationRoot);
	try {
		const plan = await manager.prepare({
			operation: "npm_install",
			timeoutMs: 60_000,
		});
		manager.approve("install-1", plan);
		const result = await manager.executeApproved("install-1");

		assert.equal(result.status, "exited");
		assert.equal(result.exitCode, 0, result.stderr || result.stdout);
		await assert.rejects(
			lstat(join(root, "lifecycle-ran")),
			{ code: "ENOENT" },
		);
	} finally {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});

test("controlled command runs a package script with scrubbed credentials and URL evidence", async () => {
	const root = await createProject({
		inspect:
			'node -e "console.log(process.env.OPENAI_API_KEY || \'credential-scrubbed\'); console.log(\'http://localhost:3000\')"',
	});
	const manager = createNodeControlledCommandManager(root, validationRoot);
	const previousKey = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "must-not-reach-command";
	try {
		const plan = await manager.prepare({
			operation: "npm_run",
			script: "inspect",
			timeoutMs: 60_000,
		});
		manager.approve("inspect-1", plan);
		const updates: string[] = [];
		const result = await manager.executeApproved(
			"inspect-1",
			undefined,
			(event) => updates.push(event.text),
		);

		assert.equal(result.status, "exited");
		assert.equal(result.exitCode, 0, result.stderr || result.stdout);
		assert.match(result.stdout, /credential-scrubbed/);
		assert.doesNotMatch(result.stdout, /must-not-reach-command/);
		assert.deepEqual(result.urls, ["http://localhost:3000"]);
		assert.ok(updates.some((text) => text.includes("localhost:3000")));
	} finally {
		if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previousKey;
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});

test("controlled command bounds both captured and streamed output", async () => {
	const root = await createProject({
		loud: 'node -e "process.stdout.write(\'x\'.repeat(100000))"',
	});
	const manager = createNodeControlledCommandManager(root, validationRoot);
	try {
		const plan = await manager.prepare({
			operation: "npm_run",
			script: "loud",
			timeoutMs: 60_000,
		});
		manager.approve("loud-1", plan);
		let streamedBytes = 0;
		const result = await manager.executeApproved(
			"loud-1",
			undefined,
			(event) => {
				streamedBytes += Buffer.byteLength(event.text, "utf8");
			},
		);

		assert.equal(result.exitCode, 0, result.stderr);
		assert.equal(result.truncated, true);
		assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 32 * 1024);
		assert.ok(streamedBytes <= 32 * 1024);
	} finally {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});

test("streamed redaction holds partial lines so split credentials never leak", async () => {
	const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
	const root = await createProject({
		secret:
			'node -e "process.stdout.write(\'sk-abcdefghij\'); setTimeout(() => process.stdout.write(\'klmnopqrstuvwxyz123456\\\\n\'), 100)"',
	});
	const manager = createNodeControlledCommandManager(root, validationRoot);
	try {
		const plan = await manager.prepare({
			operation: "npm_run",
			script: "secret",
			timeoutMs: 60_000,
		});
		manager.approve("secret-1", plan);
		const updates: string[] = [];
		const result = await manager.executeApproved(
			"secret-1",
			undefined,
			(event) => updates.push(event.text),
		);

		assert.equal(result.exitCode, 0, result.stderr);
		assert.doesNotMatch(updates.join(""), new RegExp(secret));
		assert.match(updates.join(""), /<redacted-key>/);
		assert.doesNotMatch(result.stdout, new RegExp(secret));
	} finally {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});

test("managed development command can be inspected, stopped, and cleaned up", async () => {
	const root = await createProject({
		dev:
			'node -e "console.log(\'http://localhost:3000\'); setInterval(() => {}, 1000)"',
	});
	const manager = createNodeControlledCommandManager(root, validationRoot);
	try {
		const plan = await manager.prepare({
			operation: "npm_run",
			script: "dev",
			mode: "service",
			startupWaitMs: 1_000,
			timeoutMs: 10_000,
		});
		manager.approve("dev-1", plan);
		const result = await manager.executeApproved("dev-1");

		assert.equal(result.status, "running", result.stderr || result.stdout);
		assert.ok(result.processId);
		assert.deepEqual(result.urls, ["http://localhost:3000"]);
		const status = manager.getProcess(result.processId!);
		assert.equal(status.status, "running");
		assert.match(status.stdout ?? "", /localhost:3000/);

		const statusResult = await createCommandStatusTool(manager).execute(
			"status-1",
			{ processId: result.processId },
		);
		assert.match(
			statusResult.content[0]?.type === "text"
				? statusResult.content[0].text
				: "",
			/localhost:3000/,
		);
		const stopped = await manager.stopProcess(result.processId!);
		assert.equal(stopped.status, "stopped");
	} finally {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});

test("manager shutdown terminates every active managed command", async () => {
	const root = await createProject({
		dev:
			'node -e "console.log(\'ready\'); setInterval(() => {}, 1000)"',
	});
	const manager = createNodeControlledCommandManager(root, validationRoot);
	try {
		const plan = await manager.prepare({
			operation: "npm_run",
			script: "dev",
			mode: "service",
			startupWaitMs: 500,
			timeoutMs: 10_000,
		});
		manager.approve("shutdown-1", plan);
		const result = await manager.executeApproved("shutdown-1");
		assert.ok(result.processId);

		await manager.shutdown();
		assert.equal(manager.getProcess(result.processId!).status, "stopped");
	} finally {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});

test("service total lifetime includes the startup observation window", async () => {
	const root = await createProject({
		dev: 'node -e "setInterval(() => {}, 1000)"',
	});
	const manager = createNodeControlledCommandManager(root, validationRoot);
	try {
		const plan = await manager.prepare({
			operation: "npm_run",
			script: "dev",
			mode: "service",
			startupWaitMs: 30_000,
			timeoutMs: 1_000,
		});
		manager.approve("short-service-1", plan);
		const startedAt = Date.now();
		const result = await manager.executeApproved("short-service-1");

		assert.equal(result.status, "timed_out");
		assert.equal(result.processId, undefined);
		assert.ok(Date.now() - startedAt < 5_000);
	} finally {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});

test("failed termination remains running and shutdown retries cleanup", async () => {
	const root = await createProject({
		dev: 'node -e "setInterval(() => {}, 1000)"',
	});
	let terminationAttempts = 0;
	const manager = createNodeControlledCommandManager(root, validationRoot, {
		async terminateProcessTree(pid, killDirectChild) {
			terminationAttempts += 1;
			if (terminationAttempts <= 3) {
				throw new Error("injected termination failure");
			}
			if (process.platform === "win32") {
				const systemRoot =
					process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
				const killed = spawnSync(
					join(systemRoot, "System32", "taskkill.exe"),
					["/PID", String(pid), "/T", "/F"],
					{ windowsHide: true },
				);
				if (killed.status !== 0) killDirectChild();
			} else if (pid !== undefined) {
				process.kill(-pid, "SIGKILL");
			}
		},
	});
	try {
		const plan = await manager.prepare({
			operation: "npm_run",
			script: "dev",
			mode: "service",
			startupWaitMs: 500,
			timeoutMs: 10_000,
		});
		manager.approve("termination-failure-1", plan);
		const result = await manager.executeApproved("termination-failure-1");
		assert.ok(result.processId);

		await assert.rejects(
			manager.stopProcess(result.processId!),
			/injected termination failure/,
		);
		const stillRunning = manager.getProcess(result.processId!);
		assert.equal(stillRunning.status, "running");
		assert.match(
			stillRunning.errorMessage ?? "",
			/injected termination failure/,
		);

		await manager.shutdown();
		assert.equal(manager.getProcess(result.processId!).status, "stopped");
		assert.equal(terminationAttempts, 4);
	} finally {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});

test("foreground termination failure is reported and remains available to shutdown", async () => {
	const root = await createProject({
		hang: 'node -e "setInterval(() => {}, 1000)"',
	});
	let terminationAttempts = 0;
	const manager = createNodeControlledCommandManager(root, validationRoot, {
		async terminateProcessTree(pid, killDirectChild) {
			terminationAttempts += 1;
			if (terminationAttempts <= 3) {
				throw new Error("injected foreground termination failure");
			}
			if (process.platform === "win32") {
				const systemRoot =
					process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
				const killed = spawnSync(
					join(systemRoot, "System32", "taskkill.exe"),
					["/PID", String(pid), "/T", "/F"],
					{ windowsHide: true },
				);
				if (killed.status !== 0) killDirectChild();
			} else if (pid !== undefined) {
				process.kill(-pid, "SIGKILL");
			}
		},
	});
	try {
		const plan = await manager.prepare({
			operation: "npm_run",
			script: "hang",
			timeoutMs: 1_000,
		});
		manager.approve("foreground-termination-failure-1", plan);
		await assert.rejects(
			manager.executeApproved("foreground-termination-failure-1"),
			/injected foreground termination failure/,
		);

		await manager.shutdown();
		assert.equal(terminationAttempts, 4);
	} finally {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});

test("a child kill error without close remains active for shutdown retry", async () => {
	const root = await createProject({
		dev: 'node -e "setInterval(() => {}, 1000)"',
	});
	let terminationAttempts = 0;
	const manager = createNodeControlledCommandManager(root, validationRoot, {
		async terminateProcessTree(pid, killDirectChild) {
			terminationAttempts += 1;
			if (terminationAttempts <= 3) {
				killDirectChild();
				return;
			}
			if (process.platform === "win32") {
				const systemRoot =
					process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
				const killed = spawnSync(
					join(systemRoot, "System32", "taskkill.exe"),
					["/PID", String(pid), "/T", "/F"],
					{ windowsHide: true },
				);
				if (killed.status !== 0) killDirectChild();
			} else if (pid !== undefined) {
				process.kill(-pid, "SIGKILL");
			}
		},
	});
	const originalKill = ChildProcess.prototype.kill;
	try {
		const plan = await manager.prepare({
			operation: "npm_run",
			script: "dev",
			mode: "service",
			startupWaitMs: 500,
			timeoutMs: 20_000,
		});
		manager.approve("kill-error-1", plan);
		const result = await manager.executeApproved("kill-error-1");
		assert.ok(result.processId);

		ChildProcess.prototype.kill = function (): boolean {
			this.emit("error", new Error("simulated child kill error"));
			return false;
		};
		await assert.rejects(
			manager.stopProcess(result.processId!),
			/did not terminate/,
		);
		const stillRunning = manager.getProcess(result.processId!);
		assert.equal(stillRunning.status, "running");
		assert.match(stillRunning.errorMessage ?? "", /did not terminate/);

		ChildProcess.prototype.kill = originalKill;
		await manager.shutdown();
		assert.equal(manager.getProcess(result.processId!).status, "stopped");
		assert.equal(terminationAttempts, 4);
	} finally {
		ChildProcess.prototype.kill = originalKill;
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});

test("controlled command rejects linked cwd paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "logos-agent-command-link-"));
	const project = join(root, "project");
	const linked = join(root, "linked");
	await mkdir(project);
	await writeFile(
		join(project, "package.json"),
		JSON.stringify({
			name: "linked-project",
			version: "1.0.0",
			scripts: { check: 'node -e "console.log(\'ok\')"' },
		}),
		"utf8",
	);
	await symlink(project, linked, process.platform === "win32" ? "junction" : "dir");
	const manager = createNodeControlledCommandManager(root, validationRoot);
	try {
		await assert.rejects(
			manager.prepare({
				operation: "npm_run",
				script: "check",
				cwd: "linked",
			}),
			/Symbolic links/,
		);
	} finally {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});

test("controlled command rejects script names that npm could parse as options", async () => {
	const root = await createProject({ "-silent": "node ok.js" });
	const manager = createNodeControlledCommandManager(root, validationRoot);
	try {
		await assert.rejects(
			manager.prepare({
				operation: "npm_run",
				script: "-silent",
			}),
			/cannot begin with a hyphen/,
		);
	} finally {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});

test("foreground command abort terminates the process tree promptly", async () => {
	const root = await createProject({
		wait: 'node -e "setInterval(() => {}, 1000)"',
	});
	const manager = createNodeControlledCommandManager(root, validationRoot);
	const controller = new AbortController();
	try {
		const plan = await manager.prepare({
			operation: "npm_run",
			script: "wait",
			timeoutMs: 60_000,
		});
		manager.approve("abort-1", plan);
		const execution = manager.executeApproved("abort-1", controller.signal);
		setTimeout(() => controller.abort(), 500);

		await assert.rejects(execution, { name: "AbortError" });
	} finally {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});

test("approved command is rejected if package.json changes before execution", async () => {
	const root = await createProject({ check: 'node -e "console.log(\'ok\')"' });
	const manager = createNodeControlledCommandManager(root, validationRoot);
	try {
		const plan = await manager.prepare({
			operation: "npm_run",
			script: "check",
		});
		manager.approve("stale-1", plan);
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({
				name: "changed",
				version: "1.0.0",
				scripts: { check: 'node -e "console.log(\'changed\')"' },
			}),
			"utf8",
		);

		await assert.rejects(
			manager.executeApproved("stale-1"),
			/package\.json changed after command approval/,
		);
	} finally {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});

test("stop_command delegates only a validated managed process id", async () => {
	let stoppedId: string | undefined;
	const manager: ControlledCommandManager = {
		async prepare() {
			throw new Error("not used");
		},
		approve() {},
		async executeApproved() {
			throw new Error("not used");
		},
		listProcesses() {
			return [];
		},
		getProcess() {
			throw new Error("not used");
		},
		async stopProcess(processId) {
			stoppedId = processId;
			return {
				processId,
				command: "npm run dev --",
				cwd: ".",
				status: "stopped",
				startedAt: new Date(0).toISOString(),
				durationMs: 10,
				truncated: false,
				urls: [],
			};
		},
		async shutdown() {},
	};
	const result = await createStopCommandTool(manager).execute(
		"stop-1",
		{ processId: "process-1" },
	);

	assert.equal(stoppedId, "process-1");
	assert.equal(result.details.status, "stopped");
	await assert.rejects(
		createStopCommandTool(manager).execute(
			"stop-invalid",
			{ processId: "process-1", signal: "SIGKILL" } as never,
		),
		/execution-time validation/,
	);
});
