# TaskRun 与 Eval

`AgentHarness` 负责一次模型/工具循环，`Session` 保存对话树；`TaskRun` 位于应用层，记录一个目标从开始到交付的可恢复执行状态。

## TaskRun

每次 `LearningAgent.prompt()` 先开始一个普通 turn。只有模型请求 `edit.propose`、`fs.write`、`fs.delete`、`process.execute` 或 `process.terminate` 这类任务能力时，turn 才 promotion 为 TaskRun，并冻结当时的 Manifest。纯对话和 read-only turn 不创建 TaskRun：

- release、应用版本、commit 和 feature flags
- 模型、system prompt、工具定义和权限策略的 hash
- workspace 身份和执行预算

因此 TaskRun 不是每次 prompt 的统一关联身份。prompt 级持久关联、pre-promotion 事实和 read-only execution 由 [元认知控制与演进设计](./metacognitive-control-and-evolution.md) 中已经落地的 `ExecutionJournal` 承担。

运行状态包含 `discover -> execute -> verify -> deliver` 阶段，以及 `active`、`waiting`、`terminal` 生命周期。审批期间进入 `waiting`，审批结束后恢复。Provider 请求、工具决策/结果、审批、受控变更、验证命令、缓存观测和最终回复均记录为证据。

TaskRun 使用 v2 追加事件存储在当前 Session 的 `task_run_event` custom entries 中。start event 必须携带 prompt 级 `executionId`；ExecutionJournal 同时追加 `task_run_linked`，使 promotion 前后事实属于同一 execution。启动和切换 Session 时会对两本 journal 做幂等 reconciliation：恢复已创建但未关联的 TaskRun，补写中断的 evidence replay，并把上个进程遗留的 active execution/TaskRun 审计为 `aborted`；普通查询只修复关联，不会终止当前进程中的 active execution。旧 v1 start event 仍可读取，并显式映射为 `legacy-task-run:<runId>`，不会伪造不存在的 prompt execution。普通 custom entry 不会被 `Session.buildContext()` 投影成模型消息，因此不会增加模型上下文。

TUI 提供：

- `/runs`：列出当前 Session 最近的 TaskRun
- `/run <run-id>`：查看状态、结论、保障级别、Manifest 摘要和执行指标

`success` 只表示执行正常结束。保障级别单独表示证据强度：

- `unverified`：没有通过验证，或执行未成功
- `partial`：有通过的验证，但验证对象已被后续变更替换
- `verified`：通过的验证与当前受控变更指纹一致

交付前的运行时事实引导（只引导，不拦截；设计依据与完整协议见 [agent-architecture.md](./agent-architecture.md)）：

- `plan_task`、`reflect_task` 和 `finish_task` 是复杂任务的可选检查点，不是执行许可。简单修改可以在适度检查后直接结束；只读分析不为了完成流程而运行测试。真正的硬约束仍由工具权限、审批、路径和命令策略承担。
- `reflect_task` 的返回值附带运行时事实包：用户原始目标（原话，非 plan 转述）、plan 声明的步骤与验证准则、已记录的变更路径、当前指纹下的验证状态，以及可机械计算的事实差（如声明了验证准则但当前状态无验证证据、变更数超过计划步骤数）。事实包由运行时从 TaskRun 证据装配；发现偏离的是模型，揭示事实的是运行时。
- `finish_task` 的返回值附带 `previewAssurance` 计算的保障级别，提示最终总结如实说明验证边界；该级别与最终入账的 assurance 使用同一判据。
- `reflect_task` 的结果以 `tool_result` 证据入账，metadata 携带 decision 与事实差摘要；`apply_edit`/`create_directories` 的 change 证据补充记录变更路径。

## Eval

`task-eval.ts` 提供确定性 P0 Eval Runner。调用方提供 EvalCase 和执行 Adapter，Runner 对返回的终态 TaskRun 评分：

- execution：是否产出可识别的 TaskRun
- correctness：终态结论是否符合预期
- verification：保障级别是否达到下限
- safety：必需/禁止证据与策略违规
- efficiency：耗时、Provider 请求数和工具调用数是否超预算

同一 suite 的两份报告可以按 case 对比 improved、regressed、unchanged，并汇总通过率和 verified rate 的变化。workspace fixture 的准备和真实 Agent 执行由调用方 Adapter 提供，TaskRun/Eval 核心不依赖具体测试环境。

P1 在此基础上增加 `TrajectoryEvaluator`：旧 `TaskEvalCase` 可转换成执行前冻结的 rubric，评价只读取 private canonical trajectory。hard criterion 的 pass/fail 必须引用 `evidenceIndex`；轨迹不完整、负向判据缺少完整 coverage、当前 workspace fingerprint 不可证或 evaluator 未启用时返回 unknown。当前 compiler 尚未产生完整 mutation coverage attestation，因此即使观察到匹配当前 fingerprint 的验证，也会保守返回 unknown，不能硬通过。生产 hard failure 可以生成携带 rubric、失败 criterion 和 evidence refs 的 regression case seed，但 workspace fixture 仍由调用方显式提供。
