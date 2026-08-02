import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, open, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import {
	normalizeWorkspaceMutationPath,
	rejectLinkedDirectorySegments,
} from "./workspace-mutation-paths.ts";

export type EditKind = "replace" | "create" | "delete";
export type ControlledEditToolName =
	| "propose_patch"
	| "propose_create_file"
	| "propose_delete_file"
	| "apply_edit";

export interface EditProposalSummary {
	id: string;
	kind: EditKind;
	path: string;
	description?: string;
	diff: string;
	expectedHash?: string;
	changedRange?: { startLine: number; endLine: number };
	expiresAt: string;
}

export interface AppliedEdit {
	proposalId: string;
	kind: EditKind;
	path: string;
	previousHash?: string;
	newHash?: string;
}

export interface ExistingEditableFileSnapshot {
	state: "existing";
	path: string;
	resolvedPath: string;
	content: string;
	hash: string;
	mode: number;
}

export interface AbsentEditableFileSnapshot {
	state: "absent";
	path: string;
	resolvedPath: string;
	resolvedParent: string;
}

export type EditableFileSnapshot = ExistingEditableFileSnapshot | AbsentEditableFileSnapshot;

export type PreparedEdit =
	| { kind: "replace"; snapshot: ExistingEditableFileSnapshot; newContent: string }
	| { kind: "create"; snapshot: AbsentEditableFileSnapshot; newContent: string }
	| { kind: "delete"; snapshot: ExistingEditableFileSnapshot };

export type EditIntent =
	| {
			kind: "replace";
			path: string;
			oldText: string;
			newText: string;
			description?: string;
	  }
	| { kind: "create"; path: string; content: string; description?: string }
	| { kind: "delete"; path: string; description?: string };

export interface ControlledEditOperations {
	inspectEditablePath(path: string, signal?: AbortSignal): Promise<EditableFileSnapshot>;
	/**
	 * Coordinates Logos Agent writers with an adjacent lock and rechecks the
	 * expected existing/absent state immediately before committing the mutation.
	 */
	commitIfUnchanged(
		edit: PreparedEdit,
		signal?: AbortSignal,
	): Promise<{ previousHash?: string; newHash?: string }>;
}

export interface ControlledEditManager {
	prepare(intent: EditIntent, signal?: AbortSignal): Promise<EditProposalSummary>;
	getProposal(id: string): EditProposalSummary;
	approve(id: string): void;
	apply(id: string, signal?: AbortSignal): Promise<AppliedEdit>;
}

export interface ControlledEditToolDetails {
	stage: "validating" | "preparing" | "prepared" | "applying" | "completed";
	path?: string;
	proposalId?: string;
	previousHash?: string;
	newHash?: string;
}

const proposePatchSchema = Type.Object(
	{
		path: Type.String({
			description: "Existing UTF-8 text file relative to the workspace root",
			minLength: 1,
			maxLength: 500,
		}),
		oldText: Type.String({
			description: "Exact non-empty text currently present exactly once in the target file",
			minLength: 1,
			maxLength: 32 * 1024,
		}),
		newText: Type.String({
			description: "Replacement text. Use an empty string to delete oldText",
			maxLength: 32 * 1024,
		}),
		description: Type.Optional(
			Type.String({ description: "Short reason for the edit", minLength: 1, maxLength: 500 }),
		),
	},
	{ additionalProperties: false },
);

const proposeCreateFileSchema = Type.Object(
	{
		path: Type.String({
			description:
				"New UTF-8 text file relative to the workspace root; its parent directory must already exist",
			minLength: 1,
			maxLength: 500,
		}),
		content: Type.String({
			description: "Complete UTF-8 text content for the new file",
			maxLength: 64 * 1024,
		}),
		description: Type.Optional(
			Type.String({ description: "Short reason for creating the file", minLength: 1, maxLength: 500 }),
		),
	},
	{ additionalProperties: false },
);

