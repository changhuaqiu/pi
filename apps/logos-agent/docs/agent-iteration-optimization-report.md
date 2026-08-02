# 一个简单的任务，Agent 跑了十三分钟，累计处理了 1,313 万 Token

## 一条绿色 Trace 背后的真实执行现场

那天晚上，我打开 Phoenix，在 `logos-agent` 项目里看见一条很长的绿色 Trace。

它持续了 820.719 秒——十三分四十秒。

根节点里的用户输入是：

> 优先级高的

这不是一个独立需求，而是对上一轮 TUI 改进分析的自然承接。Agent 最终为 TUI 增加了 `HorizontalLayout` 和 `ScrollView`，补上按键绑定和测试，最后 `npm run check` 与 TUI 测试全部通过。

如果我只看列表里的绿色状态，故事很容易被概括成一句话：Agent 接到任务，工作十三分钟，成功完成。

但我点开了。

屏幕左侧的树一下展开，像一卷从桌面滚到地上的长纸。一个根节点下面挂着 196 个 Span：96 次 LLM 调用，99 次工具调用。列表里那段平静的十三分钟，里面其实挤满了连续的决策、工具调用、失败和恢复。

然后我看到了 usage 汇总：

```text
13,134,945 tokens
```

我重新计算了一遍。数字没有抄错。

这样一个范围明确的 TUI 改进任务，为什么会在十三分钟内累计处理 1,313 万 Token？

## 我先确认这 1,313 万 Token 到底是什么

我把 96 个 LLM Span 的 usage 全部加在一起，数字正好是：

| Token 类型 | 累计数量 | 占比 |
|---|---:|---:|
| 缓存读取 | 13,029,376 | 99.20% |
| 新输入 | 68,366 | 0.52% |
| 模型输出 | 37,203 | 0.28% |
| 合计 | **13,134,945** | **100%** |

其中 reasoning 为 13,463 Token，包含在模型输出用量中。

所以，模型并不是一次接收了 1,313 万 Token，也不是产生了 1,313 万 Token 的新知识。真正发生的是：Agent 调用了模型 96 次，每次都把越来越长的历史重新带进去。平均每次 LLM 调用处理约 136,822 Token，其中绝大多数是之前已经出现过的缓存 Context。

缓存让最终费用保持在约 `$0.1093`，但它不能消除另外两件事：模型仍然需要面对巨大的上下文窗口，系统仍然进行了 96 次串行决策。

这 1,313 万 Token 不是单纯的账单问题。它是一张系统结构的 X 光片：同一个任务的历史，被反复搬运了太多次。

## 第一幕：Agent 接过了一张没有写全的任务单

“优先级高的”不是一个完整需求。

它的意思藏在上一轮对话里。上一轮 Agent 刚分析过 TUI，列出了几个优先级较高的方向：水平布局、通用滚动容器、Markdown 表格。这一轮用户只是确认：就做那些优先级高的。

Agent 必须先回头翻阅整段会话，才能知道自己要做什么。

它第一次走向模型时，已经背着约 86,400 个缓存 Token。像一名刚进工地的工程师，手里没有一张简洁的施工单，却拖着过去所有会议记录、图纸和聊天记录。

九点五十二分三十秒，第一轮 LLM 开始。

九秒后，它调用了 `plan_task`，写下六个步骤：

1. 实现水平布局容器；
2. 实现通用 ScrollView；
3. 实现 Markdown 表格；
4. 导出新组件；
5. 编写测试；
6. 运行检查。

计划看起来清楚。此刻还没有任何异常。

如果把这一刻画成一张路线图，它大概是这样的：

```text
起点
  ├─ HorizontalLayout
  ├─ ScrollView
  ├─ Markdown table
  └─ 测试与检查
终点
```

Agent 出发了。

## 第二幕：它开始写代码，也开始越走越重

接下来的几十轮里，Phoenix 的树不断向下生长。

Agent 读取 `utils.ts`，查看终端宽度和 ANSI 处理；读取现有测试，理解 Virtual Terminal；搜索按键绑定；检查 Markdown 的 token 渲染；创建文件、提出补丁、应用编辑。

工具本身都很快。大多数 `read_file` 和 `search_text` 只用了几毫秒。

真正慢的不是打开文件，而是每打开几页，Agent 就停下来重新问一次模型：“现在下一步做什么？”

```text
读文件
→ 回到 LLM
→ 再读文件
→ 回到 LLM
→ 提出 Patch
→ 回到 LLM
→ 应用 Patch
→ 再回到 LLM
```

这是一个很谨慎的工人。他不愿意在没有思考的情况下连续走太远。

问题是，他每次停下来思考，都要把之前看过的文件、执行过的命令、失败信息和 Patch 再带进模型一次。

他的背包开始变重。

第一轮 Provider Payload 是 317,775 bytes。到最后一轮，它变成了 688,685 bytes。进入模型的缓存 Context 从约 86,400 Token 增长到约 184,832 Token。

文件读完了，没有被放回书架；失败解决了，失败日志仍塞在包里；Patch 已经应用，完整 Diff 仍跟着下一轮继续前进。

后来我们看到的 13,134,945 个累计 Token，正是这只背包被反复搬进模型 96 次留下的脚印。它并不代表 Agent 学到了 1,313 万个不同的 Token，而是同一批历史被一遍又一遍地携带。

## 第三幕：它发现自己准备建造的房间，原来已经存在

计划中的第三项是实现 Markdown 表格。

Agent 先搜索：

```text
case "table"
renderToken
token.type
```

搜索连续返回 0。

如果它只相信搜索结果，很可能会新写一套表格渲染，然后和现有实现撞在一起。

但它没有直接动手。它继续读取 `markdown.ts`，终于在后半段发现了：

```text
renderTable(...)
```

表格渲染早就存在，而且实现得相当完整。

这一刻是整条 Trace 中很好的一个转折。Agent 没有为了完成计划而机械执行计划。证据改变后，它放弃了第三项开发，只保留 HorizontalLayout 和 ScrollView。

从观众角度看，这一幕说明模型并非只会向前冲。它能够承认最初判断不完整，并根据当前源码修正任务。

但这也暴露出另一个问题：上一轮分析时，Agent 曾把“Markdown table 缺失”列为高优先级问题。如果那一轮调查更准确，这一轮就不必花费多次搜索和读取来撤销一个错误前提。

