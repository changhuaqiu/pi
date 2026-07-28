import { randomUUID } from "node:crypto";
import type { EditProposalSummary } from "./controlled-edit-tools.ts";

export interface EditApprovalRequest {
	id: string;
	proposal: EditProposalSummary;
}

interface PendingApproval {
	request: EditApprovalRequest;
	resolve: (approved: boolean) => void;
}

export class EditApprovalCoordinator {
	private pending?: PendingApproval;

	async request(
		proposal: EditProposalSummary,
		publish: (request: EditApprovalRequest) => Promise<void>,
	): Promise<boolean> {
		if (this.pending) throw new Error("Another edit approval is already pending");
		const request = { id: randomUUID(), proposal };
		let resolveDecision = (_approved: boolean) => {};
		const decision = new Promise<boolean>((resolve) => {
			resolveDecision = resolve;
		});
		this.pending = { request, resolve: resolveDecision };
		try {
			await publish(request);
			return await decision;
		} finally {
			if (this.pending?.request.id === request.id) this.pending = undefined;
		}
	}

	respond(requestId: string, approved: boolean): boolean {
		if (this.pending?.request.id !== requestId) return false;
		const pending = this.pending;
		this.pending = undefined;
		pending.resolve(approved);
		return true;
	}

	cancel(): void {
		const pending = this.pending;
		this.pending = undefined;
		pending?.resolve(false);
	}
}