const proposeDeleteFileSchema = Type.Object(
	{
		path: Type.String({
			description: "Existing UTF-8 text file relative to the workspace root",
			minLength: 1,
			maxLength: 500,
		}),
		description: Type.Optional(
			Type.String({ description: "Short reason for deleting the file", minLength: 1, maxLength: 500 }),
		),
	},
	{ additionalProperties: false },
);

const applyEditSchema = Type.Object(
	{
		proposalId: Type.String({
			description: "Identifier returned by a controlled edit proposal tool",
			minLength: 1,
			maxLength: 100,
		}),
	},
	{ additionalProperties: false },
);

type ProposePatchInput = Static<typeof proposePatchSchema>;
type ProposeCreateFileInput = Static<typeof proposeCreateFileSchema>;
type ProposeDeleteFileInput = Static<typeof proposeDeleteFileSchema>;
type ApplyEditInput = Static<typeof applyEditSchema>;

interface StoredProposal {
	summary: EditProposalSummary;
	edit: PreparedEdit;
	status: "pending" | "approved" | "applying" | "applied";
}

const proposePatchValidator = Compile(proposePatchSchema);
const proposeCreateFileValidator = Compile(proposeCreateFileSchema);
const proposeDeleteFileValidator = Compile(proposeDeleteFileSchema);
const applyEditValidator = Compile(applyEditSchema);
const maxEditableFileBytes = 512 * 1024;
const maxReplacementBytes = 64 * 1024;
const maxStoredProposals = 20;
const proposalTtlMs = 15 * 60 * 1000;

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	throw error;
}

