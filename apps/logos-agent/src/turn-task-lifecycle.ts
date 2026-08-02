import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ToolCapability } from "./tool-system.ts";

export type TurnTaskMode = "idle" | "turn" | "task";

const taskCapabilityKinds: ReadonlySet<ToolCapability["kind"]> = new Set([
	"edit.propose",
	"fs.write",
	"fs.delete",
	"process.execute",
	"process.terminate",
]);

export class TurnTaskLifecycle {
	private mode: TurnTaskMode = "idle";
	private goal?: string;

	beginTurn(goal: string): void {
		const normalizedGoal = goal.trim();
		if (!normalizedGoal) throw new Error("Turn goal must not be empty");
		this.mode = "turn";
		this.goal = normalizedGoal;
	}

	observeToolCapabilities(capabilities: readonly ToolCapability[]): boolean {
		if (this.mode === "idle") return false;
		if (this.mode === "task") return false;
		if (!capabilities.some((capability) => taskCapabilityKinds.has(capability.kind))) {
			return false;
		}
		this.mode = "task";
		return true;
	}

	isTask(): boolean {
		return this.mode === "task";
	}

	getGoal(): string | undefined {
		return this.goal;
	}

	endTurn(): void {
		this.mode = "idle";
		this.goal = undefined;
	}

	snapshot(): { mode: TurnTaskMode; goal?: string } {
		return {
			mode: this.mode,
			...(this.goal === undefined ? {} : { goal: this.goal }),
		};
	}
}

export function isNormalTurnComplete(message: AssistantMessage): boolean {
	return (
		message.stopReason === "stop" &&
		message.content.some(
			(item) => item.type === "text" && item.text.trim().length > 0,
		) &&
		!message.content.some((item) => item.type === "toolCall")
	);
}
