import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import { calculateTool } from "../utils/calculate.ts";

const timeline: string[] = [];
let contextCount = 0;
let providerRequestCount = 0;
let turnCount = 0;

function record(label: string): void {
	timeline.push(`${timeline.length + 1}. ${label}`);
}

const models = createModels();
const faux = fauxProvider({ provider: "faux-tool-loop-learning" });
models.setProvider(faux.provider);

faux.setResponses([
	(context) => {
		providerRequestCount++;
		record(`provider request #${providerRequestCount}: 返回 calculate 工具调用`);

		console.log(`\n=== Provider Request #${providerRequestCount} 收到的 Context ===`);
		console.dir(
			{
				systemPrompt: context.systemPrompt,
				messages: context.messages,
				tools: context.tools?.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
			},
			{ depth: null },
		);

		return fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 2" }, { id: "call-1" }), {
			stopReason: "toolUse",
		});
	},
	(context) => {
		providerRequestCount++;
		record(`provider request #${providerRequestCount}: 返回最终回答`);

		console.log(`\n=== Provider Request #${providerRequestCount} 收到的 Context ===`);
		console.dir(
			{
				systemPrompt: context.systemPrompt,
				messages: context.messages,
				tools: context.tools?.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
			},
			{ depth: null },
		);

		return fauxAssistantMessage("计算结果是 3。");
	},
]);

const session = new Session(new InMemorySessionStorage());
const harness = new AgentHarness({
	models,
	model: faux.getModel(),
	session,
	env: new NodeExecutionEnv({ cwd: process.cwd() }),
	systemPrompt: "你是一个用于学习 AgentHarness 工具循环的助手。",
	tools: [calculateTool],
});

harness.subscribe((event) => {
	let detail = "";

	if (event.type === "turn_start") {
		turnCount++;
		detail = ` #${turnCount}`;
	} else if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
		detail = ` (${event.message.role})`;
	} else if (
		event.type === "tool_execution_start" ||
		event.type === "tool_execution_update" ||
		event.type === "tool_execution_end"
	) {
		detail = ` (${event.toolName}, ${event.toolCallId})`;
	} else if (event.type === "save_point") {
		detail = ` (hadPendingMutations=${event.hadPendingMutations})`;
	} else if (event.type === "settled") {
		detail = ` (nextTurnCount=${event.nextTurnCount})`;
	}

	record(`event:${event.type}${detail}`);
});

harness.on("before_agent_start", (event) => {
	record("hook:before_agent_start");

	console.log("\n=== before_agent_start ===");
	console.dir(
		{
			prompt: event.prompt,
			systemPrompt: event.systemPrompt,
			availableTools: [calculateTool.name],
		},
		{ depth: null },
	);

	return undefined;
});

harness.on("context", (event) => {
	contextCount++;
	record(`hook:context #${contextCount}`);

	console.log(`\n=== Context Hook #${contextCount} ===`);
	console.dir(event.messages, { depth: null });

	return undefined;
});

harness.on("tool_call", (event) => {
	record(`hook:tool_call (${event.toolName}, ${event.toolCallId})`);

	console.log("\n=== tool_call Hook：工具执行前 ===");
	console.dir(event, { depth: null });

	return undefined;
});

harness.on("tool_result", (event) => {
	record(`hook:tool_result (${event.toolName}, ${event.toolCallId})`);

	console.log("\n=== tool_result Hook：工具执行后、写入 Context 前 ===");
	console.dir(event, { depth: null });

	return undefined;
});

console.log("\n=== Prompt 前的 Session ===");
console.dir(await session.getEntries(), { depth: null });

const response = await harness.prompt("请计算 1 + 2");

console.log("\n=== prompt() 返回值 ===");
console.dir(response, { depth: null });

console.log("\n=== Prompt 后的 Session Entries ===");
console.dir(await session.getEntries(), { depth: null });

console.log("\n=== Prompt 后 buildContext() ===");
console.dir(await session.buildContext(), { depth: null });

console.log("\n=== 完整时间线 ===");
console.log(timeline.join("\n"));
