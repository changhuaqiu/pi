import { createHash, randomUUID } from "node:crypto";
import type {
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

const askUserSchema = Type.Object(
	{
		question: Type.String({
			minLength: 1,
			maxLength: 1_000,
			description:
				"One direct question whose answer materially changes the work and cannot be discovered from available evidence",
		}),
		context: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 1_000,
				description:
					"Briefly state what was checked and why proceeding without the answer would be risky",
			}),
		),
		options: Type.Optional(
			Type.Array(
				Type.Object(
					{
						label: Type.String({
							minLength: 1,
							maxLength: 120,
							description: "Concise display label, ideally one to five words",
						}),
						description: Type.String({
							minLength: 1,
							maxLength: 300,
							description: "Brief trade-off or effect of choosing this option",
						}),
					},
					{ additionalProperties: false },
				),
				{
					minItems: 2,
					maxItems: 4,
					description:
						"Two to four concise, mutually exclusive choices. Do not add Other or Chat about this; the interface supplies them.",
				},
			),
		),
	},
	{ additionalProperties: false },
);

type AskUserInput = Static<typeof askUserSchema>;

export interface UserQuestion {
	question: string;
	context?: string;
	options?: readonly UserQuestionOption[];
}

export interface UserQuestionOption {
	label: string;
	description: string;
}

export interface UserQuestionRequest extends UserQuestion {
	id: string;
}

export interface UserQuestionResponse {
	accepted: boolean;
	error?: string;
}

export type UserQuestionResolution =
	| { kind: "answer"; answer: string; source: "option" | "custom" }
	| { kind: "discuss" };

export type UserQuestionAction = UserQuestionResolution | { kind: "cancel" };

export interface UserQuestionOperations {
	ask(question: UserQuestion, signal?: AbortSignal): Promise<UserQuestionResolution>;
}

export interface AskUserToolDetails {
	stage: "waiting" | "completed";
	optionCount: number;
	outcome?: UserQuestionResolution["kind"];
	answerBytes?: number;
	answerHash?: string;
}

interface PendingQuestion {
	request: UserQuestionRequest;
	resolve(resolution: UserQuestionResolution): void;
	reject(error: Error): void;
	abortPublication(error: Error): void;
}

const askUserValidator = Compile(askUserSchema);
const invalidDisplayCharacters = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const invalidAnswerCharacters = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const maxAnswerCharacters = 4_000;

function abortError(): Error {
	const error = new Error("User question cancelled");
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw abortError();
}

export function parseAskUserInput(
	input: Readonly<Record<string, unknown>>,
): UserQuestion {
	if (!askUserValidator.Check(input)) {
		throw new Error("ask_user arguments failed execution-time validation");
	}
	const parsed: AskUserInput = input;
	const question = parsed.question.trim();
	const context = parsed.context?.trim();
	const options = parsed.options?.map((option) => ({
		label: option.label.trim(),
		description: option.description.trim(),
	}));
	if (
		!question ||
		invalidDisplayCharacters.test(question) ||
		(context !== undefined &&
			(!context || invalidDisplayCharacters.test(context))) ||
		options?.some((option) =>
			!option.label ||
			!option.description ||
			invalidDisplayCharacters.test(option.label) ||
			invalidDisplayCharacters.test(option.description)
		)
	) {
		throw new Error("ask_user text must be non-empty single-line text");
	}
	if (options && new Set(options.map((option) => option.label)).size !== options.length) {
		throw new Error("ask_user options must be unique");
	}
	return {
		question,
		...(context === undefined ? {} : { context }),
		...(options === undefined ? {} : { options }),
	};
}

export function summarizeQuestionForAudit(
	input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const question = parseAskUserInput(input);
	const text = JSON.stringify(question);
	return {
		questionBytes: Buffer.byteLength(question.question, "utf8"),
		questionHash: createHash("sha256")
			.update(question.question, "utf8")
			.digest("hex"),
		optionCount: question.options?.length ?? 0,
		requestHash: createHash("sha256").update(text, "utf8").digest("hex"),
	};
}

export class UserQuestionCoordinator {
	private pending?: PendingQuestion;

