import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("print mode sends Chat Completions to a configurable endpoint", async () => {
	const prompt = "first line\n\nsecond line with a question?";
	const requests: unknown[] = [];
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		response.writeHead(200, {
			"content-type": "text/event-stream",
			connection: "keep-alive",
		});
		const base = {
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 1,
			model: "evaluation-model",
		};
		response.end(
			[
				{
					...base,
					choices: [
						{
							index: 0,
							delta: { role: "assistant", content: "你好" },
							finish_reason: null,
						},
					],
				},
				{
					...base,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: {
						prompt_tokens: 10,
						completion_tokens: 2,
						total_tokens: 12,
					},
				},
			]
				.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
				.join("") + "data: [DONE]\n\n",
		);
	});
	await new Promise<void>((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const workspace = await mkdtemp(join(tmpdir(), "logos-agent-cli-test-"));
	try {
		const result = await new Promise<{
			code: number | null;
			stdout: string;
			stderr: string;
		}>((resolvePromise, rejectPromise) => {
			const child = spawn(
				process.execPath,
				[fileURLToPath(new URL("../src/main.ts", import.meta.url)), "--print", "-"],
				{
					cwd: workspace,
					env: {
						...process.env,
						LOGOS_AGENT_PROVIDER: "openai-compatible",
						LOGOS_AGENT_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
						LOGOS_AGENT_API_KEY: "test-key",
						LOGOS_AGENT_MODEL: "evaluation-model",
						LOGOS_AGENT_CONTEXT_WINDOW: "32768",
						LOGOS_AGENT_MAX_TOKENS: "1024",
						LOGOS_AGENT_REASONING: "false",
						LOGOS_AGENT_LOAD_PERSISTENT_ENV: "false",
						LOGOS_AGENT_WORKSPACE: ".",
						LOGOS_AGENT_OBSERVABILITY_ENDPOINT: "",
					},
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				},
			);
			child.stdin.end(prompt);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
			child.once("error", rejectPromise);
			child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
		});
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stdout, "你好\n");
		assert.equal(requests.length, 1);
		assert.equal(
			(requests[0] as { model?: unknown }).model,
			"evaluation-model",
		);
		const messages = (requests[0] as {
			messages?: Array<{ role?: unknown; content?: unknown }>;
		}).messages;
		assert.ok(messages);
		assert.deepEqual(messages.at(-1), {
			role: "user",
			content: [{ type: "text", text: prompt }],
		});
	} finally {
		await rm(workspace, { recursive: true, force: true });
		server.closeAllConnections();
		await new Promise<void>((resolvePromise, rejectPromise) => {
			server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
		});
	}
});

test("print mode rejects empty stdin", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "logos-agent-cli-empty-test-"));
	try {
		const result = await new Promise<{
			code: number | null;
			stderr: string;
		}>((resolvePromise, rejectPromise) => {
			const child = spawn(
				process.execPath,
				[fileURLToPath(new URL("../src/main.ts", import.meta.url)), "--print", "-"],
				{
					cwd: workspace,
					env: {
						...process.env,
						LOGOS_AGENT_LOAD_PERSISTENT_ENV: "false",
						LOGOS_AGENT_WORKSPACE: ".",
						LOGOS_AGENT_OBSERVABILITY_ENDPOINT: "",
					},
					stdio: ["pipe", "ignore", "pipe"],
					windowsHide: true,
				},
			);
			child.stdin.end();
			let stderr = "";
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
			child.once("error", rejectPromise);
			child.once("close", (code) => resolvePromise({ code, stderr }));
		});
		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /No prompt received on stdin/);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});
