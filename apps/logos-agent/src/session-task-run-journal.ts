import type {
	JsonlSessionMetadata,
	Session,
	SessionMetadata,
} from "../../../packages/agent/src/index.ts";
import {
	decodeTaskRunEvent,
	type TaskRunEvent,
	type TaskRunJournal,
} from "./task-run.ts";

export const TASK_RUN_EVENT_CUSTOM_TYPE = "task_run_event";

export class SessionTaskRunJournal<
	TMetadata extends SessionMetadata = JsonlSessionMetadata,
> implements TaskRunJournal {
	private readonly session: Session<TMetadata>;

	constructor(session: Session<TMetadata>) {
		this.session = session;
	}

	async append(event: TaskRunEvent): Promise<void> {
		await this.session.appendCustomEntry(TASK_RUN_EVENT_CUSTOM_TYPE, event);
	}

	async read(): Promise<readonly TaskRunEvent[]> {
		const events: TaskRunEvent[] = [];
		for (const entry of await this.session.getEntries()) {
			if (
				entry.type !== "custom" ||
				entry.customType !== TASK_RUN_EVENT_CUSTOM_TYPE
			) {
				continue;
			}
			if (typeof entry.data !== "object" || entry.data === null) {
				throw new Error(`Unsupported TaskRun event in Session entry ${entry.id}`);
			}
			events.push(decodeTaskRunEvent(entry.data));
		}
		return events;
	}
}