	async request(
		question: UserQuestion,
		publish: (request: UserQuestionRequest, signal: AbortSignal) => Promise<void>,
		signal?: AbortSignal,
	): Promise<UserQuestionResolution> {
		throwIfAborted(signal);
		if (this.pending) throw new Error("Another user question is already pending");
		const request: UserQuestionRequest = {
			id: randomUUID(),
			question: question.question,
			...(question.context === undefined
				? {}
				: { context: question.context }),
			...(question.options === undefined
				? {}
				: { options: [...question.options] }),
		};
		let resolveAnswer = (_resolution: UserQuestionResolution): void => {};
		let rejectAnswer = (_error: Error): void => {};
		const answer = new Promise<UserQuestionResolution>((resolve, reject) => {
			resolveAnswer = resolve;
			rejectAnswer = reject;
		});
		const answerOutcome = answer.then(
			(value) => ({ status: "answered" as const, value }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);
		const publicationController = new AbortController();
		this.pending = {
			request,
			resolve: resolveAnswer,
			reject: rejectAnswer,
			abortPublication: (error) => publicationController.abort(error),
		};
		const cancel = (): void => {
			if (this.pending?.request.id !== request.id) return;
			const pending = this.pending;
			this.pending = undefined;
			const error = abortError();
			pending.abortPublication(error);
			pending.reject(error);
		};
		signal?.addEventListener("abort", cancel, { once: true });
		try {
			const publishOutcome = Promise.resolve()
				.then(async () => await publish(request, publicationController.signal))
				.then(
					() => ({ status: "published" as const }),
					(error: unknown) => ({ status: "publish_failed" as const, error }),
				);
			const cancellationOutcome: Promise<{
				status: "cancelled";
				error: unknown;
			}> = answerOutcome.then(async (outcome) => {
				if (outcome.status === "rejected") {
					return { status: "cancelled", error: outcome.error };
				}
				return await new Promise<never>(() => {});
			});
			const publication = await Promise.race([
				publishOutcome,
				cancellationOutcome,
			]);
			if (publication.status === "cancelled") throw publication.error;
			if (publication.status === "publish_failed") throw publication.error;
			const outcome = await answerOutcome;
			if (outcome.status === "rejected") throw outcome.error;
			return outcome.value;
		} finally {
			signal?.removeEventListener("abort", cancel);
			publicationController.abort(abortError());
			if (this.pending?.request.id === request.id) this.pending = undefined;
		}
	}

	respond(requestId: string, action: UserQuestionAction): UserQuestionResponse {
		const pending = this.pending;
		if (pending?.request.id !== requestId) {
			return { accepted: false, error: "The user question is no longer pending" };
		}
		if (action.kind === "cancel") {
			this.pending = undefined;
			const error = abortError();
			pending.abortPublication(error);
			pending.reject(error);
			return { accepted: true };
		}
		if (action.kind === "discuss") {
			this.pending = undefined;
			pending.resolve(action);
			return { accepted: true };
		}
		const answer = action.answer.trim();
		if (!answer) {
			return { accepted: false, error: "Answer cannot be empty" };
		}
		if (Array.from(answer).length > maxAnswerCharacters) {
			return {
				accepted: false,
				error: `Answer exceeds ${maxAnswerCharacters} characters`,
			};
		}
		if (
			action.source === "option" &&
			!pending.request.options?.some((option) => option.label === answer)
		) {
			return { accepted: false, error: "Selected option is not available" };
		}
		this.pending = undefined;
		pending.resolve({ ...action, answer });
		return { accepted: true };
	}

	cancel(): void {
		const pending = this.pending;
		this.pending = undefined;
		if (!pending) return;
		const error = abortError();
		pending.abortPublication(error);
		pending.reject(error);
	}
}

function emitUpdate(
	onUpdate: AgentToolUpdateCallback<AskUserToolDetails> | undefined,
	details: AskUserToolDetails,
): void {
	onUpdate?.({
		content: [
			{
				type: "text",
				text:
					details.stage === "waiting"
						? "Waiting for user answer"
						: "User answer received",
			},
		],
		details,
	});
}

function safeAnswer(answer: string): string {
	return answer.replace(invalidAnswerCharacters, (character) => {
		if (character === "\n" || character === "\t") return character;
		const codePoint = character.codePointAt(0);
		return codePoint === undefined
			? ""
			: `\\u{${codePoint.toString(16)}}`;
	});
}

export function createAskUserTool(
	operations: UserQuestionOperations,
): AgentTool<typeof askUserSchema, AskUserToolDetails> {
	return {
		name: "ask_user",
		label: "ask user",
		description:
			"Pause and ask the user one necessary clarification question. Use only after inspecting available workspace evidence, when different answers would materially change the result and guessing would be risky. Do not use for progress updates, routine reversible choices, action approval, credentials, tokens, passwords, or other secrets.",
		parameters: askUserSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal, onUpdate) {
			const question = parseAskUserInput(rawInput);
			emitUpdate(onUpdate, {
				stage: "waiting",
				optionCount: question.options?.length ?? 0,
			});
			const resolution = await operations.ask(question, signal);
			throwIfAborted(signal);
			if (resolution.kind === "discuss") {
				const details: AskUserToolDetails = {
					stage: "completed",
					optionCount: question.options?.length ?? 0,
					outcome: "discuss",
				};
				emitUpdate(onUpdate, details);
				return {
					content: [{
						type: "text",
						text: `The user wants to clarify this question before answering: ${safeAnswer(question.question)}. Ask what they would like to clarify, take their response into account, and reformulate the question if appropriate.`,
					}],
					details,
				} satisfies AgentToolResult<AskUserToolDetails>;
			}
			const answer = resolution.answer;
			const answerBytes = Buffer.byteLength(answer, "utf8");
			const answerHash = createHash("sha256")
				.update(answer, "utf8")
				.digest("hex");
			const details: AskUserToolDetails = {
				stage: "completed",
				optionCount: question.options?.length ?? 0,
				outcome: "answer",
				answerBytes,
				answerHash,
			};
			emitUpdate(onUpdate, details);
			return {
				content: [{ type: "text", text: `User answer: ${safeAnswer(answer)}` }],
				details,
			} satisfies AgentToolResult<AskUserToolDetails>;
		},
	};
}
