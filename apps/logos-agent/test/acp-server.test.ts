import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { LogosAcpServer } from "../src/acp/server.ts";
import type { LogosAgent, LogosAgentUiEvent } from "../src/logos-agent.ts";

function assistantMessage(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

class FakeAgent {
	readonly prompts: string[] = [];
	shutdownCount = 0;
	abortCount = 0;
	approval?: boolean;
	private listener?: (event: LogosAgentUiEvent) => void | Promise<void>;
	private promptResolver?: (message: AssistantMessage) => void;

	asLogosAgent(): LogosAgent {
		return this as unknown as LogosAgent;
	}

	subscribe(listener: (event: LogosAgentUiEvent) => void | Promise<void>): () => void {
		this.listener = listener;
		return () => {
			this.listener = undefined;
		};
	}

	async prompt(text: string): Promise<AssistantMessage> {
		this.prompts.push(text);
		await this.listener?.({
			type: "message_update",
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "streamed" },
		});
		return await new Promise<AssistantMessage>((resolve) => {
			this.promptResolver = resolve;
		});
	}

	async requestApproval(): Promise<void> {
		await this.listener?.({
			type: "approval_request",
			request: {
				id: "approval-1",
				subject: { kind: "tool", toolName: "buzz_cli", capabilities: [] },
			},
		});
	}

	respondToApproval(requestId: string, approved: boolean): boolean {
		if (requestId !== "approval-1") return false;
		this.approval = approved;
		return true;
	}

	respondToQuestion(): { accepted: boolean } {
		return { accepted: true };
	}

	finish(stopReason: AssistantMessage["stopReason"] = "stop"): void {
		const resolve = this.promptResolver;
		assert.ok(resolve);
		this.promptResolver = undefined;
		resolve(assistantMessage(stopReason));
	}

	async abort(): Promise<void> {
		this.abortCount += 1;
		if (this.promptResolver) this.finish("aborted");
	}

	async shutdown(): Promise<void> {
		this.shutdownCount += 1;
	}
}

interface RpcMessage {
	id?: string | number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: Record<string, unknown>;
}

class RpcHarness {
	readonly input = new PassThrough();
	readonly messages: RpcMessage[] = [];
	readonly output = new Writable({
		write: (chunk: Buffer, _encoding, callback) => {
			this.buffer += chunk.toString("utf8");
			for (;;) {
				const newline = this.buffer.indexOf("\n");
				if (newline < 0) break;
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				this.messages.push(JSON.parse(line) as RpcMessage);
			}
			callback();
		},
	});
	private buffer = "";

	send(message: unknown): void {
		this.input.write(`${JSON.stringify(message)}\n`);
	}

	async waitFor(predicate: (message: RpcMessage) => boolean): Promise<RpcMessage> {
		const deadline = Date.now() + 2_000;
		for (;;) {
			const found = this.messages.find(predicate);
			if (found) return found;
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for RPC message: ${JSON.stringify(this.messages)}`);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
}

test("ACP server matches the Buzz initialize, session, streaming, permission, and cancel flow", async () => {
	const agent = new FakeAgent();
	const rpc = new RpcHarness();
	const server = new LogosAcpServer({
		input: rpc.input,
		output: rpc.output,
		createAgent: async () => agent.asLogosAgent(),
		agentInfo: { name: "logos-agent", title: "Logos Agent", version: "test" },
		log: () => {},
	});
	const running = server.run();

	rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2 } });
	const initialized = await rpc.waitFor((message) => message.id === 1);
	assert.equal(initialized.result?.protocolVersion, 1);

	rpc.send({
		jsonrpc: "2.0",
		id: 2,
		method: "session/new",
		params: { cwd: import.meta.dirname, mcpServers: [] },
	});
	const created = await rpc.waitFor((message) => message.id === 2);
	const sessionId = created.result?.sessionId;
	assert.equal(typeof sessionId, "string");

	rpc.send({
		jsonrpc: "2.0",
		id: 3,
		method: "session/prompt",
		params: { sessionId, prompt: [{ type: "text", text: "inspect Buzz" }] },
	});
	const update = await rpc.waitFor((message) => message.method === "session/update");
	assert.equal(update.params?.sessionId, sessionId);
	assert.deepEqual(update.params?.update, {
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text: "streamed" },
	});

	await agent.requestApproval();
	const permission = await rpc.waitFor((message) => message.method === "session/request_permission");
	assert.equal(permission.params?.sessionId, sessionId);
	rpc.send({
		jsonrpc: "2.0",
		id: permission.id,
		result: { outcome: { outcome: "selected", optionId: "allow-once" } },
	});
	await rpc.waitFor(() => agent.approval === true);

	rpc.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
	const cancelled = await rpc.waitFor((message) => message.id === 3);
	assert.equal(cancelled.result?.stopReason, "cancelled");
	assert.equal(agent.abortCount, 1);
	assert.deepEqual(agent.prompts, ["inspect Buzz"]);

	rpc.send({ jsonrpc: "2.0", id: 4, method: "session/close", params: { sessionId } });
	await rpc.waitFor((message) => message.id === 4);
	assert.equal(agent.shutdownCount, 1);
	rpc.input.end();
	await running;
});

test("ACP server rejects relative session roots and duplicate initialize calls", async () => {
	const rpc = new RpcHarness();
	const server = new LogosAcpServer({
		input: rpc.input,
		output: rpc.output,
		createAgent: async () => new FakeAgent().asLogosAgent(),
		agentInfo: { name: "logos-agent", title: "Logos Agent", version: "test" },
		log: () => {},
	});
	const running = server.run();
	rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2 } });
	await rpc.waitFor((message) => message.id === 1);
	rpc.send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: 2 } });
	assert.equal((await rpc.waitFor((message) => message.id === 2)).error?.code, -32002);
	rpc.send({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: "." } });
	assert.equal((await rpc.waitFor((message) => message.id === 3)).error?.code, -32602);
	rpc.input.end();
	await running;
});
