import assert from "node:assert/strict";
import test from "node:test";
import {
	createWorkspaceInfoTool,
	type WorkspaceInfoInput,
	type WorkspaceInfoOperations,
} from "../src/workspace-info.ts";
import { redactToolResult } from "../src/tool-security.ts";
import { summarizeCreateInput, summarizePatchInput } from "../src/logos-tools.ts";

const operations: WorkspaceInfoOperations = {
	async listEntries() {
		return [{ name: "src", kind: "directory" }];
	},
	async readPackageMetadata() {
		return { name: "logos-agent", private: true };
	},
	async readGitMetadata() {
		return { branch: "main" };
	},
};

test("workspace_info returns injected metadata and reports progress", async () => {
	const tool = createWorkspaceInfoTool("C:\\workspace", operations);
	const stages: string[] = [];
	const result = await tool.execute("call-1", {}, undefined, (update) => {
		stages.push(update.details.stage);
	});

	assert.deepEqual(stages, ["validating", "scanning", "scanning", "scanning", "summarizing"]);
	assert.equal(result.details.stage, "completed");
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /logos-agent/);
});

test("workspace_info stops before operations when already aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	const tool = createWorkspaceInfoTool("C:\\workspace", operations);

	await assert.rejects(tool.execute("call-2", {}, controller.signal), { name: "AbortError" });
});

test("workspace_info stops when a progress callback aborts", async () => {
	const controller = new AbortController();
	let operationCalls = 0;
	const abortOperations: WorkspaceInfoOperations = {
		async listEntries() {
			operationCalls += 1;
			return [];
		},
		async readPackageMetadata() {
			operationCalls += 1;
			return undefined;
		},
		async readGitMetadata() {
			operationCalls += 1;
			return undefined;
		},
	};
	const tool = createWorkspaceInfoTool("C:\\workspace", abortOperations);

	await assert.rejects(
		tool.execute("call-2b", {}, controller.signal, () => controller.abort()),
		{ name: "AbortError" },
	);
	assert.equal(operationCalls, 0);
});

test("workspace_info rejects path-like arguments", async () => {
	const tool = createWorkspaceInfoTool("C:\\workspace", operations);

	const malformedInput = { path: "C:\\outside" } as unknown as WorkspaceInfoInput;
	await assert.rejects(tool.execute("call-3", malformedInput), /execution-time validation/);
});

test("redaction removes workspace paths and secret values", () => {
	const result = redactToolResult(
		[{ type: "text", text: "C:\\workspace token=abc" }],
		{ password: "secret", path: "C:\\workspace\\src" },
		"C:\\workspace",
	);

	assert.deepEqual(result.content, [{ type: "text", text: "<workspace> token=<redacted>" }]);
	assert.deepEqual(result.details, { password: "<redacted>", path: "<workspace>\\src" });
});

test("redaction removes standalone provider and Git hosting keys from Git output", () => {
	const result = redactToolResult(
		[
			{
				type: "text",
				text: "removed sk-abcdefghijklmnopqrstuvwxyz123456 and ghp_abcdefghijklmnopqrstuvwxyz123456",
			},
		],
		{},
		"C:\\workspace",
	);

	assert.deepEqual(result.content, [
		{ type: "text", text: "removed <redacted-key> and <redacted-key>" },
	]);
});

test("redaction keeps final model-facing text within the shared UTF-8 limit", () => {
	const result = redactToolResult(
		[{ type: "text", text: "x😀".repeat(20_000) }],
		{},
		"x",
	);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	assert.ok(Buffer.byteLength(text, "utf8") <= 64 * 1024);
	assert.match(text, /\[tool result truncated after redaction\]$/);
	assert.doesNotMatch(text, /�/);
});

test("propose_patch audit records hashes instead of source text", () => {
	const input = summarizePatchInput({
		path: "apps/logos-agent/src/app.ts",
		oldText: "private old source",
		newText: "private new source",
		description: "change",
	});

	assert.equal(input.path, "apps/logos-agent/src/app.ts");
	assert.equal(input.oldTextBytes, 18);
	assert.equal(input.newTextBytes, 18);
	assert.equal("oldText" in input, false);
	assert.equal("newText" in input, false);
});

test("propose_create_file audit records a hash instead of file content", () => {
	const input = summarizeCreateInput({
		path: "apps/logos-agent/src/new.ts",
		content: "private new file content",
		description: "new module",
	});

	assert.equal(input.path, "apps/logos-agent/src/new.ts");
	assert.equal(input.contentBytes, 24);
	assert.equal(typeof input.contentHash, "string");
	assert.equal("content" in input, false);
});