function hashText(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function isWithinRoot(root: string, target: string): boolean {
	const pathFromRoot = relative(root, target);
	return (
		pathFromRoot === "" ||
		(pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
	);
}

function normalizeEditablePath(path: string): string {
	return normalizeWorkspaceMutationPath(path);
}

async function readTextFile(path: string, signal?: AbortSignal): Promise<{ content: string; mode: number }> {
	throwIfAborted(signal);
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		throwIfAborted(signal);
		const stats = await handle.stat();
		throwIfAborted(signal);
		if (!stats.isFile()) throw new Error("Editable path is not a file");
		if (stats.size > maxEditableFileBytes) {
			throw new Error(`Editable file exceeds ${maxEditableFileBytes} bytes`);
		}
		const buffer = Buffer.alloc(stats.size);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		throwIfAborted(signal);
		const content = buffer.subarray(0, bytesRead);
		if (content.includes(0)) throw new Error("Binary files are not editable");
		return { content: content.toString("utf8"), mode: stats.mode };
	} finally {
		await handle.close();
	}
}

export function createNodeControlledEditOperations(workspaceRoot: string): ControlledEditOperations {
	return {
		async inspectEditablePath(path, signal) {
			throwIfAborted(signal);
			const normalized = normalizeEditablePath(path);
			const lexicalWorkspace = resolve(workspaceRoot);
			const lexicalTarget = resolve(lexicalWorkspace, normalized);
			if (!isWithinRoot(lexicalWorkspace, lexicalTarget)) {
				throw new Error("Editable path escapes the workspace root");
			}
			const resolvedWorkspace = await realpath(lexicalWorkspace);
			throwIfAborted(signal);
			await rejectLinkedDirectorySegments(
				lexicalWorkspace,
				dirname(lexicalTarget),
				signal,
			);
			const resolvedParent = await realpath(dirname(lexicalTarget));
			throwIfAborted(signal);
			if (!isWithinRoot(resolvedWorkspace, resolvedParent)) {
				throw new Error("Resolved editable parent escapes the workspace root");
			}
			let targetStats;
			try {
				targetStats = await lstat(lexicalTarget);
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") {
					return {
						state: "absent",
						path: normalized,
						resolvedPath: join(resolvedParent, basename(lexicalTarget)),
						resolvedParent,
					};
				}
				throw error;
			}
			throwIfAborted(signal);
			if (targetStats.isSymbolicLink()) throw new Error("Symbolic links are not writable");
			const resolvedTarget = await realpath(lexicalTarget);
			throwIfAborted(signal);
			if (!isWithinRoot(resolvedWorkspace, resolvedTarget)) {
				throw new Error("Resolved editable path escapes the workspace root");
			}
			const file = await readTextFile(resolvedTarget, signal);
			return {
				state: "existing",
				path: normalized,
				resolvedPath: resolvedTarget,
				content: file.content,
				hash: hashText(file.content),
				mode: file.mode,
			};
		},

		async commitIfUnchanged(edit, signal) {
			throwIfAborted(signal);
			const snapshot = edit.snapshot;
			const lockId = createHash("sha256").update(snapshot.resolvedPath).digest("hex").slice(0, 16);
			const lockPath = join(dirname(snapshot.resolvedPath), `.logos-agent-edit-${lockId}.lock`);
			let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
			try {
				lockHandle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
				await lockHandle.writeFile(
					JSON.stringify({
						pid: process.pid,
						kind: edit.kind,
						proposalHash: snapshot.state === "existing" ? snapshot.hash : undefined,
						createdAt: new Date().toISOString(),
					}),
					"utf8",
				);
				await lockHandle.sync();
			} catch (error) {
				try {
					await lockHandle?.close();
				} finally {
					if (lockHandle) await rm(lockPath, { force: true });
				}
				if (error instanceof Error && "code" in error && error.code === "EEXIST") {
					throw new Error("Another Logos Agent edit holds the target lock");
				}
				throw error;
			}

			try {
				const current = await this.inspectEditablePath(snapshot.path, signal);
				if (edit.kind === "create") {
					const createSnapshot = edit.snapshot;
					if (
						current.state !== "absent" ||
						current.resolvedPath !== createSnapshot.resolvedPath
					) {
						throw new Error("Create proposal is stale because the target path now exists or moved");
					}
					if (Buffer.byteLength(edit.newContent, "utf8") > maxEditableFileBytes) {
						throw new Error(`Created file exceeds ${maxEditableFileBytes} bytes`);
					}
					const temporaryPath = join(
						createSnapshot.resolvedParent,
						`.logos-agent-edit-${randomUUID()}.tmp`,
					);
					let temporaryCreated = false;
					try {
						const handle = await open(
							temporaryPath,
							constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
						);
						temporaryCreated = true;
						try {
							await handle.writeFile(edit.newContent, "utf8");
							await handle.sync();
						} finally {
							await handle.close();
						}
						const rechecked = await this.inspectEditablePath(createSnapshot.path, signal);
						if (
							rechecked.state !== "absent" ||
							rechecked.resolvedPath !== createSnapshot.resolvedPath
						) {
							throw new Error("Create proposal became stale before commit");
						}
						throwIfAborted(signal);
						try {
							await link(temporaryPath, createSnapshot.resolvedPath);
						} catch (error) {
							if (error instanceof Error && "code" in error && error.code === "EEXIST") {
								throw new Error("Create proposal became stale before commit");
							}
							throw error;
						}
						return { newHash: hashText(edit.newContent) };
					} finally {
						if (temporaryCreated) await rm(temporaryPath, { force: true });
					}
				}
				const existingSnapshot = edit.snapshot;
				if (
					current.state !== "existing" ||
					current.resolvedPath !== existingSnapshot.resolvedPath
				) {
					throw new Error("Edit proposal is stale because the target file changed");
				}
				if (edit.kind === "delete") {
					const quarantinePath = join(
						dirname(current.resolvedPath),
						`.logos-agent-edit-${randomUUID()}.delete`,
					);
					let quarantined = false;
					try {
						throwIfAborted(signal);
						await rename(current.resolvedPath, quarantinePath);
						quarantined = true;
						const captured = await readTextFile(quarantinePath, signal);
						if (hashText(captured.content) !== existingSnapshot.hash) {
							throw new Error("Delete proposal is stale because the target file changed");
						}
						throwIfAborted(signal);
						await unlink(quarantinePath);
						quarantined = false;
						return { previousHash: existingSnapshot.hash };
					} catch (error) {
						if (quarantined) {
							try {
								await link(quarantinePath, current.resolvedPath);
								await unlink(quarantinePath);
								quarantined = false;
							} catch {
								// Preserve the quarantined file rather than overwrite a concurrently
								// recreated target. The error below tells the user where to recover it.
							}
						}
						if (quarantined) {
							throw new Error(
								`Delete was not committed; the captured file is preserved as ${JSON.stringify(basename(quarantinePath))}`,
								{ cause: error },
							);
						}
						throw error;
					}
				}
				if (current.hash !== existingSnapshot.hash) {
					throw new Error("Edit proposal is stale because the target file changed");
				}
				if (Buffer.byteLength(edit.newContent, "utf8") > maxEditableFileBytes) {
					throw new Error(`Edited file exceeds ${maxEditableFileBytes} bytes`);
				}
				const temporaryPath = join(
					dirname(current.resolvedPath),
					`.logos-agent-edit-${randomUUID()}.tmp`,
				);
				let temporaryCreated = false;
				try {
					const handle = await open(
						temporaryPath,
						constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
					);
					temporaryCreated = true;
					try {
						await handle.writeFile(edit.newContent, "utf8");
						await handle.sync();
					} finally {
						await handle.close();
					}
					await chmod(temporaryPath, current.mode);
					throwIfAborted(signal);
					const rechecked = await this.inspectEditablePath(existingSnapshot.path, signal);
					if (
						rechecked.state !== "existing" ||
						rechecked.resolvedPath !== existingSnapshot.resolvedPath ||
						rechecked.hash !== existingSnapshot.hash
					) {
						throw new Error("Edit proposal became stale before commit");
					}
					throwIfAborted(signal);
					await rename(temporaryPath, current.resolvedPath);
					temporaryCreated = false;
					return {
						previousHash: existingSnapshot.hash,
						newHash: hashText(edit.newContent),
					};
				} finally {
					if (temporaryCreated) await rm(temporaryPath, { force: true });
				}
			} finally {
				try {
					await lockHandle.close();
				} finally {
					await rm(lockPath, { force: true });
				}
			}
		},
	};
}

