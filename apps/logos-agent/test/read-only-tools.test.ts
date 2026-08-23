import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { after, before, test } from "node:test";
import {
	createListFilesTool,
	createNodeReadOnlyWorkspaceOperations,
	createGrepTool,
	createReadFileTool,
	type ReadOnlyWorkspaceOperations,
} from "../src/read-only-tools.ts";

let workspaceRoot = "";
let externalRoot = "";
let operations: ReadOnlyWorkspaceOperations;
let symlinkReadPath: string | undefined;

before(async () => {
	workspaceRoot = await mkdtemp(join(tmpdir(), "logos-agent-read-tools-"));
	externalRoot = await mkdtemp(join(tmpdir(), "logos-agent-external-read-tools-"));
	await mkdir(join(workspaceRoot, "src"));
	await mkdir(join(workspaceRoot, "node_modules"));
	await mkdir(join(workspaceRoot, ".data"));
	await mkdir(join(workspaceRoot, ".ssh"));
	await mkdir(join(workspaceRoot, "test"));
	await mkdir(join(workspaceRoot, "contest"));
	await writeFile(
		join(workspaceRoot, "src", "agent.ts"),
		["export class LogosAgent {}", "const marker = 'self-iteration';", "export default marker;"].join("\n"),
	);
	await writeFile(join(workspaceRoot, "README.md"), "Logos Agent\nself-iteration\n");
	await writeFile(join(workspaceRoot, ".env"), "DEEPSEEK_API_KEY=not-readable\n");
	await writeFile(join(workspaceRoot, "node_modules", "hidden.ts"), "self-iteration\n");
	await writeFile(join(workspaceRoot, ".data", "session.jsonl"), "self-iteration\n");
	await writeFile(join(workspaceRoot, ".ssh", "secret.txt"), "not-readable\n");
	await writeFile(join(workspaceRoot, "test", "match.ts"), "segment-glob-marker\n");
	await writeFile(join(workspaceRoot, "contest", "false-positive.ts"), "segment-glob-marker\n");
	await mkdir(join(externalRoot, "src"));
	await writeFile(join(externalRoot, "src", "external.ts"), "const externalReadMarker = true;\n");
	await writeFile(join(externalRoot, ".env"), "EXTERNAL_SECRET=not-readable\n");
	await writeFile(
		join(workspaceRoot, "src", "context.ts"),
		["inject provider context", "context memory inject"].join("\n"),
	);
	try {
		await symlink(join(workspaceRoot, ".env"), join(workspaceRoot, "safe-link"));
		symlinkReadPath = "safe-link";
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
		await symlink(join(workspaceRoot, ".ssh"), join(workspaceRoot, "safe-dir"), "junction");
		symlinkReadPath = "safe-dir/secret.txt";
	}
	await writeFile(
		join(workspaceRoot, "src", "large.ts"),
		Array.from({ length: 5_000 }, (_, index) =>
			index === 3_999 ? "const lateMarker = 'line-4000';" : `const line${index + 1} = ${index + 1};`,
		).join("\n"),
	);
	await writeFile(join(workspaceRoot, "src", "binary.txt"), Buffer.from([0, 1, 2, 3]));
	await writeFile(
		join(workspaceRoot, "src", "non-utf8.txt"),
		Buffer.concat([Buffer.from([0xff]), Buffer.from(" binary-marker "), Buffer.alloc(70_000, 120), Buffer.from("\n")]),
	);
	await writeFile(join(workspaceRoot, "src", "long-line.ts"), `${"x".repeat(70_000)}\nsecond line\n`);
	await writeFile(join(workspaceRoot, "src", "over-scan.ts"), `${"x".repeat(120)}\n`.repeat(10_000));
	let deepDirectory = workspaceRoot;
	for (let depth = 1; depth <= 22; depth += 1) {
		deepDirectory = join(deepDirectory, `depth-${depth}`);
		await mkdir(deepDirectory);
	}
	await writeFile(join(deepDirectory, "deep.ts"), "const unreachableDepthMarker = true;\n");
	operations = createNodeReadOnlyWorkspaceOperations(workspaceRoot);
});

