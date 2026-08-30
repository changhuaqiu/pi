import type {
	JsonlSessionMetadata,
	Session,
	SessionMetadata,
} from "../../../packages/agent/src/index.ts";
import {
	decodeExecutionEvent,
	EXECUTION_EVENT_VERSION,
	type ExecutionEvent,
	type ExecutionJournal,
} from "./execution-journal.ts";

export const EXECUTION_EVENT_CUSTOM_TYPE = "execution_event";

export class SessionExecutionJournal<
	TMetadata extends SessionMetadata = JsonlSessionMetadata,
> implements ExecutionJournal {
	private readonly session: Session<TMetadata>;

	constructor(session: Session<TMetadata>) {
		this.session = session;
	}

	async append(event: ExecutionEvent): Promise<void> {
		await this.session.appendCustomEntry(EXECUTION_EVENT_CUSTOM_TYPE, event);
	}

	async read(): Promise<readonly ExecutionEvent[]> {
		const events: ExecutionEvent[] = [];
		for (const entry of await this.session.getEntries()) {
			if (
				entry.type !== "custom" ||
				entry.customType !== EXECUTION_EVENT_CUSTOM_TYPE
			) {
				continue;
			}
			if (
				typeof entry.data !== "object" ||
				entry.data === null ||
				!("version" in entry.data) ||
				entry.data.version !== EXECUTION_EVENT_VERSION
			) {
				throw new Error(
					`Unsupported Execution event in Session entry ${entry.id}`,
				);
			}
			events.push(decodeExecutionEvent(entry.data));
		}
		return events;
	}
}
