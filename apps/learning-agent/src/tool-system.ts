import type {
	AgentTool,
	ToolCallEvent,
	ToolCallResult,
	ToolResultEvent,
	ToolResultPatch,
} from "../../../packages/agent/src/index.ts";
import {
	createDecisionAuditRecord,
	createResultAuditRecord,
	DEFAULT_MAX_TOOL_RESULT_BYTES,
	freezeToolInput,
	redactToolResult,
	sanitizeAuditInput,
	type ToolAuditRecord,
} from "./tool-security.ts";

export type ToolPermission = "allow" | "ask" | "deny";

export type ToolCapabilityKind =
	| "workspace.inspect"
	| "fs.read"
	| "fs.write"
	| "fs.delete"
	| "edit.propose"
	| "git.read"
	| "process.execute";

export interface ToolCapability {
	readonly kind: ToolCapabilityKind;
	readonly scope: string;
}

export interface ToolPermissionSnapshot {
	tools: Readonly<Record<string, ToolPermission>>;
	capabilities: Readonly<Partial<Record<ToolCapabilityKind, ToolPermission>>>;
}

export interface ToolPolicyInfo {
	name: string;
	capabilities: readonly ToolCapability[];
	defaultPermission: ToolPermission;
	effectivePermission: ToolPermission;
	active: boolean;
}

export interface ToolPermissionStore {
	getToolPermission(toolName: string): ToolPermission | undefined;
	getCapabilityPermission(capability: ToolCapabilityKind): ToolPermission | undefined;
	setToolPermission(toolName: string, permission: ToolPermission | undefined): void;
	setCapabilityPermission(capability: ToolCapabilityKind, permission: ToolPermission | undefined): void;
	snapshot(): ToolPermissionSnapshot;
}

export class InMemoryToolPermissionStore implements ToolPermissionStore {
	private readonly tools = new Map<string, ToolPermission>();
	private readonly capabilities = new Map<ToolCapabilityKind, ToolPermission>();

	getToolPermission(toolName: string): ToolPermission | undefined {
		return this.tools.get(toolName);
	}

	getCapabilityPermission(capability: ToolCapabilityKind): ToolPermission | undefined {
		return this.capabilities.get(capability);
	}

	setToolPermission(toolName: string, permission: ToolPermission | undefined): void {
		if (permission === undefined) {
			this.tools.delete(toolName);
		} else {
			this.tools.set(toolName, permission);
		}
	}

	setCapabilityPermission(capability: ToolCapabilityKind, permission: ToolPermission | undefined): void {
		if (permission === undefined) {
			this.capabilities.delete(capability);
		} else {
			this.capabilities.set(capability, permission);
		}
	}

	snapshot(): ToolPermissionSnapshot {
		return {
			tools: Object.fromEntries(this.tools),
			capabilities: Object.fromEntries(this.capabilities),
		};
	}
}

export interface ToolAuthorizationContext {
	toolCallId: string;
	toolName: string;
	input: Readonly<Record<string, unknown>>;
	capabilities: readonly ToolCapability[];
}

export type ToolAuthorizationPreparation<TApprovalSubject> =
	| { kind: "ready"; approvalSubject?: TApprovalSubject; grant?: () => void | Promise<void> }
	| { kind: "deny"; reason: string };

export interface ToolAuthorizationPolicy<TApprovalSubject> {
	prepare(
		context: ToolAuthorizationContext,
	): ToolAuthorizationPreparation<TApprovalSubject> | Promise<ToolAuthorizationPreparation<TApprovalSubject>>;
}

export interface ToolResultContextPolicy {
	maxBytes?: number;
	project?(
		event: Readonly<ToolResultEvent>,
	): ToolResultPatch | undefined | Promise<ToolResultPatch | undefined>;
}

export interface ManagedToolDescriptor<TTool extends AgentTool, TApprovalSubject> {
	readonly tool: TTool;
	readonly capabilities: readonly ToolCapability[];
	readonly defaultPermission: ToolPermission;
	readonly authorization?: ToolAuthorizationPolicy<TApprovalSubject>;
	readonly audit?: {
		summarizeInput(input: Readonly<Record<string, unknown>>): Record<string, unknown>;
	};
	readonly context?: ToolResultContextPolicy;
	readonly guidance?: readonly string[];
}