function countOccurrences(content: string, search: string): number {
	let count = 0;
	let offset = 0;
	while (offset <= content.length - search.length) {
		const index = content.indexOf(search, offset);
		if (index === -1) break;
		count += 1;
		offset = index + search.length;
	}
	return count;
}

function diffLineCount(text: string): number {
	if (text.length === 0) return 0;
	const count = text.split("\n").length;
	return text.endsWith("\n") ? count - 1 : count;
}

function diffLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	return lines;
}

function createDiff(path: string, content: string, oldText: string, newText: string): string {
	const index = content.indexOf(oldText);
	const segmentStart = index === 0 ? 0 : content.lastIndexOf("\n", index - 1) + 1;
	const nextLineBreak = content.indexOf("\n", index + oldText.length);
	const segmentEnd = nextLineBreak === -1 ? content.length : nextLineBreak + 1;
	const oldSegment = content.slice(segmentStart, segmentEnd);
	const replacementOffset = index - segmentStart;
	const newSegment =
		oldSegment.slice(0, replacementOffset) +
		newText +
		oldSegment.slice(replacementOffset + oldText.length);
	const startLine = content.slice(0, segmentStart).split("\n").length;
	const oldCount = diffLineCount(oldSegment);
	const newCount = diffLineCount(newSegment);
	return [
		`--- a/${path}`,
		`+++ b/${path}`,
		`@@ -${startLine},${oldCount} +${startLine},${newCount} @@`,
		...diffLines(oldSegment).map((line) => `-${line}`),
		...diffLines(newSegment).map((line) => `+${line}`),
	].join("\n");
}

function createWholeFileDiff(kind: "create" | "delete", path: string, content: string): string {
	const lines = diffLines(content);
	if (kind === "create") {
		return [
			"--- /dev/null",
			`+++ b/${path}`,
			`@@ -0,0 +1,${lines.length} @@`,
			...lines.map((line) => `+${line}`),
		].join("\n");
	}
	return [
		`--- a/${path}`,
		"+++ /dev/null",
		`@@ -1,${lines.length} +0,0 @@`,
		...lines.map((line) => `-${line}`),
	].join("\n");
}

