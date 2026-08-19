import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	LogosApprovalCard,
	LogosSessionPicker,
	LogosToolPolicyPicker,
} from "../src/logos-tui-components.ts";
import { governLogosApprovalSubject } from "../src/logos-tools.ts";

test("approval card makes the complete diff reachable without exceeding width", () => {
	const diff = Array.from({ length: 50 }, (_, index) => `+line ${index}`).join("\n");
	const card = new LogosApprovalCard({
		kind: "edit",
		proposal: {
			id: "proposal-1",
			kind: "replace",
			path: "apps/logos-agent/src/tui-app.ts",
			description: "Make the logos loop visible",
			diff,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		},
	});

	const firstPage = card.render(48);
	assert.match(firstPage.join("\n"), /1-12\/50/);
	card.scrollToEnd();
	const lastPage = card.render(48);
	assert.match(lastPage.join("\n"), /39-50\/50/);
	assert.equal(card.getScrollOffset(), 38);
	for (const line of [...firstPage, ...lastPage]) {
		assert.ok(visibleWidth(line) <= 48, `${visibleWidth(line)} exceeds 48`);
	}
});

test("edit approval shows a bounded CodeGraph impact summary", () => {
	const card = new LogosApprovalCard({
		kind: "edit",
		proposal: {
			id: "proposal-impact",
			kind: "replace",
			path: "src/progress.ts",
			diff: "-old\n+new",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		},
		impact: {
			status: "available",
			freshness: "fresh",
			symbol: { name: "apply", file: "src/progress.ts", line: 10 },
			affected: [{ name: "render", file: "src/tui.ts", line: 42 }],
			totalAffected: 1,
		},
	});

	assert.match(card.render(100).join("\n"), /Impact: apply affects 1 indexed symbol: src\/tui.ts:42/);
});

test("approval card wraps long diff lines so their tail remains reachable", () => {
	const tail = "UNIQUE_REVIEW_TAIL";
	const card = new LogosApprovalCard({
		kind: "edit",
		proposal: {
			id: "proposal-long-line",
			kind: "replace",
			path: "src/long-line.ts",
			diff: `+${"long-content-".repeat(20)}${tail}`,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		},
	});

	card.render(40);
	card.scrollToEnd();
	const lastPage = card.render(40);
	assert.match(lastPage.join("\n"), new RegExp(tail));
	for (const line of lastPage) {
		assert.ok(visibleWidth(line) <= 40, `${visibleWidth(line)} exceeds 40`);
	}
});

test("approval card preserves whitespace at hard-wrap boundaries", () => {
	const card = new LogosApprovalCard({
		kind: "edit",
		proposal: {
			id: "proposal-whitespace",
			kind: "replace",
			path: "src/whitespace.ts",
			diff: "+abc  X",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		},
	});

	const page = card.render(10);
	assert.ok(
		page.some((line) => line.includes("+abc  ")),
		"expected both boundary spaces to remain visible in the wrapped diff",
	);
	assert.ok(page.some((line) => line.includes("X")));
});

test("directory approval shows every target and no-shell warning", () => {
	const paths = [
		"src/core",
		"src/components",
		"src/hooks",
		"src/styles",
	];
	const card = new LogosApprovalCard({
		kind: "directories",
		paths,
	});
	const output = card.render(60).join("\n");

	for (const path of paths) assert.match(output, new RegExp(path));
	assert.match(output, /no shell command/i);
	for (const line of card.render(36)) {
		assert.ok(visibleWidth(line) <= 36, `${visibleWidth(line)} exceeds 36`);
	}
});

test("directory approval makes all approved paths reachable", () => {
	const paths = Array.from(
		{ length: 20 },
		(_, index) => `src/generated/directory-${index}`,
	);
	const card = new LogosApprovalCard({
		kind: "directories",
		paths,
	});

	assert.doesNotMatch(card.render(44).join("\n"), /directory-19/);
	card.scrollToEnd();
	assert.match(card.render(44).join("\n"), /directory-19/);
	assert.ok(card.getScrollOffset() > 0);
});

test("command approval shows exact npm action, package script, limits, and risk", () => {
	const card = new LogosApprovalCard({
		kind: "command",
		command: {
			operation: "npm_run",
			command: "npm run dev -- --host 127.0.0.1",
			cwd: "web",
			mode: "service",
			timeoutMs: 1_800_000,
			startupWaitMs: 3_000,
			scripts: [
				{ name: "predev", command: "node check.js" },
				{ name: "dev", command: "vite --host 0.0.0.0" },
				{ name: "postdev", command: "node cleanup.js" },
			],
			risks: [
				"executes a local project command",
				"the package.json script can read or write files and access the network",
				"starts a managed long-running process",
			],
		},
	});
	const output = card.render(64).join("\n");

	assert.match(output, /npm run dev/);
	assert.match(output, /vite --host 0\.0\.0\.0/);
	assert.match(output, /predev/);
	assert.match(output, /postdev/);
	assert.match(output, /Mode: service/);
	assert.match(output, /1800000ms \(1800\.000s\)/);
	assert.match(output, /Startup observation: 3000ms/);
	assert.match(output, /not sandboxed/i);
	for (const line of card.render(36)) {
		assert.ok(visibleWidth(line) <= 36, `${visibleWidth(line)} exceeds 36`);
	}
});

test("process-stop approval identifies the exact managed process tree", () => {
	const card = new LogosApprovalCard({
		kind: "process_stop",
		process: {
			processId: "process-123",
			command: "npm run dev --",
			cwd: ".",
			status: "running",
			osPid: 456,
			startedAt: new Date(0).toISOString(),
			durationMs: 1_000,
			truncated: false,
			urls: ["http://localhost:3000"],
		},
	});
	const output = card.render(64).join("\n");

	assert.match(output, /process-123/);
	assert.match(output, /npm run dev/);
	assert.match(output, /descendants will be terminated/i);
});