一条不准确的分析结论，进入下一轮后会变成真正的开发成本。

## 第四幕：安全门拦住了它三次

组件写出来后，Agent 想运行更聚焦的测试。

它第一次调用 `run_command` 时漏掉了必填的 `operation`。Tool System 拒绝执行。

它换了一种方法，试图通过 `npx` 运行测试。权限系统再次拒绝。

它又想调用 `tsx`，甚至尝试在工作区外创建一个临时测试脚本。安全边界仍然没有放行。

在 Phoenix 里，这几次调用是红色的。

站在观众席上，这不是坏消息，反而是最值得确认的一段：模型确实会尝试自己认为方便的路径，但工具的存在并不等于模型拥有任意执行权。

安全门没有因为 Agent “正在做正事”就临时打开。

```text
Agent：我想运行 npx。
Tool System：不在允许范围内。

Agent：那我运行 tsx。
Tool System：仍不允许。

Agent：我创建一个工作区外脚本。
Tool System：路径越界，拒绝。
```

最终，Agent 回到被允许的结构化 npm script 上完成验证。

这证明我们设计的权限边界有效。但站在 Agent 的角度，它只听见门卫说“不行”，却没有听见“你应该走右边那扇门”。

于是它需要多试几次，才能猜到正确路线。

安全设计没有问题，恢复体验有问题。

一个更好的拒绝结果应该这样说：

```text
拒绝：不允许任意 npx 执行。

当前可用路径：
- run_command { operation: "npm_run", script: "test", cwd: "packages/tui" }
- run_task { task: "logos_agent_typecheck" }
```

边界没有放宽，但 Agent 不必再用下一轮 LLM 猜测工具的使用方式。

## 第五幕：Agent 手里的地图过期了

开发继续进行。

有几次，Agent 根据自己刚才读到的文件内容生成 `propose_patch`。但提交时，工具告诉它：

```text
oldText must occur exactly once; found 0
```

这样的错误一共出现了四次。

原因并不神秘。Agent 读取文件后，其他 Patch 或 `npm run check` 中的自动格式化已经改变了文件；但旧文件内容仍然留在 Context 中。模型拿着旧地图走到现场，才发现墙的位置已经变了。

`apply_edit` 没有迁就它。旧文本对不上，Patch 就不能应用。这同样说明安全机制是正确的：宁可拒绝，也不把补丁写到错误的位置。

Agent 只能重新读取文件，再生成新的 Patch。

问题不在拒绝，而在发现得太晚。

如果每次生成 Patch 前先比较“最近读取时的 hash”和“当前文件 hash”，系统可以更早提醒：

```text
文件未变化 → 继续生成 Patch
文件已变化 → 先刷新相关区域，再生成 Patch
```

这样仍保留严格校验，却可以少走四次“生成—拒绝—重读—再生成”的循环。

## 第六幕：绿色工具节点里，藏着失败的命令

整条 Trace 有 18 次 `run_command`。

最后真正成功的有 4 次；11 次命令返回 exit code 1 或 2；另外 3 次在参数校验或权限阶段就被拒绝。

奇怪的是，那 11 次已经运行、但以非零退出码结束的命令，在 Phoenix 中仍然显示为绿色 `OK`。

原因在观测层，而不是 Phoenix。

对当前 Harness 来说，工具函数成功返回了一份结果，所以 `toolResult.isError=false`。但对命令本身来说，exit code 1 明确表示失败。

两种“成功”混在了一起：

```text
工具调用成功：我们成功启动命令并拿到了结果。
命令执行失败：被启动的程序返回了非零退出码。
```

观众如果只看颜色，会误以为这些测试都成功了；只有展开输出，才能看到里面的失败信息。

这也是为什么仅仅“把数据接进可观测平台”还不够。观测系统必须理解业务语义，否则它只是准确记录了一个不准确的状态。

`run_command` 实际已经在 `details` 中返回了结构化的 `status` 和 `exitCode`，缺少的不是再造一份结果类型，而是把这份业务语义投影到统一的工具结果上：

```typescript
exitCode !== 0 || status === "timed_out" || status === "stopped"
  ? { isError: true }
  : { isError: false }
```

这样不需要复制 `stdout`、`stderr` 或命令状态，同一份结果就能同时服务三个角色：Agent 知道该恢复还是继续；TUI 知道该显示绿色还是红色；Phoenix 知道 TOOL Span 应该是什么状态。

## 第七幕：它终于走到了终点

失败并没有让 Agent 停下。

测试告诉它 `row.test.ts` 使用了 Node strip-only 模式不允许的 parameter property。它重新提出 Patch，将参数属性改成显式字段，再次应用。

随后：

```text
npm run check → exit code 0
packages/tui npm test → exit code 0
npm run check → exit code 0
```

Agent 调用 `reflect_task`，提交自己认为已经完成的证据：组件存在、导出完整、测试通过、全仓检查通过。

`reflect_task` 返回 `ready`。

它接着调用 `finish_task`，然后才进行第 96 次、也是唯一一次以 `stop` 结束的 LLM 调用，向用户汇报结果。

九点五十二分开始的工作，在十点零六分左右结束。

Phoenix 把根 Span 染成绿色。

这个绿色是成立的。任务最终确实完成了。

但现在再看它，绿色不再等于“过程顺利”，而是：

> Agent 经历了大量失败、拒绝和恢复，最后仍完成了任务。

这两句话看起来相似，却代表完全不同的系统质量。

## 中场复盘：问题到底在哪里

看完整场之后，很容易把问题归结为“模型太啰嗦”或“Agent 不够聪明”。

但这不是最准确的解释。

Agent 展现了不少正确能力：它会看源码、会修正计划、会根据测试修复代码、会尊重权限拒绝，也会在完成前验证结果。

真正的问题是，系统只给了它“继续工作”的能力，没有给它一条容易收敛的跑道。

它缺少四样东西。

第一，是一张短小稳定的任务卡。

用户说“优先级高的”后，系统没有把上一轮结论固化成独立任务契约。Agent 每一轮仍需要从庞大的会话里恢复目标。

第二，是清晰的阶段边界。

调查、实现、验证、恢复混在同一个细粒度循环里。每完成一个微小动作，模型就重新决定下一步。

