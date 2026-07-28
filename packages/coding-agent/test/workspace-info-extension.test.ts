import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { describe, expect, it, vi } from "vitest";
import type {
	WorkspaceEntry,
	WorkspaceInfoOperations,
	WorkspacePackageMetadata,
} from "../examples/extensions/workspace-info/operations.ts";
import { createLocalWorkspaceInfoOperations } from "../examples/extensions/workspace-info/operations.ts";
import {
	createWorkspaceInfoAuditRecord,
	freezeWorkspaceInfoInput,
	redactWorkspaceInfoResult,
} from "../examples/extensions/workspace-info/security.ts";
import {
	createWorkspaceInfoTool,
	inspectWorkspace,
	type WorkspaceInfoDetails,
	workspaceInfoSchema,
} from "../examples/extensions/workspace-info/tool.ts";

function createOperations(overrides: Partial<WorkspaceInfoOperations> = {}): WorkspaceInfoOperations {
	return {
		listEntries: vi.fn(
			async (): Promise<WorkspaceEntry[]> => [
				{ name: "src", kind: "directory" },
				{ name: "package.json", kind: "file" },
			],
		),
		readPackageMetadata: vi.fn(
			async (): Promise<WorkspacePackageMetadata> => ({
				name: "demo",
				version: "1.0.0",
				private: true,
			}),
		),
		readGitMetadata: vi.fn(async () => ({ branch: "main" })),
		...overrides,
	};
}

