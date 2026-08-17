import type { AgentMessage } from "../../../packages/agent/src/index.ts";

export interface ModelContextInput {
	readonly messages: readonly AgentMessage[];
}

export interface ModelContextContribution {
	readonly messages: readonly AgentMessage[];
	readonly afterUserText?: string;
	readonly replaceCustomTypes?: readonly string[];
}

export type ModelContextContributor = (
	input: ModelContextInput,
) => ModelContextContribution | undefined;

function userMessageText(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function findLastUserMessage(
	messages: readonly AgentMessage[],
	text: string,
): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (userMessageText(messages[index]!) === text) return index;
	}
	return -1;
}

export function assembleModelContext(
	messages: readonly AgentMessage[],
	contributors: readonly ModelContextContributor[],
): AgentMessage[] {
	const contributions = contributors
		.map((contributor) => contributor({ messages: messages.slice() }))
		.filter(
			(contribution): contribution is ModelContextContribution =>
				contribution !== undefined,
		);
	const replacedCustomTypes = new Set(
		contributions.flatMap((contribution) => contribution.replaceCustomTypes ?? []),
	);
	const baseMessages = messages.filter(
		(message) =>
			message.role !== "custom" ||
			!replacedCustomTypes.has(message.customType),
	);
	const insertions = new Map<number, AgentMessage[]>();

	for (const contribution of contributions) {
		if (contribution.messages.length === 0) continue;
		const anchorIndex =
			contribution.afterUserText === undefined
				? baseMessages.length - 1
				: findLastUserMessage(baseMessages, contribution.afterUserText);
		if (contribution.afterUserText !== undefined && anchorIndex < 0) continue;
		const existing = insertions.get(anchorIndex);
		if (existing) existing.push(...contribution.messages);
		else insertions.set(anchorIndex, [...contribution.messages]);
	}

	const result = [...(insertions.get(-1) ?? [])];
	for (let index = 0; index < baseMessages.length; index += 1) {
		result.push(baseMessages[index]!, ...(insertions.get(index) ?? []));
	}
	return result;
}
