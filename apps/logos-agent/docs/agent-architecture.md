# Agent 架构分类学与反思引导

本文记录交付前验证（completion verification）这条线的设计依据与落地协议。结论先行：**不新增门禁、不新增工具、不新增 LLM 调用，只在既有的必经检查点上把"运行时事实"喂给模型，判断留给模型层。**

## 问题

任务完成后直接交付，没有环节校验目标是否偏离、最终声明是否有据。此前的机制缺口：

- `plan_task`/`reflect_task`/`finish_task` 的内容全部由同一个模型在同一个上下文里自报，自我一致性偏差没有对手；
- `computeAssurance` 只记录、不参与任何决策；verify→deliver 转换无门禁意义；
- `verification` 证据唯一来源是 `run_task` 的两个固定任务；
- 最终 summary 从未与证据日志交叉核对，目标偏离只靠系统提示词约束。

## 业界结论（2026-08 源码级调研）

对 Claude Code、OpenCode、Aider、SWE-agent、OpenHands SDK、Codex CLI 的源码/官方文档调研结论：

| 项目 | 完成判定 | 完成前门禁 | 独立评审 | 防死循环 |
|---|---|---|---|---|
| Claude Code | 模型自然停止 | Stop hook（用户配置，可拦截停止） | Task 工具 fresh-context 子代理 | `stop_hook_active` + 连续 8 次 block 放行 |
| OpenCode | 模型自然停止（无 finish 工具） | 无（纯提示词约束） | 无内置，靠用户自建 subagent | doom-loop 检测 |
| Aider | 模型自然停止 | 引擎级：编辑后自动 lint/test，失败进修复循环 | 无（验证是确定性命令） | `max_reflections = 3` |
| SWE-agent | 必须显式 `submit` | submit 分阶段自检（重跑复现、revert 测试改动） | Reviewer 独立模型打分重试 | `max_attempts` |
| OpenHands SDK | `finish` 工具或纯文本 | critic 打分低于 0.6 拦截 finish 注入 follow-up | critic 拿完整事件轨迹 + git patch | `max_iterations = 3` |
| Codex CLI | 模型自然停止 | stop hook 可拦截 | `codex review` 独立子代理按 rubric 输出 JSON（显式调用） | 无默认门禁 |

关键实证：

- **没有项目在引擎层做"任务复杂度分类→架构路由"**。复杂度适配落在三处：启动前的静态预设（OpenCode agent 配置、SWE-agent config bundle）、提示词条件规则（Claude Code 的 "non-trivial = 3+ file edits…"，且该段默认关闭）、按验证成本分级密度（Aider lint 全开/test 选开、OpenHands critic mode）。
- **纯提示词约束无效**：OpenCode 全仓无任何完成后校验代码；Claude Code 官方文档自述 hooks 的意义是 "ensuring certain actions always happen rather than relying on the LLM to choose to run them"。
- **同上下文自我纠错不可靠**（Huang et al. 2023；CRITIC），评审者必须拿外部产物（轨迹、diff、exit code）作输入，SWE-agent/OpenHands/Codex 均如此。
- **约束默认关闭是行业常态**：Anthropic 把对抗性验证段落 gated off，Aider 的 auto-test 默认关，OpenHands critic 是 opt-in。

主要来源：code.claude.com/docs/en/hooks（Stop hook 语义、8 次上限、agent 型 hook）、anomalyco/opencode（`packages/opencode/src/session/prompt.ts`）、Aider-AI/aider（`base_coder.py` 反思循环）、SWE-agent/SWE-agent（`tools/review_on_submit_m`、`agent/reviewer.py`）、OpenHands/software-agent-sdk（`critic/base.py`、`agent/critic_mixin.py`）、openai/codex（`core/src/session/turn.rs`、`prompts/templates/review/rubric.md`）。

## 架构分类学

四种架构模式不是演进替代，是**同一系统的四个正交维度**：

- **Loop 层**（执行内核）：调模型/执行工具/回填，何时停、停了怎么办。终止协议、续跑、预算。
- **ReAct 层**：单步内 think/act 交错。已溶解于现代 harness（thinking + tool call），无需模块化。
- **Plan 层**：把规划从内联决策抽成显式工件（goal/steps/criteria/risks），可对照、可重规划、可对账。
- **Reflection 层**：对轨迹的元循环。三件套：Evaluator（判据，确定性优先）、Reflector（语言化反思）、后果通道（状态必须变）。三个挂载面：事前（plan）、事中（副作用后 checkpoint）、事后（交付前复盘）。

logos-agent 归位（调研时点）：

| 层 | 组件 | 状态 |
|---|---|---|
| Loop | harness、`finish_task` 协议、continuation loop、TaskRun budget | 完整 |
| ReAct | thinking + tools | 已溶解 |
| Plan | `plan_task` | 有工件，但是死快照：无执行中对照、`revise` 不回流、完成不对账 steps |
| Reflection | `reflect_task`（事中）、`run_task` evidence（Evaluator）、`computeAssurance`、`task-eval` | Evaluator 只记录不决策；事后面缺失 |

