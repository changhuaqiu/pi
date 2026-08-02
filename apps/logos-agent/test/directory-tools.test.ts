import assert from "node:assert/strict";
import {
	lstat,
	mkdtemp,
	mkdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	createDirectoriesTool,
	createNodeWorkspaceDirectoryOperations,
	DirectoryCreationPartialError,
	type DirectoryToolDetails,
	parseCreateDirectoriesInput,
} from "../src/directory-tools.ts";

let workspaceRoot = "";

before(async () => {
	workspaceRoot = await mkdtemp(join(tmpdir(), "logos-agent-directories-"));
});

after(async () => {
	await rm(workspaceRoot, { recursive: true, force: true });
});

test("create_directories recursively creates multiple workspace directories", async () => {
	const operations = createNodeWorkspaceDirectoryOperations(workspaceRoot);
	const tool = createDirectoriesTool(operations);
	const result = await tool.execute("directories-1", {
		paths: [
			"src/core",
			"src/components",
			"src/hooks",
			"src/styles",
		],
	});

	for (const path of [
		"src/core",
		"src/components",
		"src/hooks",
		"src/styles",
	]) {
		assert.equal((await lstat(join(workspaceRoot, path))).isDirectory(), true);
	}
	assert.deepEqual(result.details.paths, [
		"src/core",
		"src/components",
		"src/hooks",
		"src/styles",
	]);
	assert.match(
		result.content[0]?.type === "text" ? result.content[0].text : "",
		/Created: "src", "src\/core", "src\/components", "src\/hooks", "src\/styles"/,
	);

	const repeated = await tool.execute("directories-2", {
		paths: ["src/core", "src/components"],
	});
	assert.deepEqual(repeated.details.unchanged, [
		"src/core",
		"src/components",
	]);
});

test("create_directories validates and canonicalizes approval paths", () => {
	assert.deepEqual(
		parseCreateDirectoriesInput({
			paths: ["src\\core", "./src/components"],
		}),
		{ paths: ["src/core", "src/components"] },
	);
	assert.throws(
		() => parseCreateDirectoriesInput({ paths: [] }),
		/failed execution-time validation/,
	);
	assert.throws(
		() => parseCreateDirectoriesInput({ paths: ["../outside"] }),
		/traversal/,
	);
	assert.throws(
		() => parseCreateDirectoriesInput({ paths: [".ssh/config"] }),
		/not readable/,
	);
});

test("create_directories rejects files and linked directory segments", async (context) => {
	const operations = createNodeWorkspaceDirectoryOperations(workspaceRoot);
	await writeFile(join(workspaceRoot, "blocking-file"), "not a directory\n");
	await assert.rejects(
		operations.createDirectories([
			"temporary/path",
			"blocking-file/child",
		]),
		/blocked by a file/,
	);
	await assert.rejects(lstat(join(workspaceRoot, "temporary")), { code: "ENOENT" });

	const realDirectory = join(workspaceRoot, "real-parent");
	const linkedDirectory = join(workspaceRoot, "linked-parent");
	await mkdir(realDirectory, { recursive: true });
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

	try {
		await assert.rejects(
			operations.createDirectories(["linked-parent/child"]),
			/Symbolic links/,
		);
	} finally {
		await rm(linkedDirectory, { force: true });
		await rm(realDirectory, { recursive: true, force: true });
	}
});

test("create_directories stops before mutation when aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		createNodeWorkspaceDirectoryOperations(workspaceRoot).createDirectories(
			["aborted/path"],
			controller.signal,
		),
		{ name: "AbortError" },
	);
	await assert.rejects(lstat(join(workspaceRoot, "aborted")), { code: "ENOENT" });
});

test("create_directories publishes preserved paths on partial failure", async () => {
	const updates: DirectoryToolDetails[] = [];
	const tool = createDirectoriesTool({
		async createDirectories() {
			throw new DirectoryCreationPartialError(
				"partial directory creation",
				{
					requested: ["src/core"],
					created: ["src", "src/core"],
					preserved: ["src", "src/core"],
				},
				{ cause: new Error("concurrent change") },
			);
		},
	});

	await assert.rejects(
		tool.execute(
			"directories-partial",
			{ paths: ["src/core"] },
			undefined,
			(update) => updates.push(update.details),
		),
		/partial directory creation/,
	);
	assert.deepEqual(updates.at(-1), {
		stage: "failed",
		paths: ["src/core"],
		created: ["src", "src/core"],
		preserved: ["src", "src/core"],
	});
});