export interface ToolSystemOptions<TApprovalSubject> {
	workspaceRoot: string;
	permissionStore?: ToolPermissionStore;
	globalMaxResultBytes?: number;
	requestApproval(subject: TApprovalSubject): Promise<boolean>;
	createGenericApprovalSubject(context: ToolAuthorizationContext): TApprovalSubject;
	recordAudit(record: ToolAuditRecord): Promise<void>;
}

const permissionRank: Record<ToolPermission, number> = {
	allow: 0,
	ask: 1,
	deny: 2,
};

function mostRestrictive(permissions: readonly (ToolPermission | undefined)[]): ToolPermission {
	let result: ToolPermission = "allow";
	for (const permission of permissions) {
		if (permission !== undefined && permissionRank[permission] > permissionRank[result]) {
			result = permission;
		}
	}
	return result;
}

function resultBytes(content: ToolResultEvent["content"], details: unknown): number {
	let bytes = 0;
	for (const item of content) {
		bytes += item.type === "text"
			? Buffer.byteLength(item.text, "utf8")
			: Buffer.byteLength(item.data, "utf8");
	}
	if (details !== undefined) {
		try {
			bytes += Buffer.byteLength(JSON.stringify(details), "utf8");
		} catch {
			return Number.MAX_SAFE_INTEGER;
		}
	}
	return bytes;
}

function formatCapability(capability: ToolCapability): string {
	return `${capability.kind}(${capability.scope})`;
}

function validatePromptMetadata(value: string, label: string, maxLength: number): void {
	if (
		!value.trim() ||
		value.length > maxLength ||
		/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u.test(value)
	) {
		throw new Error(`${label} must contain safe single-line text with at most ${maxLength} characters`);
	}
}

export class ToolSystem<TTool extends AgentTool, TApprovalSubject> {
	private readonly workspaceRoot: string;
	private readonly permissionStore: ToolPermissionStore;
	private readonly globalMaxResultBytes: number;
	private readonly requestApproval: ToolSystemOptions<TApprovalSubject>["requestApproval"];
	private readonly createGenericApprovalSubject: ToolSystemOptions<TApprovalSubject>["createGenericApprovalSubject"];
	private readonly recordAudit: ToolSystemOptions<TApprovalSubject>["recordAudit"];
	private readonly descriptors = new Map<string, ManagedToolDescriptor<TTool, TApprovalSubject>>();
	private readonly startedAt = new Map<string, number>();

	constructor(options: ToolSystemOptions<TApprovalSubject>) {
		this.workspaceRoot = options.workspaceRoot;
		this.permissionStore = options.permissionStore ?? new InMemoryToolPermissionStore();
		this.globalMaxResultBytes = options.globalMaxResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES;
		if (!Number.isSafeInteger(this.globalMaxResultBytes) || this.globalMaxResultBytes <= 0) {
			throw new Error("Global tool result byte limit must be a positive safe integer");
		}
		this.requestApproval = options.requestApproval;
		this.createGenericApprovalSubject = options.createGenericApprovalSubject;
		this.recordAudit = options.recordAudit;
	}

