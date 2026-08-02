import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { resolveWorkspaceRoot } from "../src/workspace-config.ts";

test("workspace defaults to the directory that launched npm", () => {
	const processDirectory = resolve("tools", "pi");
	const openedProject = resolve("projects", "opened-project");
	assert.equal(
		resolveWorkspaceRoot(
			{ INIT_CWD: openedProject },
			processDirectory,
		),
		openedProject,
	);
});

test("workspace falls back to the process directory outside npm", () => {
	const openedProject = resolve("projects", "opened-project");
	assert.equal(
		resolveWorkspaceRoot({}, openedProject),
		openedProject,
	);
});

test("explicit workspace override remains authoritative", () => {
	const processDirectory = resolve("tools", "pi");
	assert.equal(
		resolveWorkspaceRoot(
			{
				INIT_CWD: resolve("projects", "opened-project"),
				LOGOS_AGENT_WORKSPACE: "../other-project",
			},
			processDirectory,
		),
		resolve(processDirectory, "../other-project"),
	);
});