function sanitizeDescription(description: string | undefined): string | undefined {
	const sanitized = description
		?.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
		.trim();
	return sanitized || undefined;
}

function sanitizeDiffForDisplay(diff: string): string {
	return diff.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
		if (character === "\n" || character === "\t") return character;
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined) return "";
		return codePoint <= 0xffff
			? `\\u${codePoint.toString(16).padStart(4, "0")}`
			: `\\u{${codePoint.toString(16)}}`;
	});
}

export function createControlledEditManager(options: {
	operations: ControlledEditOperations;
	createId?: () => string;
	now?: () => Date;
}): ControlledEditManager {
	const proposals = new Map<string, StoredProposal>();
	const createId = options.createId ?? randomUUID;
	const now = options.now ?? (() => new Date());

	const getStored = (id: string): StoredProposal => {
		const proposal = proposals.get(id);
		if (!proposal) throw new Error(`Unknown edit proposal: ${id}`);
		if (new Date(proposal.summary.expiresAt).getTime() <= now().getTime()) {
			proposals.delete(id);
			throw new Error(`Edit proposal expired: ${id}`);
		}
		return proposal;
	};

	return {
		async prepare(intent, signal) {
			throwIfAborted(signal);
			const snapshot = await options.operations.inspectEditablePath(intent.path, signal);
			let edit: PreparedEdit;
			let diff: string;
			let changedRange: EditProposalSummary["changedRange"];
			if (intent.kind === "create") {
				if (snapshot.state !== "absent") {
					throw new Error(`Create target already exists: ${snapshot.path}`);
				}
				if (Buffer.byteLength(intent.content, "utf8") > maxReplacementBytes) {
					throw new Error(`Created file content exceeds ${maxReplacementBytes} bytes`);
				}
				edit = { kind: "create", snapshot, newContent: intent.content };
				diff = createWholeFileDiff("create", snapshot.path, intent.content);
			} else {
				if (snapshot.state !== "existing") {
					throw new Error(`Existing file is required: ${snapshot.path}`);
				}
				if (intent.kind === "delete") {
					if (Buffer.byteLength(snapshot.content, "utf8") > maxReplacementBytes) {
						throw new Error(`Deleted file exceeds the ${maxReplacementBytes}-byte approval limit`);
					}
					edit = { kind: "delete", snapshot };
					diff = createWholeFileDiff("delete", snapshot.path, snapshot.content);
				} else {
					if (
						Buffer.byteLength(intent.oldText, "utf8") +
							Buffer.byteLength(intent.newText, "utf8") >
						maxReplacementBytes
					) {
						throw new Error(`Combined replacement exceeds ${maxReplacementBytes} bytes`);
					}
					if (intent.oldText === intent.newText) {
						throw new Error("oldText and newText must differ");
					}
					const occurrences = countOccurrences(snapshot.content, intent.oldText);
					if (occurrences !== 1) {
						throw new Error(
							`oldText must occur exactly once in ${snapshot.path}; found ${occurrences}`,
						);
					}
					const newContent = snapshot.content.replace(intent.oldText, intent.newText);
					if (Buffer.byteLength(newContent, "utf8") > maxEditableFileBytes) {
						throw new Error(`Edited file exceeds ${maxEditableFileBytes} bytes`);
					}
					edit = { kind: "replace", snapshot, newContent };
					const replacementOffset = snapshot.content.indexOf(intent.oldText);
					const startLine = snapshot.content.slice(0, replacementOffset).split("\n").length;
					changedRange = {
						startLine,
						endLine: startLine + intent.oldText.split("\n").length - 1,
					};
					diff = createDiff(
						snapshot.path,
						snapshot.content,
						intent.oldText,
						intent.newText,
					);
				}
			}
			while (proposals.size >= maxStoredProposals) {
				const oldest = proposals.keys().next().value;
				if (oldest === undefined) break;
				proposals.delete(oldest);
			}
			const id = createId();
			const summary: EditProposalSummary = {
				id,
				kind: edit.kind,
				path: snapshot.path,
				description: sanitizeDescription(intent.description),
				diff: sanitizeDiffForDisplay(diff),
				expectedHash: snapshot.state === "existing" ? snapshot.hash : undefined,
				changedRange,
				expiresAt: new Date(now().getTime() + proposalTtlMs).toISOString(),
			};
			proposals.set(id, { summary, edit, status: "pending" });
			return { ...summary };
		},

		getProposal(id) {
			return { ...getStored(id).summary };
		},

		approve(id) {
			const proposal = getStored(id);
			if (proposal.status === "approved") return;
			if (proposal.status !== "pending") {
				throw new Error(`Edit proposal is not pending: ${id}`);
			}
			proposal.status = "approved";
		},

		async apply(id, signal) {
			const proposal = getStored(id);
			if (proposal.status !== "approved") {
				throw new Error(`Edit proposal has not been approved: ${id}`);
			}
			proposal.status = "applying";
			try {
				const result = await options.operations.commitIfUnchanged(proposal.edit, signal);
				proposal.status = "applied";
				return {
					proposalId: id,
					kind: proposal.summary.kind,
					path: proposal.summary.path,
					previousHash: result.previousHash,
					newHash: result.newHash,
				};
			} catch (error) {
				proposals.delete(id);
				throw error;
			}
		},
	};
}

