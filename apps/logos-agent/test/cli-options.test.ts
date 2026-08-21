import assert from "node:assert/strict";
import test from "node:test";
import { parseLogosAgentCliOptions } from "../src/cli-options.ts";

test("CLI defaults to interactive mode", () => {
	assert.deepEqual(parseLogosAgentCliOptions([]), { mode: "interactive" });
});

test("CLI parses isolated print runs with optional approval", () => {
	assert.deepEqual(parseLogosAgentCliOptions(["--print", "inspect the workspace"]), {
		mode: "print",
		prompt: "inspect the workspace",
		autoApprove: false,
	});
	assert.deepEqual(
		parseLogosAgentCliOptions(["--yes", "-p", "fix the failing test"]),
		{
			mode: "print",
			prompt: "fix the failing test",
			autoApprove: true,
		},
	);
});

test("CLI rejects ambiguous print arguments", () => {
	assert.throws(() => parseLogosAgentCliOptions(["--print"]), /Invalid arguments/);
	assert.throws(
		() => parseLogosAgentCliOptions(["--print", "one", "two"]),
		/Invalid arguments/,
	);
});