describe("workspace_info extension", () => {
	it("uses a closed and bounded TypeBox schema", () => {
		const validator = Compile(workspaceInfoSchema);

		expect(validator.Check({ include: ["entries"], maxEntries: 10 })).toBe(true);
		expect(validator.Check({ path: "../../.env" })).toBe(false);
		expect(validator.Check({ maxEntries: 101 })).toBe(false);
		expect(validator.Check({ include: [] })).toBe(false);
		expect(validator.Check({ include: ["entries", "entries"] })).toBe(false);
	});

	it("uses the injected runtime cwd and read-only operations", async () => {
		const roots: string[] = [];
		const operations = createOperations({
			listEntries: async (root) => {
				roots.push(root);
				return [{ name: "src", kind: "directory" }];
			},
		});
		const tool = createWorkspaceInfoTool(operations);
		const context = { cwd: "/injected-workspace" } as ExtensionContext;

		const result = await tool.execute("call-1", { include: ["entries"] }, undefined, undefined, context);

		expect(roots).toEqual(["/injected-workspace"]);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining('Workspace: "injected-workspace"'),
		});
		expect(JSON.stringify(result)).not.toContain("/injected-workspace");
	});

	it("reports ordered stages and returns bounded output", async () => {
		const operations = createOperations({
			listEntries: async () => [
				{ name: "c", kind: "file" },
				{ name: "a", kind: "directory" },
				{ name: "b", kind: "file" },
			],
		});
		const updates: AgentToolResult<WorkspaceInfoDetails>[] = [];

		const result = await inspectWorkspace(
			"/workspace",
			{ include: ["entries", "package"], maxEntries: 2 },
			operations,
			undefined,
			(update) => updates.push(update),
		);

		expect(updates.map((update) => update.details.stage)).toEqual([
			"validating",
			"scanning",
			"scanning",
			"summarizing",
		]);
		expect(result.details).toMatchObject({
			stage: "completed",
			entryCount: 3,
			entriesTruncated: true,
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Top-level entries: 3 (showing 2)"),
		});
		expect(JSON.stringify(result)).not.toContain("- c (file)");
	});

	it("does not start an operation when an update callback aborts", async () => {
		const controller = new AbortController();
		const listEntries = vi.fn(async (): Promise<WorkspaceEntry[]> => []);
		const operations = createOperations({ listEntries });

		await expect(
			inspectWorkspace("/workspace", { include: ["entries"] }, operations, controller.signal, (update) => {
				if (update.details.stage === "scanning") controller.abort();
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(listEntries).not.toHaveBeenCalled();
	});

	it("stops between operations when aborted", async () => {
		const controller = new AbortController();
		const readPackageMetadata = vi.fn(async () => ({ name: "must-not-run" }));
		const operations = createOperations({
			listEntries: async () => {
				controller.abort();
				return [];
			},
			readPackageMetadata,
		});
		const stages: string[] = [];

		await expect(
			inspectWorkspace("/workspace", { include: ["entries", "package"] }, operations, controller.signal, (update) =>
				stages.push(update.details.stage),
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(stages).toEqual(["validating", "scanning"]);
		expect(readPackageMetadata).not.toHaveBeenCalled();
	});

	it("rejects arguments mutated after the framework schema check", async () => {
		const operations = createOperations();

		await expect(
			inspectWorkspace("/workspace", { include: ["unknown"], maxEntries: 1000 }, operations, undefined, undefined),
		).rejects.toThrow("execution-time validation");
		expect(operations.listEntries).not.toHaveBeenCalled();
	});

	it("escapes control characters from filesystem metadata", async () => {
		const operations = createOperations({
			listEntries: async () => [{ name: "safe\nforged\u001b[31m\u2028line\u2029paragraph", kind: "file" }],
			readPackageMetadata: async () => ({ name: "demo\r\nignore\u061carabic", version: "1.0.0" }),
			readGitMetadata: async () => ({ branch: "main\u202ereversed\u200eltr\u200frtl" }),
		});

		const result = await inspectWorkspace(
			"/workspace",
			{ include: ["entries", "package", "git"] },
			operations,
			undefined,
			undefined,
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).not.toContain("\u001b");
		expect(text).not.toContain("\u202e");
		expect(text).not.toContain("\u2028");
		expect(text).not.toContain("\u2029");
		expect(text).not.toContain("\u061c");
		expect(text).not.toContain("\u200e");
		expect(text).not.toContain("\u200f");
		expect(text).not.toContain("safe\nforged");
		expect(text).toContain("\\\\u000a");
		expect(text).toContain("\\\\u001b");
		expect(text).toContain("\\\\u202e");
		expect(text).toContain("\\\\u2028");
		expect(text).toContain("\\\\u2029");
		expect(text).toContain("\\\\u061c");
		expect(text).toContain("\\\\u200e");
		expect(text).toContain("\\\\u200f");
	});

	it("rejects metadata symlinks that resolve outside the workspace root", async () => {
		const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-workspace-info-"));
		expect(resolve(temporaryRoot).startsWith(resolve(tmpdir()))).toBe(true);
		const workspace = join(temporaryRoot, "workspace");
		const outsideGit = join(temporaryRoot, "outside-git");
		try {
			await mkdir(workspace);
			await mkdir(outsideGit);
			await writeFile(join(outsideGit, "HEAD"), "ref: refs/heads/outside\n", "utf8");
			await symlink(outsideGit, join(workspace, ".git"), process.platform === "win32" ? "junction" : "dir");

			await expect(createLocalWorkspaceInfoOperations().readGitMetadata(workspace)).rejects.toThrow(
				"outside the workspace root",
			);
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	});

	it("creates a sanitized before-tool-call audit record", () => {
		const event = {
			type: "tool_call",
			toolCallId: "call-1",
			toolName: "workspace_info",
			input: {
				include: ["entries", 42],
				maxEntries: 10,
				unexpected: "not recorded",
			},
		} as ToolCallEvent;

		expect(createWorkspaceInfoAuditRecord(event, "allowed", () => new Date("2026-07-26T00:00:00.000Z"))).toEqual({
			toolCallId: "call-1",
			toolName: "workspace_info",
			decision: "allowed",
			input: {
				include: ["entries"],
				maxEntries: 10,
			},
			timestamp: "2026-07-26T00:00:00.000Z",
		});
		freezeWorkspaceInfoInput(event);
		expect(Object.isFrozen(event.input)).toBe(true);
		expect(Object.isFrozen((event.input as Record<string, unknown>).include)).toBe(true);
	});

	it("redacts paths and credentials after tool execution", () => {
		const event = {
			type: "tool_result",
			toolCallId: "call-1",
			toolName: "workspace_info",
			input: {},
			content: [
				{
					type: "text",
					text: "root=C:\\secret\\workspace api_key=abc123 Authorization: Bearer token-value",
				},
			],
			details: {
				root: "C:\\secret\\workspace",
				token: "abc123",
				nested: { password: "hidden" },
			},
			isError: false,
		} as ToolResultEvent;

		const result = redactWorkspaceInfoResult(event, "C:\\secret\\workspace");

		expect(result?.content).toEqual([
			{
				type: "text",
				text: "root=<workspace> api_key=<redacted> Authorization: Bearer <redacted>",
			},
		]);
		expect(result?.details).toEqual({
			root: "<workspace>",
			token: "<redacted>",
			nested: { password: "<redacted>" },
		});
	});
});