第三，是会变轻的工作 Context。

已经读完的文件、已经解决的错误、已经应用的 Patch 一直留在背包里，没有在阶段结束时变成短摘要。

第四，是统一的工具结果语义。

“工具返回了结果”“命令执行成功”“任务最终完成”是三个不同层次，现在它们没有被清楚区分。

## 工程核对：工具 Interface 和 Context 管理怎样一起放大问题

回到代码后，我们确认这不是一个单点故障，而是两个变量相乘：

```text
累计处理 Token ≈ Provider 调用次数 × 每次 Provider Context 大小
```

工具 Interface 不清晰会增加左边的调用次数；旧工具结果一直留在 Context，会增加右边的单次输入。只修一边，都不能解释或解决这次 1,313 万 Token。

### 工具系统不是没有设计，而是只完成了安全语义

当前 `ToolSystem` 已经统一处理了能力、权限、审批、输入冻结、审计、结果脱敏和单次结果上限。这些机制确实挡住了越权操作，所以不能把 99 次工具调用简单归结为“工具系统很差”。

缺口出现在模型使用 Interface 和失败恢复上。

第一个例子是 `run_command`。模型熟悉的形式接近：

```text
Bash("npm run check")
```

但 Logos Agent 只接受结构化调用：

```json
{
  "operation": "npm_run",
  "script": "check",
  "cwd": "."
}
```

当模型漏掉 `operation`，或者尝试 `npx`、`tsx` 和管道时，权限系统正确地拒绝了它；但过去的错误经常只剩下一句 `Tool authorization failed: run_command`。模型无法从这句话推导出正确参数，只能再用一轮 LLM 猜测。

第二个例子是编辑协议。一次修改需要：

```text
propose_patch
→ Provider 再判断一次
→ apply_edit
→ Provider 再判断下一步
```

proposal 与 apply 分开有明确的安全价值，但它也把内部审批协议暴露给了模型。只要模型没有立即消费 `proposalId`，就会多出一次停顿或错误。后续可以把它深化成一个模型侧 `edit_file` Interface，在 Module 内部继续保留 Proposal、TUI 审批和 Apply；本轮修复不移除这段有意设计的审批语义。

第三个例子是陈旧 Patch。`read_file` 返回的是文本，没有把读取时的文件版本作为编辑前置条件。文件被其他 Patch 或格式化改变后，旧文本仍留在 Context，直到 `oldText must occur exactly once; found 0` 才暴露过期。那次任务为此经历了四次“生成—拒绝—重读—再生成”。

第四个例子是命令结果。`run_command` 已经返回 `exitCode`，但过去没有把非零退出投影为 `isError=true`。Agent 只能解析文字，Phoenix 则把失败命令显示成绿色。

因此当前工具 Module 的结论是：安全 Interface 清楚，模型可用 Interface、结果语义和恢复 Interface 不够清楚。

### 我们没有发送无限原始输出，但会重复发送所有有界结果

代码核对还确认了第二个问题。

单次工具输出已经受到限制：

- `read_file` 最多读取 500 行，模型侧文本最多约 64 KiB；
- `search_text` 最多返回 100 条，每条最多 500 个字符；
- `run_command` 的 stdout 和 stderr 各自最多保留 32 KiB；
- `ToolSystem` 会再次脱敏，并把一次模型可见结果限制在最多 64 KiB。

所以进入 Message 的并不是无限原始输出，而是“经过单次截断和脱敏后的完整结果”。

问题在跨轮生命周期。工具结果生成 `toolResult` Message 后会写入 Session；下一轮 Harness 再次 `buildContext()`，原有 `model-context` 只注入 CodeGraph 上下文，并不清理历史工具结果。于是同一个长 Turn 内形成：

```text
第 1 轮：A
第 2 轮：A + B
第 3 轮：A + B + C
第 4 轮：A + B + C + D
```

单个 A、B、C 都不超过 64 KiB，但 99 次工具调用形成的 Message 会在后续 96 次 Provider 请求中被反复携带。这与观测到的 Payload 从 317,775 bytes 增长到 688,685 bytes 完全一致。

### 本轮修复放在两个不同的 seam

单次调用语义仍放在 `ToolSystem`：

- `run_command` 非零退出、超时和停止现在投影为 `isError=true`；
- 授权失败会返回被支持的结构化调用方式，并明确说明 shell 字符串、管道、`npx`、`tsx` 和任意可执行文件不受支持；
- 权限范围没有放宽，审计和脱敏继续执行。

跨轮历史放在 Provider Context seam，而不是塞进每个工具：

- Session 继续保留完整的受治理工具结果，不修改审计历史；
- 每次 Provider 请求前，对 Read、Search、Git、Command、Task 和 Web Search 等高体积结果应用 128 KiB 的历史预算；
- 至少保留最近两个可压缩结果，维持当前工作连续性；
- 超出预算的旧结果替换为包含工具名、成功或失败、原始字节数和首行摘要的短标记；
- `proposalId` 等有状态的编辑协议结果不参与自动折叠，避免破坏尚未消费的操作；
- 工具调用与工具结果 Message 仍然成对存在，不会产生 Provider 无法接受的孤立结果。

模型看到的折叠结果类似：

```text
[Older tool result compacted for this provider request]
tool=read_file outcome=success originalBytes=52144
summary="src/tui.ts":1-500 of 1200 (truncated)
The full result remains in Session history. Re-run a bounded tool call if exact content is needed.
```

这不是完整 Compact，也不会调用另一个 LLM 生成摘要。它是一层确定性的工作集投影，先解决最明显的工具输出重复搬运问题。完整自动 Compact、文件版本校验以及 edit Interface 深化仍需要后续实现和同基线重放验证。

## 系统级审计：问题不只在 `run_command`

继续检查全部工具后，结论需要再向前走一步：刚才的修复解决了真实症状，但不能证明整个工具系统已经形成统一设计。

当前 `ToolSystem` 更接近一个中心注册器和 Harness 前后钩子：它统一了权限、审批、审计、最终结果脱敏和单次结果上限，但工具真正的 `execute`、partial update、业务 outcome、失败恢复、Context 生命周期和 UI 表达仍由不同文件分别决定。

这会形成一条危险的扩散路径：

