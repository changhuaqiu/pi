import { randomUUID } from "node:crypto";
import type { LogosAgent } from "../logos-agent.ts";

export interface AcpLogosSession {
	id: string;
	agent: LogosAgent;
	unsubscribe: () => void;
	activePrompt?: Promise<void>;
	cancelRequested: boolean;
}

export type AcpLogosAgentFactory = (cwd: string) => Promise<LogosAgent>;

export class AcpSessionRegistry {
	private readonly sessions = new Map<string, AcpLogosSession>();
	private readonly createAgent: AcpLogosAgentFactory;

	constructor(createAgent: AcpLogosAgentFactory) {
		this.createAgent = createAgent;
	}

	async create(cwd: string): Promise<AcpLogosSession> {
		const agent = await this.createAgent(cwd);
		const session: AcpLogosSession = {
			id: randomUUID(),
			agent,
			unsubscribe: () => {},
			cancelRequested: false,
		};
		this.sessions.set(session.id, session);
		return session;
	}

	get(id: string): AcpLogosSession | undefined {
		return this.sessions.get(id);
	}

	async close(id: string): Promise<boolean> {
		const session = this.sessions.get(id);
		if (!session) return false;
		this.sessions.delete(id);
		const errors: Error[] = [];
		try {
			session.unsubscribe();
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		}
		if (session.activePrompt) {
			session.cancelRequested = true;
			try {
				await session.agent.abort();
			} catch (error) {
				errors.push(error instanceof Error ? error : new Error(String(error)));
			}
			try {
				await session.activePrompt;
			} catch (error) {
				errors.push(error instanceof Error ? error : new Error(String(error)));
			}
		}
		try {
			await session.agent.shutdown();
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, `ACP session ${id} failed to close`);
		return true;
	}

	async closeAll(): Promise<void> {
		const ids = [...this.sessions.keys()];
		const results = await Promise.allSettled(ids.map(async (id) => await this.close(id)));
		const errors = results.flatMap((result) =>
			result.status === "rejected"
				? [result.reason instanceof Error ? result.reason : new Error(String(result.reason))]
				: [],
		);
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "ACP sessions failed to close");
	}
}