function emitUpdate(
	toolName: ControlledEditToolName,
	onUpdate: AgentToolUpdateCallback<ControlledEditToolDetails> | undefined,
	details: ControlledEditToolDetails,
	signal?: AbortSignal,
): void {
	throwIfAborted(signal);
	onUpdate?.({ content: [{ type: "text", text: `${toolName}: ${details.stage}` }], details });
	throwIfAborted(signal);
}

function proposalResult(
	proposal: EditProposalSummary,
): AgentToolResult<ControlledEditToolDetails> {
	return {
		content: [
			{
				type: "text",
				text: [
					`${proposal.kind} proposal ${proposal.id} for ${JSON.stringify(proposal.path)}`,
					proposal.description
						? `Description: ${JSON.stringify(proposal.description)}`
						: undefined,
					proposal.expectedHash
						? `Expected SHA-256: ${proposal.expectedHash}`
						: "Expected state: path does not exist",
					"State: prepared only; no approval has been requested and no file has changed.",
					`Expires: ${proposal.expiresAt}`,
					"",
					proposal.diff,
					"",
					`Next tool call: apply_edit with proposalId ${JSON.stringify(proposal.id)}. It applies automatically by default; if its permission is tightened to ask, that call opens the TUI approval card. Do not ask the user to approve the proposal itself.`,
				]
					.filter((line): line is string => line !== undefined)
					.join("\n"),
			},
		],
		details: {
			stage: "prepared",
			path: proposal.path,
			proposalId: proposal.id,
		},
	};
}

export function createProposePatchTool(
	manager: ControlledEditManager,
): AgentTool<typeof proposePatchSchema, ControlledEditToolDetails> {
	return {
		name: "propose_patch",
		label: "propose patch",
		description:
			"Prepare a bounded exact-text edit for an existing UTF-8 text file in the workspace. This does not write or request approval. oldText must match exactly once; after this returns, call apply_edit with its proposalId. Use this for existing files, including whole-file replacement within the size limits.",
		parameters: proposePatchSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal, onUpdate) {
			if (!proposePatchValidator.Check(rawInput)) {
				throw new Error("propose_patch arguments failed execution-time validation");
			}
			const input: ProposePatchInput = rawInput;
			emitUpdate("propose_patch", onUpdate, { stage: "validating", path: input.path }, signal);
			emitUpdate("propose_patch", onUpdate, { stage: "preparing", path: input.path }, signal);
			const proposal = await manager.prepare({ kind: "replace", ...input }, signal);
			throwIfAborted(signal);
			return proposalResult(proposal);
		},
	};
}