```text
新工具加入
→ 在 logos-tools.ts 声明 capability 和 guidance
→ 在工具文件里自定义 stage、错误文本和结果 details
→ 在 model-context.ts 决定它是否需要压缩
→ 在 transcript-tool-block.ts 增加工具名分支
→ 如果需要审批，再修改 LearningApprovalSubject 和审批卡片
→ 在 logos-agent.ts 增加任务证据或特殊结果解释
```

也就是说，新增一个工具并不只需要理解一个 Interface，而要同时理解五六处约定。Agent 在运行时反复试错，开发者在设计时也容易反复补漏。这正是浅 Module 的特征：复杂度没有消失，只是被分散到了调用方。

### 同类问题已经出现在其他工具上

`run_task` 和 `run_command` 都执行进程，但结果语义没有来自同一个 Contract。`run_command` 现在已经把非零退出映射为 `isError=true`，`run_task` 仍只是返回带 `exitCode` 的成功对象。如果固定测试返回 1，模型、TUI 和 Phoenix 仍可能再次面对“调用成功、业务失败”的歧义。

`code_explore` 在索引不存在时会返回可读的 fallback 提示。这既不是普通 success，也不是需要终止任务的 failure，更准确的状态应当是 `degraded`。当前结果模型只有 `isError`，无法稳定表达这种第三种状态。

历史工具结果是否折叠，目前由 `model-context.ts` 中的工具名集合决定。它能控制当前已知工具，却不是一份可继承的规范：下次增加高体积工具，如果忘记把名称加入集合，它的全部历史输出又会开始在 Provider 请求间累积；如果增加 proposal 一类状态工具，又需要记得人工排除。

TUI 也在重复解释工具。`transcript-tool-block.ts` 使用 `switch (toolName)` 拼接 `Read(...)`、`Bash(...)`、`Git(...)` 等标题，并再次读取 `exitCode` 判断红绿。审批卡片则了解 edit、command、task、process stop 等全部业务类型。结果语义一旦变化，模型、ToolSystem、TUI 和 Phoenix 必须同步修改，否则就会出现多套真相。

还有一个容易忽略的指标问题：`getContextInfo()` 当前估算的是 `session.buildContext()`，而不是经过工具结果投影后的 Provider Context。因此 `/context` 展示的是 Session 全量规模，不是下一次请求真正发送给模型的规模。它可以作为保守的 Compact 指标，但不能标成最终 Provider 用量。

### 因此需要 Tool Contract，而不是继续增加条件分支

统一并不意味着让一个类承担所有职责。正确的 seam 是：

- ToolSystem 管理单次调用的策略、执行生命周期和归一化结果；
- operations adapter 只做受约束 I/O；
- Context Manager 根据工具声明的 retention 管理跨轮工作集；
- Presenter 只渲染 ToolSystem 提供的普通数据视图；
- Session 保留完整受治理历史，Observability 消费同一份 outcome。

所有工具至少需要统一声明：模型选择规则、capability 与 risk、授权方式、结果分类、恢复动作、Context 保留方式、UI 视图和审计摘要。预期拒绝不能只抛异常；partial update 也必须经过与最终结果相同的脱敏和大小治理；UI 不应再根据工具名推断业务状态。

完整规范已经单独整理为 [`tool-system-contract.md`](./tool-system-contract.md)。其中包括强制 Tool Contract、权限 profile、统一 outcome、Context retention、UI/Observability 规则、迁移优先级和新增工具的 conformance gate。

这次系统级审计后的准确结论是：

> 现有工具的安全 Adapter 大多设计得较扎实，但 ToolSystem 的外部 Interface 仍然偏浅。继续逐个新增工具或修补展示，会让特殊规则持续扩散；下一步应先建立统一 Contract 和共享合规测试。

## 第二次排演：如果让它重新做一遍

我们不能假装第二次执行已经发生。下面这段是基于真实失败路径重写的“导演版剧本”，它必须在代码改造后通过同一 Git 基线、同一任务重放来验证。

这一次，用户仍然只说：

> 优先级高的

但 Harness 不再只把这句承接上文的话直接扔进漫长循环。它先根据上一轮结论生成一张任务卡：

```text
目标：实现已经确认的高优先级 TUI 改进
范围：packages/tui
候选：HorizontalLayout、ScrollView、Markdown table
验收：组件测试通过、导出完整、npm run check 通过
当前阶段：investigate
```

Agent 第一轮集中读取布局、滚动、Markdown 和导出相关的核心文件。它当场发现 `renderTable` 已经存在，于是把 Markdown table 从交付项中划掉。

调查阶段结束后，系统没有继续携带全部源码，而是留下这样一份工作集：

```text
已确认：Markdown table 已实现，无需修改
待实现：HorizontalLayout、ScrollView
相关文件：tui.ts、keybindings.ts、index.ts、对应 tests
验收命令：packages/tui test；root check
```

原始文件仍保存在 Session 树和 Phoenix 中，可以随时追溯，但不再每轮塞给模型。

接下来 Agent 一次完成一批协调修改，再运行受支持的 focused test。它不尝试 `npx` 和 `tsx`，因为工具描述已经明确告诉它允许的验证方式。

如果测试失败，`run_command` 返回：

```text
outcome=failure
exitCode=1
rootCause=TS1294 parameter property is not allowed
```

Phoenix 中这个 TOOL Span 变红，但根任务仍保持运行。Agent修复一次，再执行 focused test；通过后只运行一次最终全仓 check。

最后，`reflect_task` 对照任务卡逐项确认，`finish_task` 收口，Agent汇报结果。

理想情况下，观众看到的不再是一棵蔓延 196 个节点的树，而是一条有清晰章节的路径：

```text
AGENT turn
├─ INVESTIGATE
│  ├─ 集中读取核心文件
│  └─ 更新任务卡：Markdown 已存在
├─ IMPLEMENT
│  ├─ HorizontalLayout
│  └─ ScrollView
├─ VERIFY
│  ├─ focused test：失败
│  ├─ 修复一次
│  ├─ focused test：通过
│  └─ full check：通过
└─ COMPLETE
   ├─ reflect：ready
   └─ finish
```

我们希望重放后看到这些变化：