	register(descriptor: ManagedToolDescriptor<TTool, TApprovalSubject>): void {
		const { tool } = descriptor;
		if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
			throw new Error(`Invalid tool name: ${tool.name}`);
		}
		if (this.descriptors.has(tool.name)) {
			throw new Error(`Tool is already registered: ${tool.name}`);
		}
		validatePromptMetadata(tool.description, `Tool description for ${tool.name}`, 2_000);
		let schema: string;
		try {
			schema = JSON.stringify(tool.parameters);
		} catch {
			throw new Error(`Tool schema is not serializable: ${tool.name}`);
		}
		const schemaBytes = Buffer.byteLength(schema, "utf8");
		if (schemaBytes > 64 * 1024) {
			throw new Error(`Tool schema exceeds 65536 bytes: ${tool.name}`);
		}
		if (descriptor.capabilities.length === 0) {
			throw new Error(`Tool must declare at least one capability: ${tool.name}`);
		}
		for (const capability of descriptor.capabilities) {
			validatePromptMetadata(capability.scope, `Capability scope for ${tool.name}`, 500);
		}
		for (const instruction of descriptor.guidance ?? []) {
			validatePromptMetadata(instruction, `Tool guidance for ${tool.name}`, 2_000);
		}
		const maxBytes = descriptor.context?.maxBytes;
		if (
			maxBytes !== undefined &&
			(!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > this.globalMaxResultBytes)
		) {
			throw new Error(`Tool result byte limit is invalid: ${tool.name}`);
		}
		freezeToolInput(tool.parameters as Record<string, unknown>);
		Object.freeze(tool);
		const storedDescriptor: ManagedToolDescriptor<TTool, TApprovalSubject> = {
			...descriptor,
			capabilities: Object.freeze(
				descriptor.capabilities.map((capability) => Object.freeze({ ...capability })),
			),
			...(descriptor.guidance
				? { guidance: Object.freeze([...descriptor.guidance]) }
				: {}),
		};
		if (storedDescriptor.authorization) Object.freeze(storedDescriptor.authorization);
		if (storedDescriptor.audit) Object.freeze(storedDescriptor.audit);
		if (storedDescriptor.context) Object.freeze(storedDescriptor.context);
		Object.freeze(storedDescriptor);
		this.descriptors.set(tool.name, storedDescriptor);
	}

	getTools(): TTool[] {
		return [...this.descriptors.values()]
			.filter((descriptor) => this.resolvePermission(descriptor) !== "deny")
			.map((descriptor) => descriptor.tool);
	}

	setToolPermission(toolName: string, permission: ToolPermission | undefined): void {
		if (!this.descriptors.has(toolName)) throw new Error(`Tool is not registered: ${toolName}`);
		this.permissionStore.setToolPermission(toolName, permission);
	}

	setCapabilityPermission(capability: ToolCapabilityKind, permission: ToolPermission | undefined): void {
		this.permissionStore.setCapabilityPermission(capability, permission);
	}

	getPermissionSnapshot(): ToolPermissionSnapshot {
		return this.permissionStore.snapshot();
	}

	getToolPolicies(): ToolPolicyInfo[] {
		return [...this.descriptors.values()].map((descriptor) => {
			const effectivePermission = this.resolvePermission(descriptor);
			return {
				name: descriptor.tool.name,
				capabilities: descriptor.capabilities,
				defaultPermission: descriptor.defaultPermission,
				effectivePermission,
				active: effectivePermission !== "deny",
			};
		});
	}

	buildSystemPrompt(basePrompt: string): string {
		const activeDescriptors = [...this.descriptors.values()].filter(
			(descriptor) => this.resolvePermission(descriptor) !== "deny",
		);
		const lines = [
			"<tool-policy>",
			"Only the tools listed below are available. Tool permissions and capability scopes are enforced by the application.",
			"Do not attempt actions outside the declared capability scopes.",
		];
		for (const descriptor of activeDescriptors) {
			const permission = this.resolvePermission(descriptor);
			const capabilities = descriptor.capabilities.map(formatCapability).join(", ");
			lines.push(`- ${descriptor.tool.name}: permission=${permission}; capabilities=${capabilities}`);
		}
		const guidance = new Set(activeDescriptors.flatMap((descriptor) => descriptor.guidance ?? []));
		if (guidance.size > 0) {
			lines.push("Guidance:");
			for (const instruction of guidance) lines.push(`- ${instruction}`);
		}
		lines.push("</tool-policy>");
		return `${basePrompt.trim()}\n\n${lines.join("\n")}`;
	}

	async onToolCall(event: ToolCallEvent): Promise<ToolCallResult | undefined> {
		const descriptor = this.descriptors.get(event.toolName);
		if (!descriptor) {
			return { block: true, reason: `Tool is not registered: ${event.toolName}` };
		}

		freezeToolInput(event.input);
		const inputSummary = sanitizeAuditInput(
			descriptor.audit?.summarizeInput(event.input) ?? event.input,
			this.workspaceRoot,
		);
		const authorizationContext: ToolAuthorizationContext = {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			input: event.input,
			capabilities: descriptor.capabilities,
		};
		let permission = this.resolvePermission(descriptor);
		if (permission === "deny") {
			await this.recordAudit(
				createDecisionAuditRecord(event.toolCallId, event.toolName, inputSummary, "blocked"),
			);
			return { block: true, reason: `Tool permission denied: ${event.toolName}` };
		}

		let preparation: ToolAuthorizationPreparation<TApprovalSubject> = { kind: "ready" };
		try {
			if (descriptor.authorization) {
				preparation = await descriptor.authorization.prepare(authorizationContext);
			}
		} catch {
			await this.recordAudit(
				createDecisionAuditRecord(event.toolCallId, event.toolName, inputSummary, "blocked"),
			);
			return { block: true, reason: `Tool authorization failed: ${event.toolName}` };
		}
		if (preparation.kind === "deny") {
			await this.recordAudit(
				createDecisionAuditRecord(event.toolCallId, event.toolName, inputSummary, "blocked"),
			);
			return { block: true, reason: preparation.reason };
		}

		let approvalGranted = false;
		permission = this.resolvePermission(descriptor);
		if (permission === "deny") {
			await this.recordAudit(
				createDecisionAuditRecord(event.toolCallId, event.toolName, inputSummary, "blocked"),
			);
			return { block: true, reason: `Tool permission denied: ${event.toolName}` };
		}
		if (permission === "ask") {
			let approved = false;
			try {
				const subject = preparation.approvalSubject ?? this.createGenericApprovalSubject(authorizationContext);
				approved = await this.requestApproval(subject);
			} catch {
				await this.recordAudit(
					createDecisionAuditRecord(event.toolCallId, event.toolName, inputSummary, "blocked"),
				);
				return { block: true, reason: `Tool approval failed: ${event.toolName}` };
			}
			if (!approved) {
				await this.recordAudit(
					createDecisionAuditRecord(event.toolCallId, event.toolName, inputSummary, "blocked"),
				);
				return { block: true, reason: "User rejected the requested operation" };
			}
			approvalGranted = true;
		}

		permission = this.resolvePermission(descriptor);
		if (permission === "deny" || (permission === "ask" && !approvalGranted)) {
			await this.recordAudit(
				createDecisionAuditRecord(event.toolCallId, event.toolName, inputSummary, "blocked"),
			);
			return {
				block: true,
				reason: `Tool permission changed before execution: ${event.toolName}`,
			};
		}

		try {
			await preparation.grant?.();
		} catch {
			await this.recordAudit(
				createDecisionAuditRecord(event.toolCallId, event.toolName, inputSummary, "blocked"),
			);
			return { block: true, reason: `Tool authorization grant failed: ${event.toolName}` };
		}
		permission = this.resolvePermission(descriptor);
		if (permission === "deny" || (permission === "ask" && !approvalGranted)) {
			await this.recordAudit(
				createDecisionAuditRecord(event.toolCallId, event.toolName, inputSummary, "blocked"),
			);
			return {
				block: true,
				reason: `Tool permission changed during authorization: ${event.toolName}`,
			};
		}

		this.startedAt.set(event.toolCallId, Date.now());
		await this.recordAudit(
			createDecisionAuditRecord(event.toolCallId, event.toolName, inputSummary, "allowed"),
		);
		permission = this.resolvePermission(descriptor);
		if (permission === "deny" || (permission === "ask" && !approvalGranted)) {
			this.startedAt.delete(event.toolCallId);
			await this.recordAudit(
				createDecisionAuditRecord(event.toolCallId, event.toolName, inputSummary, "blocked"),
			);
			return {
				block: true,
				reason: `Tool permission changed before execution: ${event.toolName}`,
			};
		}
		return undefined;
	}

	async onToolResult(event: ToolResultEvent): Promise<ToolResultPatch | undefined> {
		const descriptor = this.descriptors.get(event.toolName);
		if (!descriptor) return undefined;

		let projection: ToolResultPatch | undefined;
		try {
			projection = await descriptor.context?.project?.(event);
		} catch {
			projection = {
				content: [{ type: "text", text: `Tool result projection failed: ${event.toolName}` }],
				details: {},
				isError: true,
			};
		}
		const content = projection?.content ?? event.content;
		const details = projection?.details ?? event.details;
		const maxBytes = descriptor.context?.maxBytes ?? this.globalMaxResultBytes;
		const governed = redactToolResult(content, details, this.workspaceRoot, maxBytes);
		const startedAt = this.startedAt.get(event.toolCallId);
		this.startedAt.delete(event.toolCallId);
		await this.recordAudit(
			createResultAuditRecord(
				event.toolCallId,
				event.toolName,
				projection?.isError ?? event.isError ? "failed" : "completed",
				resultBytes(governed.content, governed.details),
				startedAt === undefined ? undefined : Date.now() - startedAt,
			),
		);
		return {
			...projection,
			content: governed.content,
			details: governed.details,
		};
	}

	private resolvePermission(descriptor: ManagedToolDescriptor<TTool, TApprovalSubject>): ToolPermission {
		return mostRestrictive([
			descriptor.defaultPermission,
			this.permissionStore.getToolPermission(descriptor.tool.name),
			...descriptor.capabilities.map((capability) =>
				this.permissionStore.getCapabilityPermission(capability.kind),
			),
		]);
	}
}
