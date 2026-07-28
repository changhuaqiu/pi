import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalWorkspaceInfoOperations, type WorkspaceInfoOperations } from "./operations.ts";
import {
	createWorkspaceInfoAuditRecord,
	freezeWorkspaceInfoInput,
	redactWorkspaceInfoResult,
	type WorkspaceInfoAuditRecord,
} from "./security.ts";
import { createWorkspaceInfoTool, isWorkspaceInfoInput } from "./tool.ts";

export interface WorkspaceInfoExtensionOptions {
	operations: WorkspaceInfoOperations;
	now?: () => Date;
	onAudit?: (record: WorkspaceInfoAuditRecord) => Promise<void> | void;
}

export function registerWorkspaceInfoExtension(pi: ExtensionAPI, options: WorkspaceInfoExtensionOptions): void {
	pi.registerTool(createWorkspaceInfoTool(options.operations));

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "workspace_info") return undefined;
		const inputIsValid = isWorkspaceInfoInput(event.input);
		const record = createWorkspaceInfoAuditRecord(event, inputIsValid ? "allowed" : "blocked", options.now);
		if (!record) return undefined;

		await options.onAudit?.(record);
		if (ctx.hasUI) {
			ctx.ui.notify(`workspace_info audit: ${record.decision}, input=${JSON.stringify(record.input)}`, "info");
		}
		if (!inputIsValid) {
			return {
				block: true,
				reason: "workspace_info arguments were modified to an invalid value after schema validation",
			};
		}
		freezeWorkspaceInfoInput(event);
		return undefined;
	});

	pi.on("tool_result", (event, ctx) => redactWorkspaceInfoResult(event, ctx.cwd));
}

export default function workspaceInfoExtension(pi: ExtensionAPI): void {
	registerWorkspaceInfoExtension(pi, {
		operations: createLocalWorkspaceInfoOperations(),
	});
}
