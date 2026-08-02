import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import type {
	UserQuestionAction,
	UserQuestionRequest,
} from "./ask-user-tool.ts";
import { sanitizeTerminalText } from "./transcript-tool-block.ts";

const optionPrefixWidth = 5;

function bounded(value: string, width: number): string {
	return truncateToWidth(value, Math.max(1, width), "…");
}

/** Interactive question prompt with choices, free-text input, and a separate discussion action. */
export class LogosQuestionPrompt implements Component, Focusable {
	private readonly request: UserQuestionRequest;
	private readonly onAction: (action: UserQuestionAction) => boolean | void;
	private readonly customInput = new Input();
	private selectedIndex = 0;
	private editingCustom = false;
	private validationMessage?: string;
	private focusedValue = false;
	private completed = false;

	constructor(
		request: UserQuestionRequest,
		onAction: (action: UserQuestionAction) => boolean | void,
	) {
		this.request = request;
		this.onAction = onAction;
		this.customInput.onSubmit = (value) => this.submitCustom(value);
		this.customInput.onEscape = () => {
			this.editingCustom = false;
			this.validationMessage = undefined;
			this.customInput.focused = false;
		};
	}

	get focused(): boolean {
		return this.focusedValue;
	}

	set focused(value: boolean) {
		this.focusedValue = value;
		this.customInput.focused = value && this.editingCustom;
	}

	getSelectedIndex(): number {
		return this.selectedIndex;
	}

	isEditingCustomAnswer(): boolean {
		return this.editingCustom;
	}

	setCustomAnswer(value: string): void {
		this.customInput.setValue(value);
	}

	handleInput(data: string): void {
		if (this.completed) return;
		if (this.editingCustom) {
			this.customInput.handleInput(data);
			return;
		}

		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(this.actionCount - 1, this.selectedIndex + 1);
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
			this.confirmSelection();
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.complete({ kind: "cancel" });
		}
	}

	invalidate(): void {
		this.customInput.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const options = this.request.options ?? [];
		const lines = [
			bounded(chalk.bold.cyan("Agent needs clarification"), safeWidth),
			bounded(chalk.bold(sanitizeTerminalText(this.request.question)), safeWidth),
		];
		if (this.request.context) {
			lines.push(
				bounded(
					chalk.dim(`Why: ${sanitizeTerminalText(this.request.context)}`),
					safeWidth,
				),
			);
		}
		lines.push("");

		for (const [index, option] of options.entries()) {
			const selected = index === this.selectedIndex;
			lines.push(
				this.renderActionLine(
					index,
					`${index + 1}. ${sanitizeTerminalText(option.label)}`,
					safeWidth,
				),
			);
			const description = bounded(
				sanitizeTerminalText(option.description),
				Math.max(1, safeWidth - optionPrefixWidth),
			);
			lines.push(
				bounded(
					`${" ".repeat(optionPrefixWidth)}${selected ? chalk.cyan(description) : chalk.dim(description)}`,
					safeWidth,
				),
			);
		}

		const customIndex = options.length;
		lines.push(
			this.renderActionLine(
				customIndex,
				`${customIndex + 1}. Type something.`,
				safeWidth,
			),
		);
		if (this.editingCustom) {
			for (const line of this.customInput.render(Math.max(1, safeWidth - optionPrefixWidth))) {
				lines.push(bounded(`${" ".repeat(optionPrefixWidth)}${line}`, safeWidth));
			}
		}

		lines.push(chalk.dim("─".repeat(safeWidth)));
		const discussIndex = customIndex + 1;
		lines.push(
			this.renderActionLine(
				discussIndex,
				`${discussIndex + 1}. Chat about this`,
				safeWidth,
			),
		);
		if (this.validationMessage) {
			lines.push(bounded(chalk.red(this.validationMessage), safeWidth));
		}
		lines.push(
			bounded(
				chalk.dim(
					this.editingCustom
						? "Enter submit · Esc return to choices"
						: "↑/↓ navigate · Enter select · Esc cancel turn",
				),
				safeWidth,
			),
			bounded(
				chalk.yellow("Do not paste passwords, API keys, tokens, or other secrets."),
				safeWidth,
			),
		);
		return lines;
	}

	private get actionCount(): number {
		return (this.request.options?.length ?? 0) + 2;
	}

	private confirmSelection(): void {
		const options = this.request.options ?? [];
		const option = options[this.selectedIndex];
		if (option) {
			this.complete({ kind: "answer", answer: option.label, source: "option" });
			return;
		}
		if (this.selectedIndex === options.length) {
			this.editingCustom = true;
			this.customInput.focused = this.focusedValue;
			return;
		}
		this.complete({ kind: "discuss" });
	}

	private submitCustom(rawValue: string): void {
		const answer = rawValue.trim();
		if (!answer) {
			this.validationMessage = "Answer cannot be empty";
			return;
		}
		this.complete({ kind: "answer", answer, source: "custom" });
	}

	private complete(action: UserQuestionAction): void {
		if (this.completed) return;
		this.completed = this.onAction(action) !== false;
	}

	private renderActionLine(index: number, label: string, width: number): string {
		const selected = index === this.selectedIndex;
		const prefix = selected ? chalk.cyan("❯ ") : "  ";
		const content = selected ? chalk.bold.cyan(label) : label;
		return bounded(`${prefix}${content}`, width);
	}
}
