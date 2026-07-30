import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	LearningApprovalCard,
	LearningSessionPicker,
	LearningToolPolicyPicker,
} from "../src/learning-tui-components.ts";

test("approval card makes the complete diff reachable without exceeding width", () => {
	const diff = Array.from({ length: 50 }, (_, index) => `+line ${index}`).join("\n");
	const card = new LearningApprovalCard({
		kind: "edit",
		proposal: {
			id: "proposal-1",
			kind: "replace",
			path: "apps/learning-agent/src/tui-app.ts",
			description: "Make the learning loop visible",
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

test("approval card wraps long diff lines so their tail remains reachable", () => {
	const tail = "UNIQUE_REVIEW_TAIL";
	const card = new LearningApprovalCard({
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
	const card = new LearningApprovalCard({
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

test("session picker searches learning prompts and keeps narrow output bounded", () => {
	const picker = new LearningSessionPicker(
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
	const picker = new LearningToolPolicyPicker(
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
