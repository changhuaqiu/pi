import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import {
	createApplyEditTool,
	createControlledEditManager,
	createNodeControlledEditOperations,
	createProposeCreateFileTool,
	createProposeDeleteFileTool,
	createProposePatchTool,
} from "../src/controlled-edit-tools.ts";

let workspaceRoot = "";
let targetPath = "";
let createdPath = "";

before(async () => {
	workspaceRoot = await mkdtemp(join(tmpdir(), "logos-agent-controlled-edit-"));
	await mkdir(join(workspaceRoot, "apps", "logos-agent", "src"), { recursive: true });
	targetPath = join(workspaceRoot, "apps", "logos-agent", "src", "app.ts");
	createdPath = join(workspaceRoot, "apps", "logos-agent", "src", "created.ts");
});

beforeEach(async () => {
	await writeFile(targetPath, "const answer = 41;\nexport { answer };\n");
	await rm(createdPath, { force: true });
});

after(async () => {
	await rm(workspaceRoot, { recursive: true, force: true });
});

function createManager(id = "proposal-1") {
	return createControlledEditManager({
		operations: createNodeControlledEditOperations(workspaceRoot),
		createId: () => id,
		now: () => new Date("2026-01-01T00:00:00.000Z"),
	});
}

test("propose_patch prepares a diff without writing", async () => {
	const manager = createManager();
	const tool = createProposePatchTool(manager);
	const result = await tool.execute("propose-1", {
		path: "apps/logos-agent/src/app.ts",
		oldText: "const answer = 41;",
		newText: "const answer = 42;",
		description: "Correct the answer",
	});
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.match(text, /proposal-1/);
	assert.match(text, /-const answer = 41;/);
	assert.match(text, /\+const answer = 42;/);
	assert.match(text, /no approval has been requested/);
	assert.match(text, /Next tool call: apply_edit/);
	assert.equal(result.details.stage, "prepared");
	assert.deepEqual(manager.getProposal("proposal-1").changedRange, {
		startLine: 1,
		endLine: 1,
	});
	assert.equal(await readFile(targetPath, "utf8"), "const answer = 41;\nexport { answer };\n");
});

test("proposal display neutralizes Unicode formatting controls", async () => {
	const manager = createManager();
	await writeFile(targetPath, 'const label = "safe\u202Eevil";\n');

	const proposal = await manager.prepare({
		kind: "replace",
		path: "apps/logos-agent/src/app.ts",
		oldText: "safe\u202Eevil",
		newText: "safe",
		description: "Remove\u202Ehidden formatting",
	});

	assert.equal(proposal.description, "Remove hidden formatting");
	assert.match(proposal.diff, /safe\\u202eevil/);
	assert.doesNotMatch(proposal.diff, /\u202E/);
});

test("patch range includes a removed newline boundary", async () => {
	const manager = createManager();
	const proposal = await manager.prepare({
		kind: "replace",
		path: "apps/logos-agent/src/app.ts",
		oldText: "const answer = 41;\n",
		newText: "const answer = 42;",
	});

	assert.deepEqual(proposal.changedRange, { startLine: 1, endLine: 2 });
});

test("apply_edit requires approval and applies an approved proposal atomically", async () => {
	const manager = createManager();
	await manager.prepare({
		kind: "replace",
		path: "apps/logos-agent/src/app.ts",
		oldText: "41",
		newText: "42",
	});
	const tool = createApplyEditTool(manager);

	await assert.rejects(tool.execute("apply-1", { proposalId: "proposal-1" }), /has not been approved/);
	manager.approve("proposal-1");
	const result = await tool.execute("apply-2", { proposalId: "proposal-1" });

	assert.equal(result.details.stage, "completed");
	assert.equal(await readFile(targetPath, "utf8"), "const answer = 42;\nexport { answer };\n");
	assert.deepEqual(
		(await readdir(join(workspaceRoot, "apps", "logos-agent", "src"))).filter((name) =>
			name.startsWith(".logos-agent-edit-"),
		),
		[],
	);
});