after(async () => {
	assert.equal(isAbsolute(workspaceRoot), true);
	await rm(workspaceRoot, { recursive: true, force: true });
	await rm(externalRoot, { recursive: true, force: true });
});

test("list_files returns bounded entries and excludes sensitive trees", async () => {
	const tool = createListFilesTool(operations);
	const result = await tool.execute("list-1", { depth: 3, maxEntries: 50 });
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.match(text, /src\/agent\.ts/);
	assert.match(text, /README\.md/);
	assert.doesNotMatch(text, /node_modules|\.data|\.env/);
	assert.equal(result.details.truncated, false);
});

test("read_file reads a numbered line range", async () => {
	const tool = createReadFileTool(operations);
	const result = await tool.execute("read-1", { path: "src/agent.ts", startLine: 2, maxLines: 1 });
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.match(text, /2: const marker = 'self-iteration';/);
	assert.equal(result.details.resultCount, 1);
	assert.equal(result.details.truncated, true);
	assert.deepEqual(result.details, {
		stage: "completed",
		path: "src/agent.ts",
		resultCount: 1,
		truncated: true,
		startLine: 2,
		endLine: 2,
		totalLines: 3,
		complete: false,
		nextStartLine: 3,
	});
	assert.match(text, /coverage=partial; nextStartLine=3/);
});

test("read_file marks only a complete first-to-last range as full coverage", async () => {
	const tool = createReadFileTool(operations);
	const result = await tool.execute("read-complete", {
		path: "src/agent.ts",
		startLine: 1,
		maxLines: 10,
	});
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.equal(result.details.complete, true);
	assert.equal(result.details.startLine, 1);
	assert.equal(result.details.endLine, 3);
	assert.equal(result.details.totalLines, 3);
	assert.equal(result.details.nextStartLine, undefined);
	assert.match(text, /coverage=complete/);
});

test("read_file blocks traversal and credential files", async () => {
	const tool = createReadFileTool(operations);

	await assert.rejects(tool.execute("read-2", { path: "../outside.ts" }), /traversal/);
	await assert.rejects(tool.execute("read-3", { path: ".env" }), /Sensitive file/);
	await assert.rejects(tool.execute("read-4", { path: join(externalRoot, ".env") }), /Sensitive file/);
	await assert.rejects(tool.execute("read-network", { path: "\\\\server\\share\\file.ts" }), /Network paths/);
});