| 观众看到的指标 | 第一次实际执行 | 第二次排演目标 |
|---|---:|---:|
| 总耗时 | 820.7 秒 | 少于 360 秒 |
| 累计处理 Token | 13,134,945 | 少于 3,000,000 |
| LLM 调用 | 96 次 | 少于 30 次 |
| 工具调用 | 99 次 | 少于 45 次 |
| 未授权命令尝试 | 3 次 | 0 次 |
| 陈旧 Patch | 4 次 | 不超过 1 次 |
| 非零命令退出 | 11 次 | 不超过 3 次 |
| 最大 Payload | 688,685 bytes | 少于 400,000 bytes |
| Context 增长 | 2.17 倍 | 少于 1.40 倍 |
| 最终测试与检查 | 通过 | 仍然通过 |
| 权限边界 | 未绕过 | 保持不变 |

这里最后两行最重要。

优化不是让 Agent 少做必要验证，也不是为了追求速度而放开权限。我们要去掉的是无信息增益的重复，而不是可靠性。

## 我们应该从哪里开始改

第一步，不是立刻限制 Agent 最多只能循环多少次。

如果简单设置“最多 30 轮”，这次任务可能在测试仍失败时被强行截断。数字可以报警，不能代替收敛机制。

应该先让观测数据说真话：给 `run_command` 增加结构化 outcome，让 exit code 1 的 TOOL Span 真正显示红色；根 Turn 则在最终恢复成功后保持绿色。这样我们能同时看到“中间失败”和“最后完成”。

第二步，是让拒绝带有方向。权限系统仍然拒绝任意命令，但返回允许的替代方案，减少模型用多轮调用试探边界。

第三步，是建立 Task Contract 和阶段状态。让 Agent 知道自己现在是在调查、实现、验证还是恢复，也知道进入下一阶段需要什么证据。

第四步，是在同一个 Turn 内压缩工作集。压缩不能静默发生，TUI 应实时展示：哪些原始消息被摘要，保留了哪些事实，原文在哪里展开查看。

第五步，才是编辑和验证上的细节优化：Patch 前检查文件 hash；优先运行 focused test；只有最终代码稳定后再运行全仓 check。

## 那个越来越重的背包，原来还有一个登记问题

我们继续往下检查 Context 时，发现问题不只在于“旧工具输出太多”，还在于系统用两本名单管理同一件事。

一个工具在 `logos-tools.ts` 注册功能和权限，但它的旧输出是否允许压缩，却要去 `model-context.ts` 的另一份工具名名单里登记。假设后来新增一个 `read_database` 工具，开发者不仅要实现并注册它，还必须记得把 `read_database` 再写进压缩名单。

如果忘了第二次登记，工具仍然可以正常运行，测试也未必立刻报错。但它返回的大段内容会继续进入后面的 Provider 请求。Agent 每走一轮，都可能重新背上同一批旧结果：第一次多一万 Token，下一次继续携带这一万，再下一次还在携带。直到 Trace 已经明显变重，我们才会发现这个工具从未进入 Context 治理。

更麻烦的是，从工具注册处看不出这条规则。理解一个工具需要同时翻两个文件，并相信两份名单始终同步。这正是容易让新增工具悄悄扩大 Context 的设计缺口。

现在，工具在注册时直接说明自己的历史如何处理：

```typescript
{
  tool: readDatabase,
  context: { history: "compact" },
}
```

这表示旧结果可以在保留近期工作集后被压缩。像编辑提案这样带有 `proposalId`、后续仍要使用的状态，则明确声明：

```typescript
{
  tool: proposePatch,
  context: { history: "preserve" },
}
```

这次修改没有再建立一套庞大的 Context 框架。逻辑只有一条：工具声明，`ToolSystem` 汇总，Context 层执行。以后新增工具时，不再需要记住另一份隐藏名单。

## 后来，一句“大模型缓存”又把问题照亮了一次

前一轮修复完成后，我又打开了一条新的 Trace。这次用户只是在纠正方向：

> 我说的是大模型缓存

任务比十三分钟那次更小。Agent 没有改代码，也没有执行项目命令，却仍然工作了 2 分 33 秒，调用模型 26 次、工具 29 次，累计处理 1,419,804 Token。

其中 1,383,040 Token 来自缓存读取，占 97.9%。缓存再次压低了费用，却没有让 Agent 少做决定，也没有阻止 Provider Payload 从 128,818 bytes 增长到 255,866 bytes。

我沿着 29 个工具节点往下看，搜索占了几乎一半：

```text
search_text  15 次
read_file     9 次
code_explore  3 次
```

真正重要的不是“搜索次数很多”，而是 15 次搜索里至少有 7 次写成了正则表达式：

```text
cacheWrite|cacheRead|cache.*break
cache_control|cacheControl|prompt_cache
cacheRetention|cache_retention|cacheSession
```

模型想问“这些候选词任意一个出现在哪里”，当时的 `search_text` 却只做字面量包含判断。它实际寻找的是一整串包含竖线和星号的文字，然后安静地返回 0 条结果。模型无法区分“代码里没有”与“搜索语言用错了”，只能换一个词再试。

每一次重试都很便宜，但结果会进入 Message；下一轮模型又带着旧搜索、旧解释和新猜测继续前进。工具 Interface 增加 Provider 调用次数，工具结果扩大后续 Context，两边再次相乘。

### Claude 真正依赖的不是“让模型随便执行 Bash”

我随后检查了本地 Claude Code。第一眼确实能看到大量 `grep`、`rg` 和 shell 代码，但它的主提示词优先要求模型使用专用 `Grep`，而不是用 Bash 执行 grep。

这个专用工具内部由 ripgrep 支撑，向模型提供它已经熟悉的搜索语言：正则、path、glob、content/files/count 模式、上下文行、大小写、分页和结果上限。中断、忽略目录和宽行治理藏在工具内部。只有专用工具不能表达的组合任务才退回 Bash，而 Bash 后面还有命令解析、权限、沙箱、终止和后台进程等大量实现。

Claude 对大结果也没有简单地全部塞回下一轮。超过阈值的结果会写入本地 `tool-results`，模型先看到短预览和可追溯路径；同一条结果一旦决定如何投影，恢复和分支会复用相同文本，避免旧 Prompt 前缀不断变化。

所以 Claude 做对的不是工具数量，而是两件事：