test("propose_create_file prepares an absent-path proposal and apply_edit creates it", async () => {
	const manager = createManager();
	const proposalResult = await createProposeCreateFileTool(manager).execute("create-proposal", {
		path: "apps/logos-agent/src/created.ts",
		content: "export const created = true;\n",
		description: "Add a module",
	});

	assert.match(
		proposalResult.content[0]?.type === "text" ? proposalResult.content[0].text : "",
		/--- \/dev\/null/,
	);
	assert.equal(manager.getProposal("proposal-1").kind, "create");
	await assert.rejects(readFile(createdPath, "utf8"), { code: "ENOENT" });

	manager.approve("proposal-1");
	const applied = await createApplyEditTool(manager).execute("apply-create", {
		proposalId: "proposal-1",
	});
	assert.equal(applied.details.previousHash, undefined);
	assert.equal(applied.details.newHash?.length, 64);
	assert.equal(await readFile(createdPath, "utf8"), "export const created = true;\n");
});

test("create proposal refuses existing and concurrently created targets", async () => {
	const manager = createManager();
	await assert.rejects(
		manager.prepare({
			kind: "create",
			path: "apps/logos-agent/src/app.ts",
			content: "replacement\n",
		}),
		/already exists/,
	);

	await manager.prepare({
		kind: "create",
		path: "apps/logos-agent/src/created.ts",
		content: "agent content\n",
	});
	manager.approve("proposal-1");
	await writeFile(createdPath, "external content\n");
	await assert.rejects(manager.apply("proposal-1"), /stale/);
	assert.equal(await readFile(createdPath, "utf8"), "external content\n");
});

test("propose_delete_file deletes only the unchanged approved snapshot", async () => {
	const manager = createManager();
	const proposalResult = await createProposeDeleteFileTool(manager).execute("delete-proposal", {
		path: "apps/logos-agent/src/app.ts",
		description: "Remove obsolete module",
	});
	assert.match(
		proposalResult.content[0]?.type === "text" ? proposalResult.content[0].text : "",
		/\+\+\+ \/dev\/null/,
	);
	assert.equal(await readFile(targetPath, "utf8"), "const answer = 41;\nexport { answer };\n");

	manager.approve("proposal-1");
	const applied = await createApplyEditTool(manager).execute("apply-delete", {
		proposalId: "proposal-1",
	});
	assert.equal(applied.details.previousHash?.length, 64);
	assert.equal(applied.details.newHash, undefined);
	await assert.rejects(readFile(targetPath, "utf8"), { code: "ENOENT" });
});

test("delete proposal rejects a file changed after preparation", async () => {
	const manager = createManager();
	await manager.prepare({
		kind: "delete",
		path: "apps/logos-agent/src/app.ts",
	});
	manager.approve("proposal-1");
	await writeFile(targetPath, "new external content\n");

	await assert.rejects(manager.apply("proposal-1"), /stale/);
	assert.equal(await readFile(targetPath, "utf8"), "new external content\n");
	assert.deepEqual(
		(await readdir(join(workspaceRoot, "apps", "logos-agent", "src"))).filter((name) =>
			name.endsWith(".delete"),
		),
		[],
	);
});

test("apply_edit refuses a target locked by another Logos Agent writer", async () => {
	const manager = createManager();
	await manager.prepare({
		kind: "replace",
		path: "apps/logos-agent/src/app.ts",
		oldText: "41",
		newText: "42",
	});
	manager.approve("proposal-1");
	const resolvedTarget = await realpath(targetPath);
	const lockId = createHash("sha256").update(resolvedTarget).digest("hex").slice(0, 16);
	const lockPath = join(workspaceRoot, "apps", "logos-agent", "src", `.logos-agent-edit-${lockId}.lock`);
	await writeFile(lockPath, "held");

	try {
		await assert.rejects(manager.apply("proposal-1"), /holds the target lock/);
		assert.equal(await readFile(targetPath, "utf8"), "const answer = 41;\nexport { answer };\n");
		assert.equal(await readFile(lockPath, "utf8"), "held");
	} finally {
		await rm(lockPath, { force: true });
	}
});

test("re-approval is idempotent when execution was delayed after approval", async () => {
	const manager = createManager();
	await manager.prepare({
		kind: "replace",
		path: "apps/logos-agent/src/app.ts",
		oldText: "41",
		newText: "42",
	});

	manager.approve("proposal-1");
	manager.approve("proposal-1");
	assert.equal((await manager.apply("proposal-1")).newHash?.length, 64);
});

