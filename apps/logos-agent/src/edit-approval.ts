import { randomUUID } from "node:crypto";
import type { EditProposalSummary } from "./controlled-edit-tools.ts";

export interface ApprovalRequest<TSubject> {
	id: string;
	subject: TSubject;
}

interface PendingApproval<TSubject> {
	request: ApprovalRequest<TSubject>;
	resolve: (approved: boolean) => void;
}

export class ApprovalCoordinator<TSubject> {
	private pending?: PendingApproval<TSubject>;

	async request(
		subject: TSubject,
		publish: (request: ApprovalRequest<TSubject>) => Promise<void>,
	): Promise<boolean> {
		if (this.pending) throw new Error("Another approval is already pending");
		const request = { id: randomUUID(), subject };
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

export interface EditApprovalRequest {
	id: string;
	proposal: EditProposalSummary;
}

export class EditApprovalCoordinator {
	private readonly coordinator = new ApprovalCoordinator<EditProposalSummary>();

	async request(
		proposal: EditProposalSummary,
		publish: (request: EditApprovalRequest) => Promise<void>,
	): Promise<boolean> {
		return await this.coordinator.request(proposal, async (request) => {
			await publish({ id: request.id, proposal: request.subject });
		});
	}

	respond(requestId: string, approved: boolean): boolean {
		return this.coordinator.respond(requestId, approved);
	}

	cancel(): void {
		this.coordinator.cancel();
	}
}