1. 模型侧 Interface 符合模型已经学会的语言，一次调用能表达足够多的搜索意图；
2. 安全、执行和 Context 治理藏在工具内部，不要求模型理解内部协议。

### 问题的本质是模型侧带宽太低，系统侧复杂度又泄漏了出来

原来的 `search_text` 很安全，也有严格边界，但它太浅：一个查询只能表达一个字面量，不能用候选词、glob、结果模式或上下文行缩小证据。模型必须用多轮调用模拟一个本应由一次搜索表达的意图。

```text
表达能力不足
→ 拆成多次猜测
→ 每次都回到 LLM 决策
→ 低价值结果进入历史
→ Context 越来越偏离原问题
```

因此修复不能只是提高返回上限，也不能简单开放任意 Bash。前者只会返回更多低密度文本，后者会把权限和跨平台复杂度一起暴露出来。

### 这次落地：把搜索做成一个深工具

Logos Agent 的模型侧搜索现已收敛为 `grep`：

```text
grep({
  pattern: "cacheWrite|cacheRead|cache.*break",
  path: "packages/ai",
  glob: "**/*.ts",
  outputMode: "content",
  context: 2,
  maxResults: 50,
  offset: 0
})
```

模型只理解这一份契约。工具内部继续使用注入的 workspace operations，不读取全局 CWD，并统一负责路径与敏感目录边界、有界正则校验、简单 glob、三种结果模式、上下文行、大小写、分页、`AbortSignal`、进度更新、控制字符清理和 Context 历史压缩声明。为降低同步正则阻塞中断的风险，当前 adapter 拒绝容易产生不可控回溯的正则结构，并跳过超长单行；这是一层明确的风险边界，不冒充操作系统级实时保证。

这次没有照搬 Claude 的完整 Bash 系统，也没有为了调用 ripgrep 新增一个必须信任的外部进程边界。搜索语义先在现有只读 operations adapter 内落地；以后如果性能数据证明需要切换到 ripgrep，只替换 adapter，模型契约、权限、TUI 和 Context 规则都不需要变化。

路由也随之收敛：明确的符号、字符串和文件证据先用 `grep`；只有架构、调用链和影响范围这类关系问题才使用 `code_explore`；图索引陈旧时回到 `grep` 和 `read_file`，不再反复查询同一份过期图。

这不是给 Agent 增加“更多工具”，而是删除一个需要反复猜测的浅 Interface，换成一个能一次说清问题的深 Interface。

## 再后来，两次 CodeGraph 探索让地图本身变成了背包

`grep` 修好以后，我又连续观察了两个看代码的任务。

第一个问题很宽：

> 我想重新设计 TUI，你给我一些思路。

这不是要求立即修改代码，只是希望 Agent 先理解现有 TUI，再给出设计方向。它工作了 62 秒，调用模型 7 次、工具 12 次。其中 `code_explore` 2 次、`list_files` 2 次、`read_file` 8 次。

两次 CodeGraph 查询一共返回约 48,662 个字符。Agent 随后又读取了多份文件，调查范围从 `apps/logos-agent` 扩展到了 `packages/tui` 和 `packages/coding-agent`。最后它确实给出了建议，但为一次设计讨论累计处理了 198,987 Token；Provider Payload 从 40,108 bytes 增长到了 167,655 bytes。

第二个问题已经具体得多：

> 看下当前事件处理这块是怎么做的，我想将一个回复中相同的使用工具合并，像树一样展开。

这一次，新的原生 `grep` 表现得很好。Agent 用一次调用同时搜索：

```text
handleEvent|tool_execution_start|tool_execution_end|ToolExecutionComponent
```

213 毫秒后，它拿到了 12 个精确结果。搜索语言没有再让模型拆成多次猜测。

但整个任务仍持续了 48.4 秒，调用模型 6 次、工具 8 次：`code_explore` 2 次、`read_file` 5 次、`grep` 1 次。两次 CodeGraph 输出约 50,800 个字符，全部工具输出约 94,300 个字符，累计处理 214,835 Token。

两次任务放在一起，数据变成：

| 指标 | 两次任务合计 |
|---|---:|
| 总耗时 | 约 1 分 50 秒 |
| LLM 调用 | 13 次 |
| 工具调用 | 20 次 |
| 累计处理 Token | 413,822 |
| 缓存读取 Token | 337,152 |
| 新输入 Token | 71,444 |
| 模型输出 Token | 5,226 |
| 工具输出 | 约 207,000 字符 |
| CodeGraph 输出 | 约 99,000 字符 |

新的 `grep` 已经减少了搜索试错，但 Provider Context 仍然快速增长。问题从“模型不会正确搜索”转变成了“模型拿到了一张太厚、而且可能重复的地图”。

### 我们原来只打开了 CodeGraph 最重的一扇门

为了确认这是不是 CodeGraph 自身的限制，我没有继续从 Logos Agent 的包装反推，而是直接检查并运行了本机实际安装的 CodeGraph 1.5.0。

它索引了当前仓库的 1,013 个文件、16,963 个节点和 73,353 条边。它并不只有 `explore`：

| CodeGraph 原生能力 | 实际语义 |
|---|---|
| `query --json` | 按名称搜索符号，只返回位置和类型 |
| `node` | 查看一个符号的结构、源码和 caller/callee trail；也能只返回文件符号表 |
| `callers/callees --json` | 获取一个符号的直接调用关系 |
| `impact --json` | 按深度计算修改影响范围 |
| `files --json` | 从索引查看项目文件结构 |
| `affected --json` | 根据变更文件寻找受影响测试 |
| `explore` | 一次组合相关符号、调用路径、影响范围和当前磁盘源码 |

我对同一仓库做了几次只读实测：

| 查询 | 返回规模 |
|---|---:|
| `query ToolSystem --json` | 直接定位类、属性和方法 |
| `callers getTools --json` | 846 bytes |
| `callees onToolCall --json` | 1,607 bytes |
| `node ToolSystem` | 2,602 bytes，31 行 |
| `node --file tool-system.ts --symbols-only` | 4,041 bytes，52 行 |
| `impact ToolSystem --depth 2 --json` | 6,202 bytes |
| `explore ... --max-files 2` | 16,636 bytes，383 行 |

CodeGraph 已经提供了轻量结构化入口，但 Logos Agent 只暴露了最宽的 `code_explore`。模型想找一个符号、看一个节点或确认一条调用边，都只能先推开 `explore` 这扇大门。