test("apply_edit rejects a stale proposal without overwriting the newer file", async () => {
	const manager = createManager();
	await manager.prepare({
		kind: "replace",
		path: "apps/logos-agent/src/app.ts",
		oldText: "41",
		newText: "42",
	});
	manager.approve("proposal-1");
	await writeFile(targetPath, "const answer = 100;\nexport { answer };\n");

	await assert.rejects(manager.apply("proposal-1"), /stale/);
	assert.equal(await readFile(targetPath, "utf8"), "const answer = 100;\nexport { answer };\n");
});

test("propose_patch requires a unique exact match", async () => {
	const manager = createManager();
	await writeFile(targetPath, "same\nsame\n");

	await assert.rejects(
		manager.prepare({
			kind: "replace",
			path: "apps/logos-agent/src/app.ts",
			oldText: "same",
			newText: "different",
		}),
		/found 2/,
	);
});

test("controlled edits cover the workspace while rejecting unsafe paths", async () => {
	const manager = createManager();
	await writeFile(join(workspaceRoot, "outside.ts"), "outside\n");

	const proposal = await manager.prepare({
		kind: "replace",
		path: "outside.ts",
		oldText: "outside",
		newText: "changed",
	});
	assert.equal(proposal.path, "outside.ts");
	manager.approve(proposal.id);
	await manager.apply(proposal.id);
	assert.equal(await readFile(join(workspaceRoot, "outside.ts"), "utf8"), "changed\n");
	await assert.rejects(
		manager.prepare({
			kind: "replace",
			path: "../outside.ts",
			oldText: "outside",
			newText: "changed",
		}),
		/traversal/,
	);
	await assert.rejects(
		manager.prepare({
			kind: "create",
			path: ".env",
			content: "SECRET=value\n",
		}),
		/Sensitive file/,
	);
	await assert.rejects(
		manager.prepare({
			kind: "create",
			path: ".ssh/config",
			content: "Host example\n",
		}),
		/not readable/,
	);
	await assert.rejects(
		manager.prepare({
			kind: "replace",
			path: "apps/logos-agent/src/app\u202Ets",
			oldText: "41",
			newText: "42",
		}),
		/Unicode control or formatting/,
	);
});

test("controlled edits reject final symbolic links", async (context) => {
	const outside = join(workspaceRoot, "outside-link-target.ts");
	const link = join(workspaceRoot, "apps", "logos-agent", "src", "linked.ts");
	await writeFile(outside, "outside\n");
	try {
		await symlink(outside, link, "file");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EPERM") {
			context.skip("Creating file symlinks requires Windows Developer Mode");
			return;
		}
		throw error;
	}
	const manager = createManager();

	await assert.rejects(
		manager.prepare({
			kind: "replace",
			path: "apps/logos-agent/src/linked.ts",
			oldText: "outside",
			newText: "changed",
		}),
		/Symbolic links/,
	);
});

test("controlled edits reject linked directory segments", async (context) => {
	const realDirectory = join(workspaceRoot, "real-directory");
	const linkedDirectory = join(workspaceRoot, "linked-directory");
	await mkdir(realDirectory, { recursive: true });
	await writeFile(join(realDirectory, "app.ts"), "outside\n");
	try {
		await symlink(
			realDirectory,
			linkedDirectory,
			process.platform === "win32" ? "junction" : "dir",
		);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EPERM") {
			context.skip("Creating directory links requires additional privileges");
			return;
		}
		throw error;
	}
	const manager = createManager();

	try {
		await assert.rejects(
			manager.prepare({
				kind: "replace",
				path: "linked-directory/app.ts",
				oldText: "outside",
				newText: "changed",
			}),
			/Symbolic links/,
		);
	} finally {
		await rm(linkedDirectory, { force: true });
		await rm(realDirectory, { recursive: true, force: true });
	}
});

test("aborting an approved edit leaves the target unchanged", async () => {
	const manager = createManager();
	await manager.prepare({
		kind: "replace",
		path: "apps/logos-agent/src/app.ts",
		oldText: "41",
		newText: "42",
	});
	manager.approve("proposal-1");
	const controller = new AbortController();
	controller.abort();

	await assert.rejects(manager.apply("proposal-1", controller.signal), { name: "AbortError" });
	assert.equal(await readFile(targetPath, "utf8"), "const answer = 41;\nexport { answer };\n");
});
