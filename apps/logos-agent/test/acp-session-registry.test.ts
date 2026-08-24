import assert from "node:assert/strict";
import test from "node:test";
import { AcpSessionRegistry } from "../src/acp/session-registry.ts";
import type { LogosAgent } from "../src/logos-agent.ts";

test("ACP session registry isolates runtimes and closes only the selected session", async () => {
	const shutdowns: number[] = [];
	let nextAgent = 0;
	const registry = new AcpSessionRegistry(async () => {
		const index = nextAgent;
		nextAgent += 1;
		return {
			async shutdown() {
				shutdowns.push(index);
			},
		} as unknown as LogosAgent;
	});
	const first = await registry.create("C:\\first");
	const second = await registry.create("C:\\second");

	assert.notEqual(first.id, second.id);
	assert.equal(await registry.close(first.id), true);
	assert.deepEqual(shutdowns, [0]);
	assert.equal(registry.get(second.id), second);
	await registry.closeAll();
	assert.deepEqual(shutdowns, [0, 1]);
});

test("ACP session registry still shuts down after active prompt cancellation fails", async () => {
	let shutdownCalled = false;
	const registry = new AcpSessionRegistry(async () => ({
		async abort() {
			throw new Error("abort failed");
		},
		async shutdown() {
			shutdownCalled = true;
		},
	}) as unknown as LogosAgent);
	const session = await registry.create("C:\\workspace");
	session.activePrompt = Promise.resolve();

	await assert.rejects(registry.close(session.id), /abort failed/);
	assert.equal(shutdownCalled, true);
});
