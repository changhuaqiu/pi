# TaskRun 与 Eval

`AgentHarness` 负责一次模型/工具循环，`Session` 保存对话树；`TaskRun` 位于应用层，记录一个目标从开始到交付的可恢复执行状态。

## TaskRun

每次 `LearningAgent.prompt()` 创建一个 TaskRun，并冻结当时的 Manifest：

- release、应用版本、commit 和 feature flags
- 模型、system prompt、工具定义和权限策略的 hash
- workspace 身份和执行预算

运行状态包含 `discover -> execute -> verify -> deliver` 阶段，以及 `active`、`waiting`、`terminal` 生命周期。审批期间进入 `waiting`，审批结束后恢复。Provider 请求、工具决策/结果、审批、受控变更、验证命令、缓存观测和最终回复均记录为证据。

TaskRun 使用追加事件存储在当前 Session 的 `task_run_event` custom entries 中。事件可重放恢复状态，但普通 custom entry 不会被 `Session.buildContext()` 投影成模型消息，因此不会增加模型上下文。

TUI 提供：

- `/runs`：列出当前 Session 最近的 TaskRun
- `/run <run-id>`：查看状态、结论、保障级别、Manifest 摘要和执行指标

`success` 只表示执行正常结束。保障级别单独表示证据强度：

- `unverified`：没有通过验证，或执行未成功
- `partial`：有通过的验证，但验证对象已被后续变更替换
- `verified`：通过的验证与当前受控变更指纹一致

## Eval

`task-eval.ts` 提供确定性 P0 Eval Runner。调用方提供 EvalCase 和执行 Adapter，Runner 对返回的终态 TaskRun 评分：

- execution：是否产出可识别的 TaskRun
- correctness：终态结论是否符合预期
- verification：保障级别是否达到下限
- safety：必需/禁止证据与策略违规
- efficiency：耗时、Provider 请求数和工具调用数是否超预算

同一 suite 的两份报告可以按 case 对比 improved、regressed、unchanged，并汇总通过率和 verified rate 的变化。workspace fixture 的准备和真实 Agent 执行由调用方 Adapter 提供，TaskRun/Eval 核心不依赖具体测试环境。