**准入判定规则**（克制原则的形式化）：任何新机制先问落在哪一格——改变停止/续跑/预算 → Loop 层；改变计划工件字段或生命周期 → Plan 层；改变评估判据或反馈后果 → Reflection 层；都不是 → 默认不加。ReAct 层只允许动提示词。附横切纪律：**模型侧入口与运行时侧出口分离**——`plan_task`/`reflect_task`/`finish_task` 是各层的模型侧入口（schema 化声明），门禁/证据/assurance 是运行时侧出口（机械后果）。只能描述成"加个工具"的需求，说明还没想清楚属于哪层。

## 职责分工：模型判断，运行时引导

**语义判断归模型**：任务重不重、准则是什么、每条满足没有、要不要继续。**事实判定必须归 runtime**：改了几处、证据在不在、exit code 是否为 0、声明了没声明——判断的依据若由被判断者提供就失效。

"引导"是三件事，runtime 的职责清单里没有"判断"：

1. **入口引导**：把架构模式做成模型可调用的结构化入口（协议工具）。
2. **状态引导（grounding）**：runtime 不替模型判断，但决定模型判断时能看见什么。事实包是这一通道的实体。
3. **后果引导（enforcement）**：机械校验 + 执行后果。本阶段刻意克制，只保留既有两道门（副作用前必须有 plan；finish 前必须有 reflect ready）。

约束准入策略：**约束不靠设计 upfront 加，靠评测数据加。** 事实差已入 TaskRun evidence（`reflection:<toolCallId>`，metadata 含 guidance），`task-eval` 可按"带未决事实差仍 finish"的比率度量；哪类偏差在数据上反复出现，才把对应引导升级为门禁。每道门禁要有失败数据背书。

## 已落地协议：交付前事实引导

数据流（★ 为本次改动）：

```
副作用工具 ──►【门1·既有】无 plan_task 阻断
plan_task ──► 记录 goal/steps/准则/risks
副作用执行 ──► change evidence（★ 补记变更路径）
reflect_task ──►【门2·既有】无 ready 不放行 finish
    ★ 返回运行时事实包：
      用户原话目标（非 plan 转述，截断 400 字符）
      plan 步骤/准则/风险计数
      已记录变更路径（最多列 10 条）
      当前指纹下验证状态 passed/failed/none
      事实差：声明准则但无匹配验证 / 最新验证失败 / 变更数超过计划步骤数
    ★ 事实差摘要以 tool_result evidence 入账（idempotency: reflection:<toolCallId>）
finish_task ──► ★ 返回值附 previewAssurance 级别（与终态同判据）
    → 模型写最终 summary 时如实说明验证边界
TaskRun 终态 ──► assurance 只记录、不拦截（不变）
```

实现位置：

- `task-deliberation-tool.ts`：`buildReflectionGuidance`（纯函数，`ReflectionGuidanceSummary` + 文本）；`createReflectTaskTool` 增加 `loadGuidance` 可选回调，加载失败静默降级。
- `task-completion-tool.ts`：`createFinishTaskTool` 增加 `loadAssurance`，`FinishTaskDetails.assurance`。
- `task-run.ts`：导出 `previewAssurance`（`computeAssurance(state, "success")`，与终态入账一致）。
- `logos-agent.ts`：装配两个回调（goal 取 `turnTaskLifecycle` 原话，run 取 activeTaskRun）；change evidence 补路径；reflect evidence 分支。
- `logos-tools.ts`：`reflectionGuidance`/`finishTaskAssurance` 可选依赖穿透。

任务大小自适应，无档位路由：小任务事实包一行（模型扫一眼说 ready），大任务事实包庞大、事实差扎眼（模型自然认真复盘）。机械信号（changes 计数）不用于路由，用于揭示事实差——**发现偏离的是模型，揭示偏离的是运行时。**

## 明确不做

- 不加新门禁：无分阶段拒绝 finish、无逐条准则强制对账、无证据引用机械拦截、assurance 不拦截交付。
- 不加独立评审者（fresh-context critic / 额外 LLM 调用）：最不克制，留待 eval 数据证明必要后再评估。
- 不加工作量阈值路由（`shouldReviewBeforeFinish` 类谓词）：事实包无条件生成（纯内存拼装），成本与任务大小成比例。
- 不动 ReAct 层与 Loop 层。

## 延后事项

1. **Plan 层激活**：plan 从快照变活对象——执行中 step 对照、`revise` 回流触发重规划、finish 时 steps 对账。与事实包的准则对账接口留白。
2. **跨回合 memory**（Reflexion 的 episodic 形态）：历史反思注入后续任务有污染风险，继续缓；`task-eval` 是组织级替代。
3. **eval 反例 case**："应继续工作却提前 finish"、"summary 声称与 evidence 不符"——度量数据决定是否升级门禁。
