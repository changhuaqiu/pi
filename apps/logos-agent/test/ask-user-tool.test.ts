import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createAskUserTool,
	parseAskUserInput,
	summarizeQuestionForAudit,
	UserQuestionCoordinator,
	type UserQuestionRequest,
} from "../src/ask-user-tool.ts";

test("ask_user exposes an object schema and returns a bounded user answer", async () => {
	const updates: string[] = [];
	const tool = createAskUserTool({
		async ask(question) {
			assert.equal(question.question, "Which framework should be used?");
			assert.deepEqual(question.options, [
				{ label: "React", description: "Use the existing React ecosystem" },
				{ label: "Vue", description: "Use Vue's progressive framework" },
			]);
			return { kind: "answer", answer: "React", source: "option" };
		},
	});
	assert.equal(tool.parameters.type, "object");

	const result = await tool.execute(
		"question-1",
		{
			question: "Which framework should be used?",
			context: "No framework is configured in the workspace.",
			options: [
				{ label: "React", description: "Use the existing React ecosystem" },
				{ label: "Vue", description: "Use Vue's progressive framework" },
			],
		},
		undefined,
		(update) => {
			updates.push(update.details.stage);
		},
	);

	assert.deepEqual(updates, ["waiting", "completed"]);
	assert.match(
		result.content[0]?.type === "text" ? result.content[0].text : "",
		/User answer: React/,
	);
	assert.equal(result.details.answerBytes, 5);
	assert.equal(result.details.outcome, "answer");
});

test("ask_user turns discuss into model-visible clarification guidance", async () => {
	const tool = createAskUserTool({
		async ask() {
			return { kind: "discuss" };
		},
	});
	const result = await tool.execute("question-discuss", { question: "Which architecture?" });
	assert.equal(result.details.outcome, "discuss");
	assert.match(
		result.content[0]?.type === "text" ? result.content[0].text : "",
		/wants to clarify this question/,
	);
});

test("ask_user validates focused unique single-line choices", () => {
	assert.throws(
		() =>
			parseAskUserInput({
				question: "Choose",
				options: [
					{ label: "same", description: "first" },
					{ label: "same", description: "second" },
				],
			}),
		/options must be unique/,
	);
	assert.throws(
		() => parseAskUserInput({ question: "line one\nline two" }),
		/single-line/,
	);
	assert.throws(
		() =>
			parseAskUserInput({
				question: "Choose",
				options: [{ label: "only one", description: "not enough choices" }],
			}),
		/execution-time validation/,
	);
});

test("question coordinator validates selected choices and permits one pending question", async () => {
	const coordinator = new UserQuestionCoordinator();
	let request: UserQuestionRequest | undefined;
	const answer = coordinator.request(
		{
			question: "Choose a scope",
			options: [
				{ label: "Current package", description: "Limit changes to one package" },
				{ label: "Entire workspace", description: "Apply across the monorepo" },
			],
		},
		async (pending) => {
			request = pending;
		},
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.ok(request);
	await assert.rejects(
		coordinator.request(
			{ question: "Second question" },
			async () => {},
		),
		/Another user question/,
	);
	assert.deepEqual(coordinator.respond(request.id, {
		kind: "answer",
		answer: "Entire workspace",
		source: "option",
	}), {
		accepted: true,
	});
	assert.deepEqual(await answer, {
		kind: "answer",
		answer: "Entire workspace",
		source: "option",
	});
});

test("question coordinator represents discussion separately from an answer", async () => {
	const coordinator = new UserQuestionCoordinator();
	let request: UserQuestionRequest | undefined;
	const resolution = coordinator.request(
		{ question: "Choose an architecture" },
		async (pending) => {
			request = pending;
		},
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.ok(request);
	assert.deepEqual(coordinator.respond(request.id, { kind: "discuss" }), {
		accepted: true,
	});
	assert.deepEqual(await resolution, { kind: "discuss" });
});

test("question coordinator cancellation rejects the waiting tool", async () => {
	const coordinator = new UserQuestionCoordinator();
	const answer = coordinator.request(
		{ question: "Continue?" },
		async () => {},
	);
	coordinator.cancel();
	await assert.rejects(answer, (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.equal(error.name, "AbortError");
		return true;
	});
});

test("question coordinator settles cancellation before delayed publication and prevents late presentation", async () => {
	const coordinator = new UserQuestionCoordinator();
	let releasePublish = (): void => {};
	let presented = false;
	const publishBlocked = new Promise<void>((resolve) => {
		releasePublish = resolve;
	});
	const answer = coordinator.request(
		{ question: "Continue?" },
		async (_request, signal) => {
			await publishBlocked;
			if (signal.aborted) throw signal.reason;
			presented = true;
		},
	);
	coordinator.cancel();
	await assert.rejects(answer, (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.equal(error.name, "AbortError");
		return true;
	});
	releasePublish();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(presented, false);
});

test("question audit summary excludes raw question text", () => {
	const input = {
		question: "Which deployment target should be used?",
		options: [
			{ label: "Staging", description: "Deploy for validation" },
			{ label: "Production", description: "Deploy to users" },
		],
	};
	const summary = summarizeQuestionForAudit(input);
	assert.equal(summary.optionCount, 2);
	assert.equal(typeof summary.questionHash, "string");
	assert.equal(JSON.stringify(summary).includes(input.question), false);
});