当前包装还增加了三个偏差。

第一，Logos Agent 暴露了 `scope`，但 CodeGraph 原生 `explore` 没有这个参数。Adapter 只是把路径拼成一句 `Prioritize these workspace-relative paths` 追加到自然语言查询中。这个 Interface 看起来像精确范围控制，实际只是提示词建议。

第二，对当前 1,013 文件的仓库，CodeGraph 原生会把一次 `explore` 控制在约 24,000 字符，并建议最多探索 2 次；Logos Agent 又在外层设置了 40 KiB 工具上限。这个上限通常并不能进一步治理结果。相反，自动预取只保留前 16 KiB，可能把 CodeGraph 已经组织好的输出从中间切断，然后模型又调用一次 `code_explore` 补齐。

第三，当前索引有 12 个新增文件和 24 个修改文件尚未同步。实测 `query routeCodeContext` 返回空结果，但 `query ToolSystem` 可以正确定位旧索引里的定义。`explore` 返回的源码会重新从磁盘读取，因此源码可以是新的；调用关系和符号索引却仍可能是旧的。把“当前源码”和“陈旧关系”放在同一个大文本里，模型很难判断每一部分应该信到什么程度。

CodeGraph 没有失效。真正的故障是我们把一个拥有多种查询语义的系统，包装成了单一的大文本生成器。

### 地图应该负责指路，源码应该负责作证

新的工具 Interface 不再发明一个 `code_query(action=...)`，也不再只保留一个万能 `code_explore`。它直接组合模型和 CodeGraph 已经熟悉的原生语义：

```text
grep
  精确文本、正则、事件名、错误码

read_file
  当前磁盘源码，作为最终事实

codegraph_search
  符号定义位置，不返回大段源码

codegraph_node
  已知符号的结构和调用轨迹

codegraph_explore
  多符号调用链、动态分派和跨模块关系

codegraph_impact
  修改前的影响范围
```

`files` 已有 `list_files` 覆盖；`callers/callees` 已包含在 `node/explore` 的轨迹中；`affected` 等验证流程稳定后再决定是否开放。首版不把所有 CodeGraph 命令都堆给模型。

这套工具背后的 Module 负责隐藏真正复杂的部分：

- workspace root 由 Harness 注入，模型不能传任意 `projectPath`；
- Adapter 直接使用 CodeGraph 原生命令和参数，不再伪造 `scope`；
- 每轮缓存一次索引状态，并在结果中明确区分“源码当前”与“关系陈旧”；
- 同一 Turn 内按规范化参数去重，重复调用返回已有结果引用；
- `codegraph_explore` 第一次可以把有用源码交给模型，但后续 Provider 请求只保留查询、覆盖文件、关键符号、关系和新鲜度；完整原文仍留在 Session 与 Observability；
- 自动隐藏的 `explore` 预取被移除。每一份大上下文都必须对应一个模型可见、可解释的工具决定；
- `init` 和 `sync` 仍是用户或 TUI 的管理动作，不因为模型需要新索引就自动修改工作区状态。

于是两个场景会走不同的路线。

“重新设计 TUI”先用 `codegraph_search` 或文件结构找到当前应用的 TUI 入口，再对少量核心符号使用一次 `codegraph_explore`。它不应该一开始就在三个包之间展开两次大范围探索。

“合并相同工具调用”已经给出了明确事件名，因此先用一次 `grep` 定位，再用 `codegraph_node` 查看 `handleEvent` 的调用轨迹；只有确实存在跨模块动态分派时，才升级到 `codegraph_explore`。

```text
明确名称 ──→ grep ──→ read_file / codegraph_node

未知结构 ──→ codegraph_search ──→ codegraph_node

跨模块关系 ──→ codegraph_explore

准备修改 ──→ codegraph_impact ──→ focused tests
```

这里的目标不是让 Agent 永远少用 CodeGraph，而是让每次调用都使用它最独特的能力。文本搜索不再假装理解关系，CodeGraph 也不再替每一次精确定位携带整段源码。

### 这次故障怎样验收修复

仍然重放上面两个问题，并保留当前实现作为基线：

| 指标 | 当前两次执行 | 修复目标 |
|---|---:|---:|
| `codegraph_explore` 重复查询 | 4 次调用 | 同参数重复为 0 |
| CodeGraph 输出 | 约 99,000 字符 | 降低至少 60% |
| 累计处理 Token | 413,822 | 降低至少 50% |
| LLM 调用 | 13 次 | 不超过 8 次 |
| 工具调用 | 20 次 | 不超过 12 次 |
| 精确事件搜索 | 1 次成功 | 继续保持 |
| 源码事实验证 | 已执行 | 继续保持 |
| 索引陈旧状态 | 混在结果中 | 每次关系结果明确展示 |

最后三项比单纯减少 Token 更重要。优化不能靠删除必要证据完成；我们要删除的是重复和错配，让 `grep`、当前源码与关系图各自说自己最擅长的那部分真话。

## 测试没有变成终点的闸门，而是回到了循环里

工具和 Context 的问题逐渐清楚后，我们又发现故事里还缺最后一段：Agent 写完代码以后，谁提醒它真正跑一次测试？

最直接的工程反应，是在 `finish_task` 前增加一道硬检查。只要系统没有找到成功的测试记录，就拒绝结束任务。这个方案看起来可靠，却很快暴露出新的问题：文档修改、配置解释和无法启动完整环境的任务，并不总有一条合适的测试命令；同一条命令也可能是构建、启动服务或者生成文件，系统很难只根据工具名称判断它是不是有效验证。为了补齐这些例外，我们又会开始增加状态、分类和绕过条件。

于是我们回头检查 Claude 的普通执行流程。它的基础 AgentLoop 并没有在停止条件里寻找测试记录。Plan 只要求写清验证方式；系统提示词要求模型如实报告检查结果；真正的测试仍由模型通过普通工具循环执行：

```text
修改代码
→ 选择与修改相关的检查
→ 运行测试、类型检查、lint、build 或运行时检查
→ 读取真实输出
→ 失败则修复并重跑
→ 通过或明确说明环境限制
→ 汇报结果
```

