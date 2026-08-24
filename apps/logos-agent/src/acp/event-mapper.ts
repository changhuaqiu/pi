import type { LogosAgentUiEvent } from "../logos-agent.ts";

export interface AcpSessionUpdate {
	sessionUpdate: string;
	[key: string]: unknown;
}

function toolKind(toolName: string): string {
	if (/^(read_|list_|workspace_|git_(status|diff|log|show|blame))/u.test(toolName)) return "read";
	if (/^(propose_|apply_edit|create_directories)/u.test(toolName)) return "edit";
	if (/^(grep|codegraph_)/u.test(toolName)) return "search";
	if (/^(run_|command_|stop_command|buzz_cli)/u.test(toolName)) return "execute";
	if (/^(plan_task|reflect_task)/u.test(toolName)) return "think";
	if (toolName === "web_search") return "fetch";
	return "other";
}

export function mapLogosEventToAcpUpdates(
	event: LogosAgentUiEvent,
): AcpSessionUpdate[] {
	if (event.type === "message_update") {
		const update = event.assistantMessageEvent;
		if (update.type === "text_delta" && update.delta) {
			return [{
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: update.delta },
			}];
		}
		if (update.type === "thinking_delta" && update.delta) {
			return [{
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: update.delta },
			}];
		}
		return [];
	}
	if (event.type === "tool_execution_start") {
		return [{
			sessionUpdate: "tool_call",
			toolCallId: event.toolCallId,
			title: event.toolName,
			kind: toolKind(event.toolName),
			status: "in_progress",
		}];
	}
	if (event.type === "tool_execution_update") {
		return [{
			sessionUpdate: "tool_call_update",
			toolCallId: event.toolCallId,
			title: event.toolName,
			kind: toolKind(event.toolName),
			status: "in_progress",
		}];
	}
	if (event.type === "tool_execution_end") {
		return [{
			sessionUpdate: "tool_call_update",
			toolCallId: event.toolCallId,
			title: event.toolName,
			kind: toolKind(event.toolName),
			status: event.isError ? "failed" : "completed",
		}];
	}
	return [];
}
