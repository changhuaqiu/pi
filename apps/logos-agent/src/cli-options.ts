export type LogosAgentCliOptions =
	| { mode: "interactive" }
	| { mode: "print"; prompt: string; autoApprove: boolean }
	| { mode: "help" }
	| { mode: "version" };

export const logosAgentUsage = [
	"Usage:",
	"  logos-agent",
	"  logos-agent --print <prompt> [--yes]",
	"  logos-agent --version",
	"",
	"Options:",
	"  -p, --print  Run one prompt without the TUI and print only the final answer.",
	"  --yes        Approve tool actions that would normally ask for confirmation.",
	"  -h, --help   Show this help.",
	"  -v, --version  Show the installed version.",
].join("\n");

export function parseLogosAgentCliOptions(args: readonly string[]): LogosAgentCliOptions {
	if (args.length === 0) return { mode: "interactive" };
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		return { mode: "help" };
	}
	if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
		return { mode: "version" };
	}

	const remaining = args.filter((argument) => argument !== "--yes");
	const autoApprove = remaining.length !== args.length;
	if (
		remaining.length === 2 &&
		(remaining[0] === "--print" || remaining[0] === "-p") &&
		remaining[1]?.trim()
	) {
		return { mode: "print", prompt: remaining[1], autoApprove };
	}

	throw new Error(`Invalid arguments\n\n${logosAgentUsage}`);
}
