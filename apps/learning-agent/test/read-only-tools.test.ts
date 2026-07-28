import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { after, before, test } from "node:test";
import {
	createListFilesTool,
	createNodeReadOnlyWorkspaceOperations,
	createReadFileTool,
	createSearchTextTool,
	type ReadOnlyWorkspaceOperations,
} from "../src/read-only-tools.ts";

let workspaceRoot = "";
let operations: ReadOnlyWorkspaceOperations;

before(async () => {
	workspaceRoot = await mkdtemp(join(tmpdir(), "learning-agent-read-tools-"));
	await mkdir(join(workspaceRoot, "src"));
	await mkdir(join(workspaceRoot, "node_modules"));
	await mkdir(join(workspaceRoot, ".data"));
	await writeFile(
		join(workspaceRoot, "src", "agent.ts"),
		["export class LearningAgent {}", "const marker = 'self-iteration';", "export default marker;"].join("\n"),
	);
	await writeFile(join(workspaceRoot, "README.md"), "Learning Agent\nself-iteration\n");
	await writeFile(join(workspaceRoot, ".env"), "DEEPSEEK_API_KEY=not-readable\n");
	await writeFile(join(workspaceRoot, "node_modules", "hidden.ts"), "self-iteration\n");
	await writeFile(join(workspaceRoot, ".data", "session.jsonl"), "self-iteration\n");
	await writeFile(
		join(workspaceRoot, "src", "large.ts"),
		Array.from({ length: 5_000 }, (_, index) =>
			index === 3_999 ? "const lateMarker = 'line-4000';" : `const line${index + 1} = ${index + 1};`,
		).join("\n"),
	);
	await writeFile(join(workspaceRoot, "src", "binary.txt"), Buffer.from([0, 1, 2, 3]));
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
});

test("read_file blocks traversal, absolute paths, and credential files", async () => {
	const tool = createReadFileTool(operations);

	await assert.rejects(tool.execute("read-2", { path: "../outside.ts" }), /traversal/);
	await assert.rejects(tool.execute("read-3", { path: workspaceRoot }), /workspace-relative/);
	await assert.rejects(tool.execute("read-4", { path: ".env" }), /Sensitive file/);
});

test("read_file rejects Windows aliases and alternate data streams", async () => {
	const tool = createReadFileTool(operations);

	await assert.rejects(tool.execute("read-5", { path: ".env." }), /dots or spaces/);
	await assert.rejects(tool.execute("read-6", { path: "src/agent.ts:secret" }), /alternate data stream/);
	await assert.rejects(tool.execute("read-7", { path: "CON" }), /device path/);
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

test("search_text returns relative paths and excludes blocked trees", async () => {
	const tool = createSearchTextTool(operations);
	const result = await tool.execute("search-1", { query: "self-iteration", maxResults: 20 });
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.match(text, /"README\.md":2/);
	assert.match(text, /"src\/agent\.ts":2/);
	assert.doesNotMatch(text, /node_modules|session\.jsonl/);
	assert.equal(result.details.resultCount, 2);
});

test("search_text enforces result and traversal bounds", async () => {
	const tool = createSearchTextTool(operations);
	const limited = await tool.execute("search-2", { query: "self-iteration", maxResults: 1 });
	const deep = await tool.execute("search-3", { query: "unreachableDepthMarker" });

	assert.equal(limited.details.resultCount, 1);
	assert.equal(limited.details.truncated, true);
	assert.equal(deep.details.resultCount, 0);
	assert.equal(deep.details.truncated, true);
});

test("search_text quotes hostile discovered paths", async () => {
	const hostileOperations: ReadOnlyWorkspaceOperations = {
		async listFiles() {
			return { entries: [], truncated: false };
		},
		async readFile() {
			throw new Error("not used");
		},
		async searchText() {
			return {
				matches: [{ path: "src/real.ts\n- forged.ts", line: 1, text: "match" }],
				truncated: false,
				filesScanned: 1,
			};
		},
	};
	const tool = createSearchTextTool(hostileOperations);
	const result = await tool.execute("search-4", { query: "match" });
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.match(text, /real\.ts\\n- forged\.ts/);
	assert.doesNotMatch(text, /real\.ts\n- forged\.ts/);
});

test("read-only tools stop when progress aborts", async () => {
	const controller = new AbortController();
	const tool = createListFilesTool(operations);

	await assert.rejects(
		tool.execute("list-2", {}, controller.signal, () => controller.abort()),
		{ name: "AbortError" },
	);
});