export function createProposeCreateFileTool(
	manager: ControlledEditManager,
): AgentTool<typeof proposeCreateFileSchema, ControlledEditToolDetails> {
	return {
		name: "propose_create_file",
		label: "propose create file",
		description:
			"Prepare creation of one genuinely new UTF-8 text file in the workspace. This does not write or request approval. The path must be absent; never delete an existing file merely to recreate or overwrite it. After this returns, call apply_edit with its proposalId.",
		parameters: proposeCreateFileSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal, onUpdate) {
			if (!proposeCreateFileValidator.Check(rawInput)) {
				throw new Error("propose_create_file arguments failed execution-time validation");
			}
			const input: ProposeCreateFileInput = rawInput;
			emitUpdate(
				"propose_create_file",
				onUpdate,
				{ stage: "validating", path: input.path },
				signal,
			);
			emitUpdate(
				"propose_create_file",
				onUpdate,
				{ stage: "preparing", path: input.path },
				signal,
			);
			const proposal = await manager.prepare({ kind: "create", ...input }, signal);
			throwIfAborted(signal);
			return proposalResult(proposal);
		},
	};
}

export function createProposeDeleteFileTool(
	manager: ControlledEditManager,
): AgentTool<typeof proposeDeleteFileSchema, ControlledEditToolDetails> {
	return {
		name: "propose_delete_file",
		label: "propose delete file",
		description:
			"Prepare intentional deletion of one existing UTF-8 text file in the workspace. This does not delete or request approval. Never use delete followed by create to replace a file; use propose_patch. After this returns, call apply_edit with its proposalId.",
		parameters: proposeDeleteFileSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal, onUpdate) {
			if (!proposeDeleteFileValidator.Check(rawInput)) {
				throw new Error("propose_delete_file arguments failed execution-time validation");
			}
			const input: ProposeDeleteFileInput = rawInput;
			emitUpdate(
				"propose_delete_file",
				onUpdate,
				{ stage: "validating", path: input.path },
				signal,
			);
			emitUpdate(
				"propose_delete_file",
				onUpdate,
				{ stage: "preparing", path: input.path },
				signal,
			);
			const proposal = await manager.prepare({ kind: "delete", ...input }, signal);
			throwIfAborted(signal);
			return proposalResult(proposal);
		},
	};
}

export function createApplyEditTool(
	manager: ControlledEditManager,
): AgentTool<typeof applyEditSchema, ControlledEditToolDetails> {
	return {
		name: "apply_edit",
		label: "apply edit",
		description:
			"Apply one previously prepared proposal. It runs automatically by default; when its permission is ask, it opens the TUI approval card first. Logos Agent writers use a lock and reject changes before the final recheck. Do not edit the target concurrently in external programs during application.",
		parameters: applyEditSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal, onUpdate) {
			if (!applyEditValidator.Check(rawInput)) {
				throw new Error("apply_edit arguments failed execution-time validation");
			}
			const input: ApplyEditInput = rawInput;
			const proposal = manager.getProposal(input.proposalId);
			emitUpdate(
				"apply_edit",
				onUpdate,
				{ stage: "applying", path: proposal.path, proposalId: proposal.id },
				signal,
			);
			const applied = await manager.apply(input.proposalId, signal);
			return {
				content: [
					{
						type: "text",
						text: [
							`Applied ${applied.kind} proposal ${applied.proposalId} to ${JSON.stringify(applied.path)}.`,
							applied.previousHash
								? `Previous SHA-256: ${applied.previousHash}`
								: undefined,
							applied.newHash ? `New SHA-256: ${applied.newHash}` : undefined,
							"The running process still uses the previously loaded code; restart Logos Agent to load this change.",
						]
							.filter((line): line is string => line !== undefined)
							.join("\n"),
					},
				],
				details: {
					stage: "completed",
					path: applied.path,
					proposalId: applied.proposalId,
					previousHash: applied.previousHash,
					newHash: applied.newHash,
				},
			};
		},
	};
}
