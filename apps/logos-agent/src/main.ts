#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import packageInfo from "../package.json" with { type: "json" };
import type { ThinkingLevel } from "../../../packages/agent/src/index.ts";
import {
	logosAgentUsage,
	parseLogosAgentCliOptions,
} from "./cli-options.ts";
import { runHeadlessPrompt } from "./headless.ts";
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

function readPositiveInteger(
	value: string | undefined,
	name: string,
	fallback: number,
): number {
	if (value === undefined || !value.trim()) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

function readRequired(value: string | undefined, name: string): string {
	const normalized = value?.trim();
	if (!normalized) throw new Error(`${name} is required`);
	return normalized;
}

function loadPersistentEnvironment(path: string): void {
	try {
		loadEnvFile(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
}

function readConfig(options: { sessionsRoot?: string } = {}): LogosAgentConfig {
	const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	if (
		readBoolean(
			process.env.LOGOS_AGENT_LOAD_PERSISTENT_ENV,
			"LOGOS_AGENT_LOAD_PERSISTENT_ENV",
		) ?? true
	) {
		loadPersistentEnvironment(join(appRoot, ".data", "logos-agent.env"));
	}
	const providerValue = process.env.LOGOS_AGENT_PROVIDER ?? "openai";
	if (
		providerValue !== "openai" &&
		providerValue !== "anthropic" &&
		providerValue !== "deepseek" &&
		providerValue !== "openai-compatible"
	) {
		throw new Error(
			"LOGOS_AGENT_PROVIDER must be openai, anthropic, deepseek, or openai-compatible",
		);
	}
	const repositoryRoot = resolve(appRoot, "..", "..");
	const workspaceRoot = resolveWorkspaceRoot(process.env, process.cwd());
	const defaultModel =
		providerValue === "openai"
			? "gpt-5.5"
			: providerValue === "anthropic"
				? "claude-sonnet-4-6"
				: providerValue === "deepseek"
					? "deepseek-v4-pro"
					: undefined;
	const modelId = process.env.LOGOS_AGENT_MODEL?.trim() || defaultModel;
	if (!modelId) throw new Error("LOGOS_AGENT_MODEL is required");
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
		sessionsRoot: options.sessionsRoot ?? join(appRoot, ".data", "sessions"),
		provider: providerValue,
		modelId,
		...(providerValue === "openai-compatible"
			? {
					openAICompatible: {
						baseUrl: readRequired(
							process.env.LOGOS_AGENT_BASE_URL,
							"LOGOS_AGENT_BASE_URL",
						),
						modelId,
						contextWindow: readPositiveInteger(
							process.env.LOGOS_AGENT_CONTEXT_WINDOW,
							"LOGOS_AGENT_CONTEXT_WINDOW",
							131_072,
						),
						maxTokens: readPositiveInteger(
							process.env.LOGOS_AGENT_MAX_TOKENS,
							"LOGOS_AGENT_MAX_TOKENS",
							8_192,
						),
						reasoning:
							readBoolean(
								process.env.LOGOS_AGENT_REASONING,
								"LOGOS_AGENT_REASONING",
							) ?? false,
					},
				}
			: {}),
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

function attachAbortSignals(agent: HarnessLogosAgent): () => void {
	let aborting = false;
	const handleAbort = (): void => {
		if (aborting) return;
		aborting = true;
		void agent.abort().catch((error: unknown) => {
			process.stderr.write(
				`logos-agent: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		});
	};
	process.once("SIGINT", handleAbort);
	process.once("SIGTERM", handleAbort);
	return () => {
		process.removeListener("SIGINT", handleAbort);
		process.removeListener("SIGTERM", handleAbort);
	};
}

async function runInteractive(): Promise<void> {
	const agent = await HarnessLogosAgent.create(readConfig());
	try {
		const app = new LogosAgentTui(agent);
		await app.run();
	} finally {
		await agent.shutdown();
	}
}

async function runPrint(prompt: string, autoApprove: boolean): Promise<void> {
	const sessionsRoot = await mkdtemp(join(tmpdir(), "logos-agent-print-"));
	let agent: HarnessLogosAgent | undefined;
	try {
		agent = await HarnessLogosAgent.create(readConfig({ sessionsRoot }));
		const detachAbortSignals = attachAbortSignals(agent);
		try {
			const output = await runHeadlessPrompt(agent, prompt, { autoApprove });
			process.stdout.write(`${output}\n`);
		} finally {
			detachAbortSignals();
		}
	} finally {
		try {
			await agent?.shutdown();
		} finally {
			await rm(sessionsRoot, { recursive: true, force: true });
		}
	}
}

async function main(): Promise<void> {
	const options = parseLogosAgentCliOptions(process.argv.slice(2));
	if (options.mode === "help") {
		process.stdout.write(`${logosAgentUsage}\n`);
		return;
	}
	if (options.mode === "version") {
		process.stdout.write(`${packageInfo.version}\n`);
		return;
	}
	if (options.mode === "print") {
		let prompt: string;
		if (options.prompt.source === "stdin") {
			const chunks: Buffer[] = [];
			for await (const chunk of process.stdin) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			prompt = Buffer.concat(chunks).toString("utf8");
			if (!prompt.trim()) throw new Error("No prompt received on stdin");
		} else {
			prompt = options.prompt.value;
		}
		await runPrint(prompt, options.autoApprove);
		return;
	}
	await runInteractive();
}

main().catch((error: unknown) => {
	process.stderr.write(`logos-agent: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