test("operation approval is sanitized, bounded, and rendered generically", () => {
	const workspaceRoot = "C:\\workspace";
	const subject = governLogosApprovalSubject({
		kind: "operation",
		title: "\u001b[31mDeploy service\u001b[0m",
		action: "business.deployment.execute",
		target: `${workspaceRoot}\\service-a`,
		facts: Array.from({ length: 20 }, (_, index) => ({
			label: `Fact ${index}`,
			value: index === 0
				? "to\u200bken=private"
				: index === 1
					? 'password="correct horse battery staple"'
					: index === 2
						? "secret='alpha beta gamma'"
						: index === 3
							? 'password="secret' + "\\"
							: index === 4
								? "secret='private" + "\\"
								: `value-${index}`,
		})),
		warning: "Production change",
	}, workspaceRoot);
	assert.equal(subject.kind, "operation");
	if (subject.kind !== "operation") assert.fail("expected operation approval");
	assert.equal(subject.facts.length, 12);
	assert.equal(subject.facts[0]?.value, "token=<redacted>");
	assert.equal(subject.facts[1]?.value, 'password="<redacted>"');
	assert.equal(subject.facts[2]?.value, "secret='<redacted>'");
	assert.equal(subject.facts[3]?.value, 'password="<redacted>"');
	assert.equal(subject.facts[4]?.value, "secret='<redacted>'");
	assert.match(subject.target, /<workspace>/);
	assert.doesNotMatch(subject.title, /\u001b/);

	const card = new LogosApprovalCard(subject);
	const output = card.render(64).join("\n");
	assert.match(output, /Deploy service/);
	assert.match(output, /business\.deployment\.execute/);
	assert.match(output, /token=<redacted>/);
	card.scrollToEnd();
	assert.match(card.render(64).join("\n"), /Warning: Production change/);
	for (const line of card.render(36)) {
		assert.ok(visibleWidth(line) <= 36, `${visibleWidth(line)} exceeds 36`);
	}
});

test("operation approval keeps target and warning tails reachable in a fixed viewport", () => {
	const targetTail = "TARGET_REVIEW_TAIL";
	const warningTail = "WARNING_REVIEW_TAIL";
	const card = new LogosApprovalCard({
		kind: "operation",
		title: "Deploy service",
		action: "business.deployment.execute",
		target: `service-${"target-segment-".repeat(24)}${targetTail}`,
		facts: [],
		warning: `production-${"risk-segment-".repeat(20)}${warningTail}`,
	});

	const firstPage = card.render(40);
	assert.equal(firstPage.length, 16);
	assert.doesNotMatch(firstPage.join("\n"), new RegExp(warningTail));
	assert.match(firstPage.join("\n"), /\[y\] approve once/);
	card.scrollToEnd();
	const lastPage = card.render(40);
	assert.equal(lastPage.length, 16);
	const compactLastPage = lastPage.join("\n").replace(/\s+/g, "");
	assert.match(compactLastPage, new RegExp(targetTail));
	assert.match(compactLastPage, new RegExp(warningTail));
	assert.match(lastPage.join("\n"), /\[y\] approve once/);
	for (const line of [...firstPage, ...lastPage]) {
		assert.ok(visibleWidth(line) <= 40, `${visibleWidth(line)} exceeds 40`);
	}
});

test("command approval makes the complete literal argument list reachable", () => {
	const tail = "REVIEW_ARGUMENT_TAIL";
	const card = new LogosApprovalCard({
		kind: "command",
		command: {
			operation: "npm_run",
			command: `npm run test -- ${"argument-".repeat(100)}${tail}`,
			cwd: ".",
			mode: "foreground",
			timeoutMs: 60_000,
			startupWaitMs: 0,
			scripts: [{ name: "test", command: "vitest" }],
			risks: ["executes a local project command"],
		},
	});

	assert.doesNotMatch(card.render(44).join("\n"), new RegExp(tail));
	card.scrollToEnd();
	assert.match(card.render(44).join("\n"), new RegExp(tail));
});

test("session picker searches logos prompts and keeps narrow output bounded", () => {
	const picker = new LogosSessionPicker(
		[
			{
				id: "session-alpha",
				path: "alpha.jsonl",
				messageCount: 12,
				createdAt: "2026-07-29T10:00:00.000Z",
				preview: "Study controlled edit approvals",
			},
			{
				id: "session-beta",
				path: "beta.jsonl",
				messageCount: 4,
				createdAt: "2026-07-28T10:00:00.000Z",
				preview: "Investigate prompt caching",
			},
		],
		"session-alpha",
	);

	picker.setQuery("caching");
	assert.equal(picker.getFilteredCount(), 1);
	assert.match(picker.render(100).join("\n"), /prompt caching/);
	const lines = picker.render(36);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 36, `${visibleWidth(line)} exceeds 36`);
	}
});

test("tool policy picker exposes explicit model capability control", () => {
	const changes: Array<{ name: string; permission: string | undefined }> = [];
	const picker = new LogosToolPolicyPicker(
		[
			{
				name: "read_file",
				capabilities: [{ kind: "fs.read", scope: "workspace" }],
				defaultPermission: "allow",
				effectivePermission: "allow",
				active: true,
			},
		],
		(name, permission) => changes.push({ name, permission }),
		() => {},
	);

	picker.handleInput(" ");
	assert.deepEqual(changes, [{ name: "read_file", permission: "ask" }]);
	assert.match(picker.render(60).join("\n"), /fs\.read: workspace/);
});