这和那条十三分钟 Trace 最后真正成功的方式一致。测试第一次指出 `row.test.ts` 的 parameter property 问题后，Agent 没有因为一次失败就结束，也不是由另一个计划执行器接管；失败结果回到同一个上下文，模型修复代码，再次运行检查，直到 exit code 变成 0。

因此这次没有增加独立验证 Agent，也没有给 `finish_task` 增加测试门禁。我们只把这条已经存在但表达不够具体的行为写进核心提示词：修改后先从项目说明和配置中寻找相关检查；优先运行 focused test；失败时根据真实输出诊断、修复和重跑；后续修改如果影响已经验证的行为，需要重新检查；没有适用测试或环境无法执行时，必须明确说明没有验证什么以及原因。`run_task` 的局部说明也加入了同样的恢复路径。

TaskRun 仍然记录 verification evidence，但它的角色是观测，不是裁判。Phoenix 和 TUI 可以用这些数据回答“Agent 实际运行了什么、结果如何”，却不会因为一条缺失的记录机械阻止任务结束。`reflect_task` 和最终回答负责解释证据，但不能凭文字把失败说成通过。

这项优化希望带来三种效果：

- 对代码任务，测试失败会自然触发“诊断—修复—重跑”，而不是在失败后直接汇报完成；
- 对没有适用测试的任务，不会为了通过系统门禁运行无关命令或伪造验证；
- 测试规则进入稳定的系统提示词后，模型不需要从每次临时 Plan 或错误恢复中重新猜测完成标准。

当前能确认的是实现本身已经通过 4 项提示词回归测试和全仓 `npm run check`。这些结果只能证明新规范被正确注入且没有破坏仓库检查，不能证明真实 Agent 执行已经减少了多少 Provider 请求或 Token。它的运行效果仍需要用下一条包含实际代码修改的 Trace 验证，重点观察：修改后是否主动执行相关检查、失败后是否继续修复、最终回答是否准确引用真实结果，以及是否出现为了“完成验证”而运行的无关命令。

## 故事结束后，我又看了一眼那条绿色 Trace

它还是绿色的。

但我现在知道，绿色只是结局，不是过程。

这条 Trace 最有价值的地方，并不是证明 Agent 能写出两个组件。它让我们第一次像坐在控制室里一样，看见模型如何理解任务、如何调用工具、如何撞上安全边界、又如何把同一段越来越重的 Context 搬进模型 96 次，最终累计处理 1,313 万 Token。

它也改变了下一步优化的方向。

我们不应该先给 Agent 更多工具、更大权限或更长 Context。它已经拥有足够的行动能力。现在真正缺少的是：一张不会丢失的任务卡，一条分阶段的跑道，一个会主动变轻的背包，以及一套能把失败和恢复讲清楚的观测语言。

下一次，当用户再次说出一句模糊但自然的话，我们希望 Agent 仍然能完成同样可靠的工作。

只是不用再花 1,313 万 Token、跑 196 个 Span，才走到终点。

---

## 事实附录

本文使用的关键观测事实：

- 根 Turn 输入：`优先级高的`；
- 根 Turn 状态：OK；
- 总耗时：820.719 秒；
- 96 个 LLM Span，其中 95 次 `toolUse`、1 次最终 `stop`；
- 99 个 TOOL Span；
- 18 次 `run_command`；
- 8 个工具调用被明确标记为 ERROR；
- 11 个命令返回非零 exit code，但工具 Span 仍显示 OK；
- 首轮 Payload 317,775 bytes，最终 Payload 688,685 bytes；
- 累计 Token 13,134,945：缓存读取 13,029,376、新输入 68,366、模型输出 37,203，其中 reasoning 13,463；
- 累计模型成本约 `$0.1093`；
- 最终 `npm run check` 与 TUI 测试均返回 exit code 0；
- `reflect_task` 返回 ready，随后 `finish_task` 完成任务。

补充 Trace“我说的是大模型缓存”的关键事实：

- 总耗时 2 分 33 秒；
- 26 次 LLM 调用、29 次工具调用；
- `search_text` 15 次，其中至少 7 次把正则表达式交给了字面量搜索；
- 累计处理 1,419,804 Token：缓存读取 1,383,040、新输入 30,131、模型输出 6,633；
- 缓存读取占 97.9%；
- Provider Payload 从 128,818 bytes 增长到 255,866 bytes；
- 这条 Trace 说明高缓存命中率可以降低新增计算和费用，但不能修复低信息密度工具导致的多轮试错。

补充两个 CodeGraph 场景的关键事实：

- “重新设计 TUI”耗时 62 秒，7 次 LLM、12 次工具调用，累计处理 198,987 Token；
- 该场景调用 `code_explore` 2 次、`list_files` 2 次、`read_file` 8 次，CodeGraph 输出约 48,662 字符；
- “合并相同工具调用”耗时 48.4 秒，6 次 LLM、8 次工具调用，累计处理 214,835 Token；
- 该场景调用 `code_explore` 2 次、`read_file` 5 次、`grep` 1 次；原生正则一次命中 12 个结果；
- 两个场景合计处理 413,822 Token，产生约 207,000 字符工具输出，其中 CodeGraph 约 99,000 字符；
- 本机 CodeGraph 1.5.0 索引包含 1,013 个文件、16,963 个节点和 73,353 条边；检查时有 12 个新增文件、24 个修改文件尚未同步；
- CodeGraph 原生提供 `query`、`node`、`callers`、`callees`、`impact`、`files`、`affected` 和 `explore`，当前 Logos Agent 只向模型开放了最重的 `explore` 语义。

补充测试闭环优化的关键事实：

- Claude 的普通 AgentLoop 没有把测试证据作为统一停止门禁，测试主要由系统提示词和工具结果驱动；
- Logos Agent 没有增加独立验证 Agent、完整 Plan Mode 或 `finish_task` 测试拦截；
- 核心提示词现在明确要求修改后选择相关检查，失败后根据真实输出修复并重跑，后续相关修改需要重新验证；
- TaskRun 的 verification evidence 继续用于观测和复盘，不作为完成权限；
- 提示词回归测试 4 项通过，修改后的全仓 `npm run check` 通过；
- 对 Provider 调用、Token 和测试行为的实际影响尚未重放测量。

“第二次排演”的指标是优化验收目标，不是已经发生的实测结果。
