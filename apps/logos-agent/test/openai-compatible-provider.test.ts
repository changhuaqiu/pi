import assert from "node:assert/strict";
import test from "node:test";
import {
	createOpenAICompatibleProvider,
	openAICompatibleProviderId,
} from "../src/openai-compatible-provider.ts";

test("OpenAI-compatible provider exposes one runtime model", () => {
	const provider = createOpenAICompatibleProvider({
		baseUrl: "http://127.0.0.1:1234/openai/v1/",
		modelId: "evaluation-model",
		contextWindow: 65_536,
		maxTokens: 8_192,
		reasoning: true,
	});
	assert.equal(provider.id, openAICompatibleProviderId);
	assert.equal(provider.baseUrl, "http://127.0.0.1:1234/openai/v1");
	assert.deepEqual(provider.getModels(), [
		{
			id: "evaluation-model",
			name: "evaluation-model",
			api: "openai-completions",
			provider: openAICompatibleProviderId,
			baseUrl: "http://127.0.0.1:1234/openai/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 65_536,
			maxTokens: 8_192,
		},
	]);
});

test("OpenAI-compatible provider rejects unsafe or inconsistent configuration", () => {
	const valid = {
		baseUrl: "https://example.com/v1",
		modelId: "model",
		contextWindow: 8_192,
		maxTokens: 4_096,
		reasoning: false,
	};
	assert.throws(
		() => createOpenAICompatibleProvider({ ...valid, baseUrl: "file:///tmp/model" }),
		/HTTP\(S\)/,
	);
	assert.throws(
		() => createOpenAICompatibleProvider({ ...valid, modelId: "bad\nmodel" }),
		/safe text/,
	);
	assert.throws(
		() =>
			createOpenAICompatibleProvider({
				...valid,
				contextWindow: 1_024,
				maxTokens: 2_048,
			}),
		/cannot exceed/,
	);
});
