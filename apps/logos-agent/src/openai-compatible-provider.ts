import {
	createProvider,
	envApiKeyAuth,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const openAICompatibleProviderId = "openai-compatible";

export interface OpenAICompatibleProviderConfig {
	baseUrl: string;
	modelId: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
}

function normalizeBaseUrl(value: string): string {
	const trimmed = value.trim();
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error("LOGOS_AGENT_BASE_URL must be a valid HTTP(S) URL");
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash
	) {
		throw new Error(
			"LOGOS_AGENT_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment",
		);
	}
	return parsed.toString().replace(/\/+$/u, "");
}

function validatePositiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive safe integer`);
	}
}

export function createOpenAICompatibleProvider(
	config: OpenAICompatibleProviderConfig,
): Provider<"openai-completions"> {
	const baseUrl = normalizeBaseUrl(config.baseUrl);
	const modelId = config.modelId.trim();
	if (
		!modelId ||
		modelId.length > 500 ||
		/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(modelId)
	) {
		throw new Error("LOGOS_AGENT_MODEL must contain safe text with at most 500 characters");
	}
	validatePositiveInteger(config.contextWindow, "LOGOS_AGENT_CONTEXT_WINDOW");
	validatePositiveInteger(config.maxTokens, "LOGOS_AGENT_MAX_TOKENS");
	if (config.maxTokens > config.contextWindow) {
		throw new Error("LOGOS_AGENT_MAX_TOKENS cannot exceed LOGOS_AGENT_CONTEXT_WINDOW");
	}
	const model: Model<"openai-completions"> = {
		id: modelId,
		name: modelId,
		api: "openai-completions",
		provider: openAICompatibleProviderId,
		baseUrl,
		reasoning: config.reasoning,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: config.contextWindow,
		maxTokens: config.maxTokens,
	};
	return createProvider({
		id: openAICompatibleProviderId,
		name: "OpenAI-compatible",
		baseUrl,
		auth: {
			apiKey: envApiKeyAuth("OpenAI-compatible API key", [
				"LOGOS_AGENT_API_KEY",
			]),
		},
		models: [model],
		api: openAICompletionsApi(),
	});
}
