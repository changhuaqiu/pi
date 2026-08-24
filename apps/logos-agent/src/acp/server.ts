import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { LogosAgentUiEvent, LogosApprovalSubject } from "../logos-agent.ts";
import { mapLogosEventToAcpUpdates } from "./event-mapper.ts";
import {
	type AcpLogosAgentFactory,
	type AcpLogosSession,
	AcpSessionRegistry,
} from "./session-registry.ts";

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: unknown;
	result?: unknown;
	error?: unknown;
}

interface PendingPermission {
	session: AcpLogosSession;
	requestId: string;
}

export interface AcpServerOptions {
	input: Readable;
	output: Writable;
	createAgent: AcpLogosAgentFactory;
	agentInfo: {
		name: string;
		title: string;
		version: string;
	};
	log?: (message: string) => void;
}

const protocolVersion = 1;
const maxLineBytes = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestId(message: JsonRpcMessage): JsonRpcId | undefined {
	return typeof message.id === "string" || typeof message.id === "number" || message.id === null
		? message.id
		: undefined;
}

function requireParams(message: JsonRpcMessage): Record<string, unknown> {
	if (!isRecord(message.params)) throw new Error("params must be an object");
	return message.params;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function permissionTitle(subject: LogosApprovalSubject): string {
	if (subject.kind === "edit") return `Apply ${subject.proposal.kind} edit`;
	if (subject.kind === "directories") return "Create workspace directories";
	if (subject.kind === "task") return subject.task.label;
	if (subject.kind === "command") return subject.command.command;
	if (subject.kind === "process_stop") return "Stop managed process";
	if (subject.kind === "operation") return subject.title;
	return `Allow ${subject.toolName}`;
}

function promptText(value: unknown): string {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("prompt must contain at least one content block");
	}
	const blocks: string[] = [];
	for (const block of value) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
			throw new Error("Logos Agent currently accepts only ACP text content blocks");
		}
		blocks.push(block.text);
	}
	const text = blocks.join("\n\n");
	if (!text.trim()) throw new Error("prompt text cannot be empty");
	return text;
}

function stopReason(message: AssistantMessage): string {
	if (message.stopReason === "aborted") return "cancelled";
	if (message.stopReason === "length") return "max_tokens";
	if (message.stopReason === "error") return "refusal";
	return "end_turn";
}

export class LogosAcpServer {
	private readonly options: AcpServerOptions;
	private readonly registry: AcpSessionRegistry;
	private readonly tasks = new Set<Promise<void>>();
	private readonly pendingPermissions = new Map<string, PendingPermission>();
	private readonly log: (message: string) => void;
	private writeChain: Promise<void> = Promise.resolve();
	private nextPermissionId = 1;
	private initialized = false;
	private closing = false;

	constructor(options: AcpServerOptions) {
		this.options = options;
		this.registry = new AcpSessionRegistry(options.createAgent);
		this.log = options.log ?? ((message) => process.stderr.write(`logos-agent-acp: ${message}\n`));
	}

