import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
	createGitBlameTool,
	createGitDiffTool,
	createGitLogTool,
	createGitShowTool,
	createGitStatusTool,
	createNodeGitOperations,
	type GitCommandOutput,
	type GitOperations,
} from "../src/git-tools.ts";

const execFileAsync = promisify(execFile);

class RecordingGitOperations implements GitOperations {
	readonly calls: string[][] = [];
	private readonly outputs: GitCommandOutput[];

	constructor(outputs: GitCommandOutput[]) {
		this.outputs = [...outputs];
	}

	async run(args: readonly string[]): Promise<GitCommandOutput> {
		this.calls.push([...args]);
		const output = this.outputs.shift();
		if (!output) throw new Error("Missing fake Git output");
		return output;
	}
}

test("git_status parses bounded porcelain output including paths with spaces and renames", async () => {
	const operations = new RecordingGitOperations([
		{
			stdout: [
				"## feature...origin/feature",
				"M  staged.ts",
				" M path with spaces.ts",
				"?? new file.ts",
				"R  renamed.ts",
				"old.ts",
				"",
			].join("\0"),
			truncated: false,
		},
	]);

	const result = await createGitStatusTool(operations).execute(
		"call",
		{},
		new AbortController().signal,
	);

	assert.deepEqual(operations.calls[0]?.slice(0, 4), ["status", "--porcelain=v1", "-z", "--branch"]);
	assert.ok(operations.calls[0]?.includes("--ignore-submodules=all"));
	assert.ok(operations.calls[0]?.some((argument) => argument.includes("exclude,icase")));
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Git status on feature/);
	assert.ok(result.details && "branch" in result.details);
	if (!result.details || !("branch" in result.details)) throw new Error("Expected status details");
	assert.deepEqual(result.details.untracked, ["new file.ts"]);
	assert.deepEqual(result.details.staged.at(-1), {
		path: "renamed.ts",
		previousPath: "old.ts",
		index: "R",
		worktree: " ",
	});
});

test("git_status reports an unborn branch name", async () => {
	const operations = new RecordingGitOperations([
		{ stdout: "## No commits yet on main\0", truncated: false },
	]);

	const result = await createGitStatusTool(operations).execute(
		"call",
		{},
		new AbortController().signal,
	);

	assert.ok(result.details && "branch" in result.details);
	if (!result.details || !("branch" in result.details)) throw new Error("Expected status details");
	assert.equal(result.details.branch, "main");
});

test("git tools reject traversal and option-like revisions before running Git", async () => {
	const operations = new RecordingGitOperations([]);

	await assert.rejects(
		createGitDiffTool(operations).execute(
			"call",
			{ path: "../secret", from: "HEAD" },
			new AbortController().signal,
		),
		/Parent path traversal/,
	);
	await assert.rejects(
		createGitShowTool(operations).execute(
			"call",
			{ commit: "--help" },
			new AbortController().signal,
		),
		/not a safe Git revision/,
	);
	assert.equal(operations.calls.length, 0);
});

test("git tools encode user paths as literal pathspecs", async () => {
	const diffOperations = new RecordingGitOperations([{ stdout: "", truncated: false }]);
	await createGitDiffTool(diffOperations).execute(
		"diff",
		{ path: "*.ts" },
		new AbortController().signal,
	);
	assert.ok(diffOperations.calls[0]?.includes(":(literal)*.ts"));

	const blameOperations = new RecordingGitOperations([{ stdout: "", truncated: false }]);
	await createGitBlameTool(blameOperations).execute(
		"blame",
		{ path: "*.ts" },
		new AbortController().signal,
	);
	assert.ok(blameOperations.calls[0]?.includes(":(literal)*.ts"));
});

test("git_log uses NUL-delimited fields and detects an additional entry", async () => {
	const record = (hash: string, abbreviated: string, subject: string) =>
		`${hash}\0${abbreviated}\0Alice\0${"2026-01-01T00:00:00Z"}\0${subject}\0`;
	const operations = new RecordingGitOperations([
		{
			stdout:
				record("a".repeat(40), "aaaaaaaa", "first") +
				record("b".repeat(40), "bbbbbbbb", "second"),
			truncated: false,
		},
	]);

	const result = await createGitLogTool(operations).execute(
		"call",
		{ maxCount: 1 },
		new AbortController().signal,
	);

	assert.ok(result.details && "entries" in result.details);
	if (!result.details || !("entries" in result.details)) throw new Error("Expected log details");
	assert.equal(result.details.entries.length, 1);
	assert.equal(result.details.entries[0]?.message, "first");
	assert.equal(result.details.truncated, true);
	assert.equal(operations.calls[0]?.[1], "--max-count=2");
});

