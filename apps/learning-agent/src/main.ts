#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import packageInfo from "../package.json" with { type: "json" };
import { HarnessLearningAgent, type LearningAgentConfig } from "./learning-agent.ts";
import { LearningAgentTui } from "./tui-app.ts";

function readConfig(): LearningAgentConfig {
	const providerValue = process.env.LEARNING_AGENT_PROVIDER ?? "openai";
	if (providerValue !== "openai" && providerValue !== "anthropic" && providerValue !== "deepseek") {
		throw new Error("LEARNING_AGENT_PROVIDER must be openai, anthropic, or deepseek");
	}
	const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const workspaceRoot = resolve(process.env.LEARNING_AGENT_WORKSPACE ?? process.cwd());
	const defaultModel =
		providerValue === "openai"
			? "gpt-5.5"
			: providerValue === "anthropic"
				? "claude-sonnet-4-6"
				: "deepseek-v4-pro";
	const appVersion = process.env.LEARNING_AGENT_APP_VERSION ?? packageInfo.version;
	const commit = process.env.LEARNING_AGENT_COMMIT?.trim() || undefined;
	const features = [
		...new Set(
			(process.env.LEARNING_AGENT_FEATURES ?? "")
				.split(",")
				.map((feature) => feature.trim())
				.filter(Boolean),
		),
	].sort();
	return {
		workspaceRoot,
		sessionsRoot: join(appRoot, ".data", "sessions"),
		provider: providerValue,
		modelId: process.env.LEARNING_AGENT_MODEL ?? defaultModel,
		cacheEnvironment: {
			appVersion,
			release:
				process.env.LEARNING_AGENT_RELEASE?.trim() ||
				commit ||
				appVersion,
			commit,
			features,
		},
	};
}

async function main(): Promise<void> {
	const config = readConfig();
	const agent = await HarnessLearningAgent.create(config);
	const app = new LearningAgentTui(agent);
	await app.run();
}

main().catch((error: unknown) => {
	process.stderr.write(`learning-agent: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
