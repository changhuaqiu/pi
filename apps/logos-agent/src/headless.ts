import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	LogosAgentUiEvent,
} from "./logos-agent.ts";
import { getMessageText } from "./logos-agent.ts";
import { isNormalTurnComplete } from "./turn-task-lifecycle.ts";

export interface HeadlessLogosAgent {
	prompt(text: string): Promise<AssistantMessage>;
	subscribe(listener: (event: LogosAgentUiEvent) => void | Promise<void>): () => void;
	respondToApproval(requestId: string, approved: boolean): boolean;
	respondToQuestion(
		requestId: string,
		action: { kind: "cancel" },
	): { accepted: boolean; error?: string };
}

export async function runHeadlessPrompt(
	agent: HeadlessLogosAgent,
	prompt: string,
	options: { autoApprove?: boolean } = {},
): Promise<string> {
	const unsubscribe = agent.subscribe((event) => {
		if (event.type === "approval_request") {
			if (!agent.respondToApproval(event.request.id, options.autoApprove ?? false)) {
				throw new Error("Tool approval was no longer pending");
			}
		}
		if (event.type === "question_request") {
			const response = agent.respondToQuestion(event.request.id, { kind: "cancel" });
			if (!response.accepted) {
				throw new Error(response.error ?? "User question was no longer pending");
			}
		}
	});
	try {
		const message = await agent.prompt(prompt);
		if (!isNormalTurnComplete(message)) {
			throw new Error(
				message.errorMessage ??
					`Agent run did not complete normally (${message.stopReason})`,
			);
		}
		return getMessageText(message).trim();
	} finally {
		unsubscribe();
	}
}
