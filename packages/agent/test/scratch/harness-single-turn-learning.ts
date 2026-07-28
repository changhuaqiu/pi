import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";

const timeline: string[] = [];

const models = createModels();
const faux = fauxProvider({ provider: "faux-learning" });
models.setProvider(faux.provider);

faux.setResponses([
	(context) => {
		timeline.push("provider_received_context");

		console.log("\n=== Provider 实际收到的 Context ===");
		console.dir(
			{
				systemPrompt: context.systemPrompt,
				messages: context.messages,
				tools: context.tools,
			},
			{ depth: null },
		);

		return fauxAssistantMessage("你好，这是 Harness 的固定回复。");
	},
]);

const session = new Session(new InMemorySessionStorage());
const harness = new AgentHarness({
	models,
	model: faux.getModel(),
	session,
	env: new NodeExecutionEnv({ cwd: process.cwd() }),
	systemPrompt: "你是一个用于学习 AgentHarness 的助手。",
});

harness.subscribe((event) => {
	timeline.push(`event:${event.type}`);
});

harness.on("before_agent_start", (event) => {
	timeline.push("hook:before_agent_start");

	console.log("\n=== before_agent_start ===");
	console.dir(
		{
			prompt: event.prompt,
			systemPrompt: event.systemPrompt,
		},
		{ depth: null },
	);

	return undefined;
});

harness.on("context", (event) => {
	timeline.push("hook:context");

	console.log("\n=== transformContext 阶段 ===");
	console.dir(event.messages, { depth: null });

	return undefined;
});

console.log("\n=== Prompt 前的 Session ===");
console.dir(await session.getEntries(), { depth: null });

const response = await harness.prompt("你好");

console.log("\n=== prompt() 返回值 ===");
console.dir(response, { depth: null });

console.log("\n=== Prompt 后的 Session Entries ===");
console.dir(await session.getEntries(), { depth: null });

console.log("\n=== Prompt 后 buildContext() ===");
console.dir(await session.buildContext(), { depth: null });

console.log("\n=== 完整时间线 ===");
console.log(timeline.join("\n"));
