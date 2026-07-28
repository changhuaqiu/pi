import assert from "node:assert/strict";
import test from "node:test";
import type { EditProposalSummary } from "../src/controlled-edit-tools.ts";
import { EditApprovalCoordinator, type EditApprovalRequest } from "../src/edit-approval.ts";

const proposal: EditProposalSummary = {
	id: "proposal-1",
	path: "apps/learning-agent/src/app.ts",
	description: "Test edit",
	diff: "--- a/app.ts\n+++ b/app.ts",
	expectedHash: "abc",
	expiresAt: "2099-01-01T00:00:00.000Z",
};

test("approval coordinator resolves an approved request", async () => {
	const coordinator = new EditApprovalCoordinator();
	let published: EditApprovalRequest | undefined;
	const result = coordinator.request(proposal, async (request) => {
		published = request;
	});
	await Promise.resolve();

	assert.ok(published);
	assert.equal(coordinator.respond(published.id, true), true);
	assert.equal(await result, true);
	assert.equal(coordinator.respond(published.id, false), false);
});

test("approval coordinator cancellation rejects a pending request", async () => {
	const coordinator = new EditApprovalCoordinator();
	const result = coordinator.request(proposal, async () => {});
	await Promise.resolve();

	coordinator.cancel();
	assert.equal(await result, false);
});

test("approval coordinator permits only one pending request", async () => {
	const coordinator = new EditApprovalCoordinator();
	const first = coordinator.request(proposal, async () => {});
	await Promise.resolve();

	await assert.rejects(coordinator.request(proposal, async () => {}), /already pending/);
	coordinator.cancel();
	assert.equal(await first, false);
});