	async run(): Promise<void> {
		const lines = createInterface({
			input: this.options.input,
			crlfDelay: Infinity,
			terminal: false,
		});
		try {
			for await (const line of lines) {
				if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
					await this.sendError(null, -32700, "ACP message exceeds the 1048576-byte limit");
					continue;
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					await this.sendError(null, -32700, "Invalid JSON");
					continue;
				}
				if (!isRecord(parsed)) {
					await this.sendError(null, -32600, "JSON-RPC message must be an object");
					continue;
				}
				this.track(this.handleMessage(parsed));
			}
		} finally {
			this.closing = true;
			try {
				await this.registry.closeAll();
			} catch (error) {
				this.log(error instanceof Error ? error.message : String(error));
			}
			await Promise.allSettled([...this.tasks]);
		}
	}

	private track(task: Promise<void>): void {
		this.tasks.add(task);
		void task.then(
			() => this.tasks.delete(task),
			(error: unknown) => {
				this.tasks.delete(task);
				this.log(error instanceof Error ? error.message : String(error));
			},
		);
	}

	private async handleMessage(message: JsonRpcMessage): Promise<void> {
		if (message.jsonrpc !== "2.0") {
			await this.sendError(requestId(message) ?? null, -32600, "jsonrpc must be 2.0");
			return;
		}
		if (typeof message.method !== "string") {
			await this.handleClientResponse(message);
			return;
		}
		const id = requestId(message);
		try {
			if (message.method === "initialize") {
				if (id === undefined) throw new Error("initialize must be a request");
				if (this.initialized) {
					await this.sendError(id, -32002, "ACP connection is already initialized");
					return;
				}
				const params = requireParams(message);
				if (typeof params.protocolVersion !== "number") {
					throw new Error("protocolVersion must be a number");
				}
				this.initialized = true;
				await this.sendResult(id, {
					protocolVersion,
					agentCapabilities: {
						loadSession: false,
						promptCapabilities: {
							image: false,
							audio: false,
							embeddedContext: false,
						},
					},
					agentInfo: this.options.agentInfo,
					authMethods: [],
				});
				return;
			}
			if (!this.initialized) {
				if (id !== undefined) {
					await this.sendError(id, -32002, "ACP connection is not initialized");
				}
				return;
			}
			if (message.method === "session/new") {
				if (id === undefined) throw new Error("session/new must be a request");
				const params = requireParams(message);
				const cwd = requireString(params.cwd, "cwd");
				if (!isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
				const session = await this.registry.create(cwd);
				session.unsubscribe = session.agent.subscribe(async (event) => {
					await this.handleAgentEvent(session, event);
				});
				await this.sendResult(id, { sessionId: session.id });
				return;
			}
			if (message.method === "session/prompt") {
				if (id === undefined) throw new Error("session/prompt must be a request");
				const params = requireParams(message);
				const session = this.requireSession(params.sessionId);
				if (session.activePrompt) {
					await this.sendError(id, -32002, "Session already has an active prompt");
					return;
				}
				const text = promptText(params.prompt);
				const prompt = this.runPrompt(session, id, text);
				session.activePrompt = prompt;
				await prompt;
				return;
			}
			if (message.method === "session/cancel") {
				const params = requireParams(message);
				const session = this.requireSession(params.sessionId);
				if (session.activePrompt) {
					session.cancelRequested = true;
					await session.agent.abort();
				}
				if (id !== undefined) await this.sendResult(id, {});
				return;
			}
			if (message.method === "session/close") {
				if (id === undefined) throw new Error("session/close must be a request");
				const params = requireParams(message);
				const sessionId = requireString(params.sessionId, "sessionId");
				this.rejectPendingPermissions(sessionId);
				if (!(await this.registry.close(sessionId))) {
					await this.sendError(id, -32001, `Unknown session: ${sessionId}`);
					return;
				}
				await this.sendResult(id, {});
				return;
			}
			if (id !== undefined) {
				await this.sendError(id, -32601, `Method not found: ${message.method}`);
			}
		} catch (error) {
			if (id !== undefined) {
				await this.sendError(id, -32602, error instanceof Error ? error.message : String(error));
			} else {
				this.log(error instanceof Error ? error.message : String(error));
			}
		}
	}

	private requireSession(value: unknown): AcpLogosSession {
		const sessionId = requireString(value, "sessionId");
		const session = this.registry.get(sessionId);
		if (!session) throw new Error(`Unknown session: ${sessionId}`);
		return session;
	}

	private async runPrompt(session: AcpLogosSession, id: JsonRpcId, text: string): Promise<void> {
		session.cancelRequested = false;
		try {
			const message = await session.agent.prompt(text);
			await this.sendResult(id, {
				stopReason: session.cancelRequested ? "cancelled" : stopReason(message),
			});
		} catch (error) {
			if (session.cancelRequested) {
				await this.sendResult(id, { stopReason: "cancelled" });
			} else {
				await this.sendError(id, -32000, error instanceof Error ? error.message : String(error));
			}
		} finally {
			session.activePrompt = undefined;
		}
	}

	private async handleAgentEvent(session: AcpLogosSession, event: LogosAgentUiEvent): Promise<void> {
		if (event.type === "approval_request") {
			await this.requestPermission(session, event.request.id, event.request.subject);
			return;
		}
		if (event.type === "question_request") {
			const response = session.agent.respondToQuestion(event.request.id, { kind: "cancel" });
			if (!response.accepted) this.log(response.error ?? "Question was no longer pending");
			return;
		}
		if (event.type === "approval_resolved") {
			for (const [id, pending] of this.pendingPermissions) {
				if (pending.session === session && pending.requestId === event.requestId) {
					this.pendingPermissions.delete(id);
				}
			}
			return;
		}
		for (const update of mapLogosEventToAcpUpdates(event)) {
			await this.sendNotification("session/update", {
				sessionId: session.id,
				update,
			});
		}
	}

	private async requestPermission(
		session: AcpLogosSession,
		requestId: string,
		subject: LogosApprovalSubject,
	): Promise<void> {
		const id = `logos-permission-${this.nextPermissionId}`;
		this.nextPermissionId += 1;
		this.pendingPermissions.set(id, { session, requestId });
		await this.send({
			jsonrpc: "2.0",
			id,
			method: "session/request_permission",
			params: {
				sessionId: session.id,
				toolCall: {
					toolCallId: requestId,
					title: permissionTitle(subject),
					kind: "other",
					status: "pending",
				},
				options: [
					{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
					{ optionId: "reject-once", name: "Reject once", kind: "reject_once" },
				],
			},
		});
	}

	private async handleClientResponse(message: JsonRpcMessage): Promise<void> {
		const id = requestId(message);
		if (id === undefined || id === null) return;
		const key = String(id);
		const pending = this.pendingPermissions.get(key);
		if (!pending) return;
		this.pendingPermissions.delete(key);
		let approved = false;
		if (isRecord(message.result) && isRecord(message.result.outcome)) {
			approved =
				message.result.outcome.outcome === "selected" &&
				message.result.outcome.optionId === "allow-once";
		}
		if (!pending.session.agent.respondToApproval(pending.requestId, approved)) {
			this.log(`Permission response ${key} arrived after the Logos request settled`);
		}
	}

	private rejectPendingPermissions(sessionId: string): void {
		for (const [id, pending] of this.pendingPermissions) {
			if (pending.session.id !== sessionId) continue;
			this.pendingPermissions.delete(id);
			pending.session.agent.respondToApproval(pending.requestId, false);
		}
	}

	private async sendResult(id: JsonRpcId, result: unknown): Promise<void> {
		await this.send({ jsonrpc: "2.0", id, result });
	}

	private async sendError(id: JsonRpcId, code: number, message: string): Promise<void> {
		await this.send({ jsonrpc: "2.0", id, error: { code, message } });
	}

	private async sendNotification(method: string, params: unknown): Promise<void> {
		await this.send({ jsonrpc: "2.0", method, params });
	}

	private async send(message: unknown): Promise<void> {
		if (this.closing) return;
		const line = `${JSON.stringify(message)}\n`;
		this.writeChain = this.writeChain.then(async () => {
			if (this.closing) return;
			if (this.options.output.write(line, "utf8")) return;
			await new Promise<void>((resolvePromise, rejectPromise) => {
				const cleanup = (): void => {
					this.options.output.off("drain", handleDrain);
					this.options.output.off("error", handleError);
				};
				const handleDrain = (): void => {
					cleanup();
					resolvePromise();
				};
				const handleError = (error: Error): void => {
					cleanup();
					rejectPromise(error);
				};
				this.options.output.once("drain", handleDrain);
				this.options.output.once("error", handleError);
			});
		});
		await this.writeChain;
	}
}