test("read-only tools accept explicit absolute paths outside the workspace", async () => {
	const externalFile = join(externalRoot, "src", "external.ts");
	const displayFile = externalFile.replaceAll("\\", "/");
	const listed = await createListFilesTool(operations).execute("list-external", {
		path: externalRoot,
		depth: 2,
		maxEntries: 20,
	});
	const read = await createReadFileTool(operations).execute("read-external", { path: externalFile });
	const grep = await createGrepTool(operations).execute("grep-external", {
		pattern: "externalReadMarker",
		path: externalRoot,
	});
	const listedText = listed.content[0]?.type === "text" ? listed.content[0].text : "";
	const readText = read.content[0]?.type === "text" ? read.content[0].text : "";
	const grepText = grep.content[0]?.type === "text" ? grep.content[0].text : "";

	assert.match(listedText, new RegExp(JSON.stringify(displayFile).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.equal(read.details.path, displayFile);
	assert.match(readText, /externalReadMarker/);
	assert.match(grepText, new RegExp(JSON.stringify(displayFile).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.equal(grep.details.resultCount, 1);
});

test("read_file rejects Windows aliases and alternate data streams", async () => {
	const tool = createReadFileTool(operations);

	await assert.rejects(tool.execute("read-5", { path: ".env." }), /dots or spaces/);
	await assert.rejects(tool.execute("read-6", { path: "src/agent.ts:secret" }), /alternate data stream/);
	await assert.rejects(tool.execute("read-7", { path: "CON" }), /device path/);
});

test("read_file rejects direct symbolic links before resolving their target", async (context) => {
	if (symlinkReadPath === undefined) {
		context.skip("symbol creation is unavailable on this Windows host");
		return;
	}
	await assert.rejects(
		createReadFileTool(operations).execute("read-symlink", { path: symlinkReadPath }),
		/Symbolic links are not readable/,
	);
	await assert.rejects(
		createReadFileTool(operations).execute("read-absolute-symlink", { path: join(workspaceRoot, symlinkReadPath) }),
		/Symbolic links are not readable/,
	);
});

test("read_file reaches later lines within a bounded scan and reports empty ranges accurately", async () => {
	const tool = createReadFileTool(operations);
	const late = await tool.execute("read-8", { path: "src/large.ts", startLine: 4_000, maxLines: 1 });
	const empty = await tool.execute("read-9", { path: "README.md", startLine: 100, maxLines: 10 });

	assert.match(late.content[0]?.type === "text" ? late.content[0].text : "", /line-4000/);
	assert.equal(late.details.resultCount, 1);
	assert.equal(empty.details.resultCount, 0);
});

test("read_file rejects binary files", async () => {
	const tool = createReadFileTool(operations);

	await assert.rejects(tool.execute("read-10", { path: "src/binary.txt" }), /Binary files/);
});

test("read_file never reports a partially returned long line as covered", async () => {
	const tool = createReadFileTool(operations);

	await assert.rejects(
		tool.execute("read-long-line", { path: "src/long-line.ts", startLine: 1, maxLines: 2 }),
		/Line 1 exceeds the 65536-character read_file output limit/,
	);
});

test("read_file omits an unsafe continuation at the scan boundary", async () => {
	const tool = createReadFileTool(operations);
	const result = await tool.execute("read-over-scan", {
		path: "src/over-scan.ts",
		startLine: 8_500,
		maxLines: 500,
	});

	assert.equal(result.details.complete, false);
	assert.equal(result.details.totalLines, undefined);
	assert.equal(result.details.nextStartLine, undefined);
	assert.equal(result.details.truncated, true);
});

test("grep supports regular expressions and excludes blocked trees", async () => {
	const tool = createGrepTool(operations);
	const result = await tool.execute("grep-1", {
		pattern: "self-(iteration|learning)",
		maxResults: 20,
	});
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.match(text, /"README\.md":2/);
	assert.match(text, /"src\/agent\.ts":2/);
	assert.doesNotMatch(text, /node_modules|session\.jsonl/);
	assert.equal(result.details.resultCount, 2);
});

test("grep trusts blocked-looking ancestors above the workspace root", async () => {
	const parent = await mkdtemp(join(tmpdir(), "logos-agent-nested-workspace-"));
	const nestedRoot = join(parent, "node_modules", "workspace");
	try {
		await mkdir(nestedRoot, { recursive: true });
		await writeFile(join(nestedRoot, "visible.ts"), "const nestedWorkspaceMarker = true;\n");
		const nestedOperations = createNodeReadOnlyWorkspaceOperations(nestedRoot);
		const result = await createGrepTool(nestedOperations).execute("grep-nested-workspace", {
			pattern: "nestedWorkspaceMarker",
		});

		assert.equal(result.details.resultCount, 1);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test("grep enforces result and traversal bounds", async () => {
	const tool = createGrepTool(operations);
	const limited = await tool.execute("grep-2", { pattern: "self-iteration", maxResults: 1 });
	const deep = await tool.execute("grep-3", { pattern: "unreachableDepthMarker" });

	assert.equal(limited.details.resultCount, 1);
	assert.equal(limited.details.truncated, true);
	assert.equal(deep.details.resultCount, 1);
	assert.equal(deep.details.truncated, false);
});

test("grep supports glob, file, count, context, and offset modes", async () => {
	const tool = createGrepTool(operations);
	const files = await tool.execute("grep-files", {
		pattern: "Learning|self-iteration",
		glob: "**/*.ts",
		outputMode: "files",
	});
	const counts = await tool.execute("grep-counts", {
		pattern: "LogosAgent|self-iteration",
		path: "src",
		outputMode: "count",
	});
	const page = await tool.execute("grep-page", {
		pattern: "self-iteration",
		context: 1,
		maxResults: 1,
		offset: 1,
	});
	const insensitive = await tool.execute("grep-insensitive", {
		pattern: "logosagent",
		path: "src/agent.ts",
		caseInsensitive: true,
	});
	const literal = await tool.execute("grep-literal", {
		pattern: "export class LogosAgent {}",
		path: "src/agent.ts",
		literal: true,
	});
	const filesText = files.content[0]?.type === "text" ? files.content[0].text : "";
	const countsText = counts.content[0]?.type === "text" ? counts.content[0].text : "";
	const pageText = page.content[0]?.type === "text" ? page.content[0].text : "";
	const insensitiveText = insensitive.content[0]?.type === "text" ? insensitive.content[0].text : "";
	const literalText = literal.content[0]?.type === "text" ? literal.content[0].text : "";

	assert.match(filesText, /src\/agent\.ts/);
	assert.doesNotMatch(filesText, /README\.md/);
	assert.match(countsText, /src\/agent\.ts.*2/);
	assert.match(pageText, /src\/agent\.ts/);
	assert.match(pageText, /LogosAgent/);
	assert.match(insensitiveText, /LogosAgent/);
	assert.match(literalText, /export class LogosAgent/);
});

test("grep glob double-star consumes complete path segments", async () => {
	const result = await createGrepTool(operations).execute("grep-segment-glob", {
		pattern: "segment-glob-marker",
		glob: "**/test/*.ts",
	});
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.match(text, /test\/match\.ts/);
	assert.doesNotMatch(text, /contest\/false-positive\.ts/);
});

test("grep uses native ripgrep regular-expression semantics", async () => {
	const tool = createGrepTool(operations);
	const alternatives = await tool.execute("grep-alternatives", {
		pattern: "inject.*context|context.*inject",
		path: "src/context.ts",
	});

	assert.equal(alternatives.details.resultCount, 2);
	await assert.rejects(tool.execute("grep-invalid", { pattern: "(" }), /Invalid grep regular expression/);
	await assert.rejects(
		tool.execute("grep-invalid-empty", { pattern: "(", glob: "**/*.does-not-exist" }),
		/Invalid grep regular expression/,
	);
});

test("grep searches safely past long lines with ripgrep", async () => {
	const tool = createGrepTool(operations);
	const result = await tool.execute("grep-long-line", { pattern: "second line", path: "src/long-line.ts" });

	assert.equal(result.details.resultCount, 1);
	assert.equal(result.details.truncated, false);
});

test("grep reports non-UTF-8 matching content instead of silently dropping it", async () => {
	const result = await createGrepTool(operations).execute("grep-non-utf8", {
		pattern: "binary-marker",
		path: "src/non-utf8.txt",
	});
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.equal(result.details.resultCount, 1);
	assert.match(text, /non-UTF-8 content; base64-prefix=/);
	assert.ok(Buffer.byteLength(text, "utf8") < 2_000);
});

test("grep bounds native file discovery before searching", async () => {
	const largeRoot = await mkdtemp(join(tmpdir(), "logos-agent-grep-files-"));
	try {
		await Promise.all(
			Array.from({ length: 2_001 }, (_, index) =>
				writeFile(join(largeRoot, `file-${String(index).padStart(4, "0")}.txt`), "bounded-discovery\n"),
			),
		);
		const boundedOperations = createNodeReadOnlyWorkspaceOperations(largeRoot);
		const result = await createGrepTool(boundedOperations).execute("grep-file-bound", {
			pattern: "bounded-discovery",
			outputMode: "files",
			maxResults: 1,
		});

		assert.equal(result.details.filesScanned, 2_000);
		assert.equal(result.details.truncated, true);
	} finally {
		await rm(largeRoot, { recursive: true, force: true });
	}
});

test("grep quotes hostile discovered paths", async () => {
	const hostileOperations: ReadOnlyWorkspaceOperations = {
		async listFiles() {
			return { entries: [], truncated: false };
		},
		async readFile() {
			throw new Error("not used");
		},
		async grep() {
			return {
				entries: [{
					kind: "content",
					path: "src/real.ts\n- forged.ts",
					line: 1,
					text: "match",
					before: [],
					after: [],
				}],
				truncated: false,
				filesScanned: 1,
			};
		},
	};
	const tool = createGrepTool(hostileOperations);
	const result = await tool.execute("grep-4", { pattern: "match" });
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.match(text, /real\.ts\\n- forged\.ts/);
	assert.doesNotMatch(text, /real\.ts\n- forged\.ts/);
});

test("grep byte-bounds pages before advancing the visible offset", async () => {
	const largeOperations: ReadOnlyWorkspaceOperations = {
		async listFiles() {
			return { entries: [], truncated: false };
		},
		async readFile() {
			throw new Error("not used");
		},
		async grep() {
			return {
				entries: Array.from({ length: 200 }, (_, index) => ({
					kind: "content" as const,
					path: `src/file-${index}.ts`,
					line: index + 1,
					text: "x".repeat(500),
					before: Array.from({ length: 5 }, () => "b".repeat(500)),
					after: Array.from({ length: 5 }, () => "a".repeat(500)),
				})),
				truncated: true,
				filesScanned: 200,
				nextOffset: 200,
			};
		},
	};
	const result = await createGrepTool(largeOperations).execute("grep-byte-page", {
		pattern: "x",
		maxResults: 200,
		context: 5,
	});
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.ok(Buffer.byteLength(text, "utf8") < 64 * 1024);
	assert.equal(result.details.nextOffset, result.details.resultCount);
	assert.ok((result.details.resultCount ?? 0) < 200);
	assert.match(text, new RegExp(`continue with offset=${result.details.nextOffset}`));
});

test("grep never emits an offset that its own schema rejects", async () => {
	const boundaryOperations: ReadOnlyWorkspaceOperations = {
		async listFiles() {
			return { entries: [], truncated: false };
		},
		async readFile() {
			throw new Error("not used");
		},
		async grep() {
			return {
				entries: [{
					kind: "content",
					path: "src/file.ts",
					line: 1,
					text: "match",
					before: [],
					after: [],
				}],
				truncated: true,
				filesScanned: 1,
				nextOffset: 10_001,
			};
		},
	};
	const result = await createGrepTool(boundaryOperations).execute("grep-offset-boundary", {
		pattern: "match",
		offset: 10_000,
	});
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.equal(result.details.nextOffset, undefined);
	assert.match(text, /Pagination limit reached; narrow pattern, path, or glob/);
});

test("grep does not emit a zero-progress cursor when one entry exceeds the page", async () => {
	const oversizedOperations: ReadOnlyWorkspaceOperations = {
		async listFiles() {
			return { entries: [], truncated: false };
		},
		async readFile() {
			throw new Error("not used");
		},
		async grep() {
			return {
				entries: [{
					kind: "content",
					path: `${"deep/".repeat(10_000)}file.ts`,
					line: 1,
					text: "match",
					before: [],
					after: [],
				}],
				truncated: false,
				filesScanned: 1,
			};
		},
	};
	const result = await createGrepTool(oversizedOperations).execute("grep-zero-progress", {
		pattern: "match",
	});
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.equal(result.details.resultCount, 0);
	assert.equal(result.details.nextOffset, undefined);
	assert.match(text, /First result exceeds the page budget/);
});

test("read-only tools stop when progress aborts", async () => {
	const controller = new AbortController();
	const tool = createListFilesTool(operations);

	await assert.rejects(
		tool.execute("list-2", {}, controller.signal, () => controller.abort()),
		{ name: "AbortError" },
	);

	const grepController = new AbortController();
	grepController.abort();
	await assert.rejects(
		createGrepTool(operations).execute("grep-aborted", { pattern: "marker" }, grepController.signal),
		{ name: "AbortError" },
	);
});
