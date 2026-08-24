import assert from "node:assert/strict";
import test from "node:test";
import { parseLogosAgentCliOptions } from "../src/cli-options.ts";

test("CLI defaults to interactive mode", () => {
	assert.deepEqual(parseLogosAgentCliOptions([]), { mode: "interactive" });
});

test("CLI parses ACP stdio mode", () => {
	assert.deepEqual(parseLogosAgentCliOptions(["acp"]), { mode: "acp" });
});

test("CLI parses isolated print runs with optional approval", () => {
	assert.deepEqual(parseLogosAgentCliOptions(["--print", "inspect the workspace"]), {
		mode: "print",
		prompt: { source: "argument", value: "inspect the workspace" },
		autoApprove: false,
	});
	assert.deepEqual(
		parseLogosAgentCliOptions(["--yes", "-p", "fix the failing test"]),
		{
			mode: "print",
			prompt: { source: "argument", value: "fix the failing test" },
			autoApprove: true,
		},
	);
	assert.deepEqual(parseLogosAgentCliOptions(["--yes", "--print", "-"]), {
		mode: "print",
		prompt: { source: "stdin" },
		autoApprove: true,
	});
});

test("CLI rejects ambiguous print arguments", () => {
	assert.throws(() => parseLogosAgentCliOptions(["--print"]), /Invalid arguments/);
	assert.throws(
		() => parseLogosAgentCliOptions(["--print", "one", "two"]),
		/Invalid arguments/,
	);
});