test("git_show resolves a safe revision to a commit before reading its patch", async () => {
	const hash = "a".repeat(40);
	const operations = new RecordingGitOperations([
		{ stdout: `${hash}\n`, truncated: false },
		{
			stdout: `${hash}\0aaaaaaaa\0Alice\0${"2026-01-01T00:00:00Z"}\0subject\0`,
			truncated: false,
		},
		{ stdout: "diff --git a/file.ts b/file.ts\n", truncated: false },
	]);

	const result = await createGitShowTool(operations).execute(
		"call",
		{ commit: "HEAD~1", path: "file.ts" },
		new AbortController().signal,
	);

	assert.deepEqual(operations.calls[0], ["rev-parse", "--verify", "HEAD~1^{commit}"]);
	const pathspecIndex = operations.calls[2]?.indexOf("--") ?? -1;
	assert.equal(operations.calls[2]?.[pathspecIndex + 1], ":(literal)file.ts");
	assert.ok(operations.calls[2]?.some((argument) => argument.includes("exclude,icase")));
	assert.ok(result.details && "commit" in result.details);
});

test("git_blame reports final line numbers from line-porcelain output", async () => {
	const hash = "a".repeat(40);
	const operations = new RecordingGitOperations([
		{
			stdout: [
				`${hash} 2 7 1`,
				"author Alice",
				"author-time 1767225600",
				"\tconst answer = 42;",
				"",
			].join("\n"),
			truncated: false,
		},
	]);

	const result = await createGitBlameTool(operations).execute(
		"call",
		{ path: "file.ts", startLine: 7, maxLines: 1 },
		new AbortController().signal,
	);

	assert.ok(result.details && "lines" in result.details);
	if (!result.details || !("lines" in result.details)) throw new Error("Expected blame details");
	assert.equal(result.details.lines[0]?.line, 7);
	assert.equal(result.details.lines[0]?.content, "const answer = 42;");
	assert.ok(operations.calls[0]?.includes("--no-textconv"));
});

test("aborting from a progress update prevents Git execution", async () => {
	const operations = new RecordingGitOperations([]);
	const controller = new AbortController();

	await assert.rejects(
		createGitStatusTool(operations).execute("call", {}, controller.signal, () => {
			controller.abort();
		}),
		{ name: "AbortError" },
	);
	assert.equal(operations.calls.length, 0);
});

test("node Git operations inspect a real repository and bound large diffs", async () => {
	const root = await mkdtemp(join(tmpdir(), "learning-agent-git-"));
	const outsideRoot = await mkdtemp(join(tmpdir(), "learning-agent-git-outside-"));
	try {
		await execFileAsync("git", ["init"], { cwd: root });
		await mkdir(join(root, ".data"));
		await mkdir(join(root, "nested"));
		await mkdir(join(root, "node_modules"));
		await writeFile(join(root, "file.txt"), "initial\n", "utf8");
		await writeFile(join(root, ".ENV"), "initial secret\n", "utf8");
		await writeFile(join(root, ".data", "session.json"), "initial private\n", "utf8");
		await writeFile(join(root, "nested", "SECRET.PEM"), "initial key\n", "utf8");
		await writeFile(join(root, "node_modules", "dependency.js"), "initial dependency\n", "utf8");
		await execFileAsync(
			"git",
			[
				"add",
				"file.txt",
				".ENV",
				".data/session.json",
				"nested/SECRET.PEM",
				"node_modules/dependency.js",
			],
			{ cwd: root },
		);
		await execFileAsync(
			"git",
			["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"],
			{ cwd: root },
		);
		await execFileAsync("git", ["config", "core.worktree", outsideRoot], { cwd: root });
		await writeFile(join(root, "file.txt"), `${"changed line\n".repeat(8_000)}`, "utf8");
		await writeFile(join(root, ".ENV"), "changed secret\n", "utf8");
		await writeFile(join(root, ".data", "session.json"), "changed private\n", "utf8");
		await writeFile(join(root, "nested", "SECRET.PEM"), "changed key\n", "utf8");
		await writeFile(join(root, "node_modules", "dependency.js"), "changed dependency\n", "utf8");
		const operations = createNodeGitOperations(root);

		const status = await createGitStatusTool(operations).execute(
			"status",
			{},
			new AbortController().signal,
		);
		assert.match(status.content[0]?.type === "text" ? status.content[0].text : "", /unstaged: 1/);

		const diff = await createGitDiffTool(operations).execute(
			"diff",
			{ path: "." },
			new AbortController().signal,
		);
		assert.ok(diff.details && "diff" in diff.details);
		if (!diff.details || !("diff" in diff.details)) throw new Error("Expected diff details");
		assert.equal(diff.details.truncated, true);
		assert.ok(Buffer.byteLength(diff.details.diff, "utf8") <= 64 * 1024 + 3);
		const diffText = diff.content[0]?.type === "text" ? diff.content[0].text : "";
		assert.ok(Buffer.byteLength(diffText, "utf8") <= 64 * 1024);
		assert.doesNotMatch(diffText, /changed (secret|private|key|dependency)/);

		await mkdir(join(root, "child"));
		const nestedOperations = createNodeGitOperations(join(root, "child"));
		await assert.rejects(
			createGitStatusTool(nestedOperations).execute(
				"nested-status",
				{},
				new AbortController().signal,
			),
			/local \.git directory/,
		);

		await writeFile(join(root, ".git", "objects", "info", "alternates"), outsideRoot, "utf8");
		const alternateOperations = createNodeGitOperations(root);
		await assert.rejects(
			createGitLogTool(alternateOperations).execute(
				"alternate-log",
				{},
				new AbortController().signal,
			),
			/External Git metadata redirects/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outsideRoot, { recursive: true, force: true });
	}
});
