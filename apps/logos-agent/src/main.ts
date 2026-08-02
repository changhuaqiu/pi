#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import packageInfo from "../package.json" with { type: "json" };
import type { ThinkingLevel } from "../../../packages/agent/src/index.ts";
import { HarnessLogosAgent, type LogosAgentConfig } from "./logos-agent.ts";
import { LogosAgentTui } from "./tui-app.ts";
import { resolveWorkspaceRoot } from "./workspace-config.ts";

function readThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	if (value === undefined || !value.trim()) return undefined;
	const normalized = value.trim();
	if (
		normalized !== "off" &&
		normalized !== "minimal" &&
		normalized !== "low" &&
		normalized !== "medium" &&
		normalized !== "high" &&
		normalized !== "xhigh" &&
		normalized !== "max"
	) {
		throw new Error(
			"LOGOS_AGENT_THINKING must be off, minimal, low, medium, high, xhigh, or max",
		);
	}
	return normalized;
}

function readBoolean(value: string | undefined, name: string): boolean | undefined {
	if (value === undefined || !value.trim()) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
	if (normalized === "false" || normalized === "0" || normalized === "no") return false;
	throw new Error(`${name} must be true or false`);
}

function loadPersistentEnvironment(path: string): void {
	try {
		loadEnvFile(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
}

function readConfig(): LogosAgentConfig {
	const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	loadPersistentEnvironment(join(appRoot, ".data", "logos-agent.env"));
	const providerValue = process.env.LOGOS_AGENT_PROVIDER ?? "openai";
	if (providerValue !== "openai" && providerValue !== "anthropic" && providerValue !== "deepseek") {
		throw new Error("LOGOS_AGENT_PROVIDER must be openai, anthropic, or deepseek");
	}
	const repositoryRoot = resolve(appRoot, "..", "..");
	const workspaceRoot = resolveWorkspaceRoot(process.env, process.cwd());
	const defaultModel =
		providerValue === "openai"
			? "gpt-5.5"
			: providerValue === "anthropic"
				? "claude-sonnet-4-6"
				: "deepseek-v4-pro";
	const appVersion = process.env.LOGOS_AGENT_APP_VERSION ?? packageInfo.version;
	const commit = process.env.LOGOS_AGENT_COMMIT?.trim() || undefined;
	const features = [
		...new Set(
			(process.env.LOGOS_AGENT_FEATURES ?? "")
				.split(",")
				.map((feature) => feature.trim())
				.filter(Boolean),
		),
	].sort();
	return {
		workspaceRoot,
		validationRoot: repositoryRoot,
		sessionsRoot: join(appRoot, ".data", "sessions"),
		provider: providerValue,
		modelId: process.env.LOGOS_AGENT_MODEL ?? defaultModel,
		thinkingLevel: readThinkingLevel(process.env.LOGOS_AGENT_THINKING),
		tavilyApiKey: process.env.TAVILY_API_KEY?.trim() || undefined,
		cacheEnvironment: {
			appVersion,
			release:
				process.env.LOGOS_AGENT_RELEASE?.trim() ||
				commit ||
				appVersion,
			commit,
			features,
		},
		observability: {
			endpoint: process.env.LOGOS_AGENT_OBSERVABILITY_ENDPOINT?.trim() || undefined,
			projectName:
				process.env.LOGOS_AGENT_OBSERVABILITY_PROJECT?.trim() || "logos-agent",
			captureContent:
				readBoolean(
					process.env.LOGOS_AGENT_OBSERVABILITY_CAPTURE_CONTENT,
					"LOGOS_AGENT_OBSERVABILITY_CAPTURE_CONTENT",
				) ?? false,
		},
	};
}

async function main(): Promise<void> {
	const config = readConfig();
	const agent = await HarnessLogosAgent.create(config);
	try {
		const app = new LogosAgentTui(agent);
		await app.run();
	} finally {
		await agent.shutdown();
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`logos-agent: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
