import assert from "node:assert/strict";
import test from "node:test";
import {
	createBuzzCliTool,
	createNodeBuzzCliOperations,
	type BuzzCliOperations,
} from "../src/buzz-cli-tool.ts";

test("buzz_cli forwards argv and stdin without exposing message content in progress details", async () => {
	const calls: Array<{ args: string[]; stdin?: string }> = [];
	const operations: BuzzCliOperations = {
		async run(request) {
			calls.push(request);
			return {
				exitCode: 0,
				stdout: "sent",
				stderr: "",
				truncated: false,
				durationMs: 8,
			};
		},
	};
	const updates: string[] = [];
	const result = await createBuzzCliTool(operations).execute(
		"buzz-1",
		{
			args: ["messages", "send", "--channel", "engineering", "--content", "-"],
			stdin: "private multiline result",
		},
		undefined,
		(update) => updates.push(`${update.details.stage}:${update.details.command}`),
	);

	assert.deepEqual(calls, [{
		args: ["messages", "send", "--channel", "engineering", "--content", "-"],
		stdin: "private multiline result",
	}]);
	assert.deepEqual(updates, ["validating:buzz messages", "running:buzz messages"]);
	assert.equal(result.details.command, "buzz messages");
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /sent/);
});

test("buzz_cli rejects shell-shaped or oversized input before invoking its adapter", async () => {
	let called = false;
	const tool = createBuzzCliTool({
		async run() {
			called = true;
			throw new Error("unexpected");
		},
	});

	await assert.rejects(tool.execute("buzz-2", { args: ["messages\0send"] }), /NUL bytes/);
	await assert.rejects(
		tool.execute("buzz-3", { args: Array.from({ length: 64 }, () => "x".repeat(600)) }),
		/32768-byte limit/,
	);
	assert.equal(called, false);
});

test("node buzz_cli adapter uses argv and stdin without a shell", async () => {
	const script = [
		"let input = '';",
		"process.stdin.setEncoding('utf8');",
		"process.stdin.on('data', chunk => input += chunk);",
		"process.stdin.on('end', () => process.stdout.write(JSON.stringify({ args: process.argv.slice(1), input })));",
	].join(" ");
	const operations = createNodeBuzzCliOperations({ command: process.execPath, cwd: import.meta.dirname });
	const result = await operations.run({ args: ["-e", script, "a b", "$(ignored)"], stdin: "hello" });

	assert.equal(result.exitCode, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { args: ["a b", "$(ignored)"], input: "hello" });
});
