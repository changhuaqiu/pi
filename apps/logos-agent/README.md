# Logos Agent (λόγος)

**logos** — λόγος in ancient Greek: reason, order, and the principle of structured
understanding. Not raw text processing — this agent reads code structures through
CodeGraph, follows a disciplined observe→propose→apply→verify loop, and keeps its
tool system governed by explicit contracts rather than ad-hoc logic. Every file it
reads, every edit it proposes, every approval it requests is reasoned — never
guessed.

一个真实 Provider 驱动的最小 TUI Agent，支持 OpenAI、Anthropic 和 DeepSeek。运行时链路是：

```text
TUI -> LogosAgent -> AgentHarness -> Agent loop -> Provider
                       |             |
                       |             +-> workspace_info
                       +-> JSONL Session
```

当前边界：

- 连接 OpenAI 或 Anthropic 的真实模型，不在运行时使用 Faux Provider。
- 提供 `workspace_info`、`list_files`、`read_file`、`grep` 四个工作区只读工具。
- 提供默认允许的 `ask_user`，在关键需求无法从工作区确认时暂停并显示带说明的选择界面。
- 提供 `git_status`、`git_diff`、`git_log`、`git_show`、`git_blame` 五个 Git 只读工具。
- 提供 `propose_patch`、`propose_create_file`、`propose_delete_file` 和 `apply_edit` 受控编辑工具。
- 提供默认自动允许的 `create_directories`，可在工作区内一次递归创建最多 32 个目录，不执行 shell。
- 提供默认自动允许的 `run_task`，仅能运行 Logos Agent 测试或类型检查。
- 提供默认自动允许的 `run_command`，用于安装 npm 依赖、运行 `package.json` 脚本和管理开发服务器。
- 提供只读的 `command_status` 与默认自动允许的 `stop_command`，用于检查和终止受管进程树。
- 只能读取注入工作区内的有界元数据、目录结构和文本源码。
- 工具执行支持 `AbortSignal` 和 `onUpdate`。
- `beforeToolCall` 产生审计事件，`afterToolCall` 对结果脱敏。
- 不提供 shell 字符串、管道、重定向、环境覆盖或任意可执行文件；项目命令使用结构化参数和 `shell: false`。

Git 读取边界：

- Git 命令通过注入的 operations 适配器执行，不读取全局 CWD，也不使用 shell。
- 注入路径必须是包含本地 `.git` 目录的仓库根目录；为避免元数据逃逸，暂不支持 `.git` 文件形式的 linked worktree。
- Git 目录内的链接和外部 object alternates 会被拒绝，命令行固定仓库目录与 worktree。
- 路径必须是工作区相对路径；revision 拒绝选项注入和控制字符。
- 每个工具调用的完整执行过程最长 15 秒；脱敏后最终返回给模型的文本不超过 64 KiB。
- `git_diff`、`git_show` 的大 patch 会截断并明确标记；工具不会执行 checkout、add、commit、reset 或 push。
- 所有 Git 工具同样经过 `beforeToolCall` 审计和 `afterToolCall` 脱敏。

询问用户策略：

- Agent 必须先检查代码、配置、工作区说明和已有工具证据；可查明的问题不得询问用户。
- 只有答案会实质改变结果、继续猜测有明显风险时才调用 `ask_user`，例如目标环境、互斥产品方案或冲突需求无法确定。
- 进度汇报、可逆的小选择、已默认允许工具的执行许可，以及仍有安全调查路径的失败，不得触发询问。
- 每次只问一个聚焦问题，可提供 2–4 个带说明的互斥选项；TUI 自动提供自由输入和 `Chat about this`。
- `ask_user` 不得索取 API key、token、密码、私钥或其他秘密；凭据应在对话外配置。
- 问题等待期间，方向键移动、Enter 选择；自由输入中的 Esc 返回选项，选项界面的 Esc 取消当前 turn。`Chat about this` 会让模型先澄清问题，不会伪造成用户答案。

受控编辑流程：

1. `propose_patch`、`propose_create_file` 或 `propose_delete_file` 生成带操作类型和 diff 的提案，不写文件。
2. `apply_edit` 只能引用内存中尚未过期的 `proposalId`。
3. `apply_edit` 默认直接执行；可在 `/permissions` 中将它收紧为 `ask`，此时 Harness 会暂停并向 TUI 发出审批请求。
4. `ask` 模式下用户按 `y` 批准或按 `n`/`Esc` 拒绝。
5. 执行前获取同目录排他锁并重新校验：替换和删除要求原文件 hash 未变，创建要求路径仍不存在。

目录创建流程：

1. `create_directories` 接收一组工作区相对目录，支持类似 `mkdir -p` 的递归创建。
2. 每次调用默认直接执行；权限收紧为 `ask` 时才在 TUI 中完整展示目标目录并请求批准。
3. 敏感目录、绝对路径、`..`、符号链接和工作区外路径仍会被拒绝。
4. 调用期间不要用外部程序替换目标目录；Node 路径接口无法提供操作系统 `openat` 级隔离。检测到并发变化时会失败并明确报告已保留的目录。

编辑限制：

- 只能创建、修改或删除当前工作区内的非敏感文本文件；创建文件时父目录必须已经存在。
- `oldText` 必须在文件中精确出现一次。
- 提案有效期为 15 分钟，并绑定读取时的文件哈希。
- 文件在提案后发生变化时，`apply_edit` 会拒绝陈旧提案。
- 删除先把目标原子移动到同目录隔离文件，再验证捕获内容；验证失败时无覆盖恢复，无法恢复时保留隔离副本而不丢弃数据。
- 排他锁协调多个 Logos Agent 写入；不遵守该锁的外部编辑器仍可能在最终复检与 rename 之间竞争，因此应用期间不要手工编辑目标文件。
- 当前进程不会热加载自身修改；应用成功后需要重启 Logos Agent。

固定任务执行边界：

- `run_task` 只接受 `logos_agent_test` 或 `logos_agent_typecheck`，不接受命令、参数、cwd 或环境变量。
- 每次运行默认直接执行；权限收紧为 `ask` 时才在 Harness 的 `beforeToolCall` 阶段暂停，由 TUI 展示固定命令并请求用户批准。
- 使用 `shell: false` 和绝对 Node 路径执行，最长 60 秒；Windows 通过带 `KILL_ON_JOB_CLOSE` 的 Job Object 约束并终止整个进程树。
- 子进程只继承运行所需的环境变量，不继承 Provider API key、token、密码或其他凭据。
- stdout 和 stderr 分别限制为 32 KiB，之后仍经过统一的终端字符清理和 `afterToolCall` 脱敏。

受控项目命令边界：

- `run_command` 只接受 `npm_install` 或 `npm_run`。它不接受 Bash/PowerShell 字符串、命令拼接、管道、重定向或可执行文件路径。
- `npm_install` 固定加入 `--no-audit --no-fund`，默认加入 `--ignore-scripts`；只有显式设置 `lifecycleScripts` 才会运行依赖生命周期脚本。
- `npm_run` 必须引用当前 `package.json` 中实际存在的脚本。权限收紧为 `ask` 时，审批卡会显示 npm 命令、工作目录、目标脚本以及 npm 会隐式执行的 `pre<script>`/`post<script>`、执行模式、时间上限和风险。
- 执行计划捕获 `package.json` hash，并在 spawn 前后复检；检测到脚本变化会立即拒绝或终止。cwd 必须是工作区内的现有非链接目录。
- 子进程使用 `shell: false`，不接收任意环境变量，也不继承 Provider API key、token 或密码。stdout/stderr 分别限制为 32 KiB，流式更新在进入 TUI 前完成控制字符清理、路径与凭据脱敏。
- `foreground` 模式等待命令退出，适合安装、构建和测试；`service` 模式观察启动输出后返回受管 `processId`，适合 `npm run dev`。
- `command_status` 可查看状态、检测到的 URL、耗时和有界输出；`stop_command` 默认直接终止整个进程树。最多同时运行 4 个服务，单个服务最长 30 分钟，Logos Agent 退出时统一回收。
- 这些约束控制“执行什么、从哪里执行、运行多久、暴露哪些信息”，不是操作系统文件或网络沙箱。执行的项目脚本仍可访问主机文件和网络；需要人工复核实际脚本和风险时，应在 `/permissions` 中把 `run_command` 收紧为 `ask`。
- 路径与 manifest 复检采用协作式工作区模型，不是原子的 OS handle 绑定；准备和进程启动期间不要由外部程序替换 cwd 或 `package.json`。恶意本地并发进程不在该工具的隔离能力内。

代码读取边界：

- 只接受工作区相对路径，拒绝绝对路径和 `..`。
- 不跟随目录树中的符号链接。
- 排除 `.git`、`.data`、`node_modules`、环境文件、私钥和常见凭据文件。
- 文件读取、目录深度、遍历目录数、遍历条目数、结果数量和搜索文件数都有固定上限。
- `grep` 使用有界正则表达式搜索，也可用 `literal=true` 查询精确文本；支持工作区相对路径、简单 glob、内容/文件/计数模式、上下文行和 offset 分页。为降低同步正则阻塞中断的风险，正则模式拒绝 lookaround、反向引用、量化分组和超过一个量词的表达式，并跳过超长单行。

## 安装

需要 Node.js 22.19.0+ 和 npm。在仓库根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps/logos-agent/install.ps1
```

安装脚本使用 `npm ci --ignore-scripts` 分别安装仓库依赖和 Logos Agent
独立依赖，然后通过 `npm link --ignore-scripts` 注册全局 `logos-agent`
命令。它不会自动安装以下可选依赖：

- Phoenix：需要 Python 3.11+，在 `apps/logos-agent` 中运行
  `npm run observability:install`。
- CodeGraph：使用工作区外的可信安装；默认发现
  `%LOCALAPPDATA%\codegraph\current`，自定义路径通过
  `LOGOS_AGENT_CODEGRAPH_PATH` 配置。

## 启动

在仓库根目录设置凭据后运行：

```powershell
$env:OPENAI_API_KEY="..."
npm run logos-agent
```

从其他已打开的项目目录启动时，可使用 `npm --prefix <pi 仓库路径> run logos-agent`；
Logos Agent 会把执行该命令前的项目目录作为工作区，而不是把 pi 仓库当作工作区。

Anthropic：

```powershell
$env:LOGOS_AGENT_PROVIDER="anthropic"
$env:LOGOS_AGENT_MODEL="claude-sonnet-4-6"
$env:ANTHROPIC_API_KEY="..."
npm run logos-agent
```

DeepSeek：

```powershell
$env:LOGOS_AGENT_PROVIDER="deepseek"
$env:LOGOS_AGENT_MODEL="deepseek-v4-pro"
$env:DEEPSEEK_API_KEY="..."
logos-agent
```

DeepSeek 使用内置的 OpenAI Chat Completions 兼容 Provider，固定端点为
`https://api.deepseek.com`。

可选环境变量：

- `LOGOS_AGENT_PROVIDER`: `openai`、`anthropic` 或 `deepseek`
- `LOGOS_AGENT_MODEL`: Provider 中存在的模型 ID
- `LOGOS_AGENT_WORKSPACE`: 显式覆盖 Agent 工作区
- 默认工作区是 npm 启动前的目录（`INIT_CWD`）；非 npm 启动时使用进程当前目录
- `LOGOS_AGENT_APP_VERSION`: 观测记录中的应用版本；默认 `0.1.0`
- `LOGOS_AGENT_RELEASE`: 用于缓存运营对比的发布标识；默认依次使用 commit、应用版本
- `LOGOS_AGENT_COMMIT`: 可选 Git commit 或构建标识
- `LOGOS_AGENT_FEATURES`: 逗号分隔的功能/feature flag 名称
- `web_search` 按 Tavily（设置 `TAVILY_API_KEY` 时）→ 免密搜狗 → Bing RSS 的顺序搜索；任一 Provider 失败或无结果会继续降级。正式调研建议配置 Tavily

TUI 命令：

- `/session`: 查看当前 JSONL Session
- `/workspace`（`/cwd`）: 查看当前实际工作区根目录
- `/sessions`（`/list`）: 打开可按首条学习目标、日期或 Session ID 搜索的恢复面板
- `/context`（`/ctx`）: 查看估算的 Context token 使用量
- `/cache`: 查看当前 Session 的累计与最近一次 prompt cache 命中率及 token 明细
- `/cache-report [release]`: 跨当前工作区 Session，按功能、模型、idle 区间、prompt/tool 结构和缓存保留策略聚合
- `/cache-compare <baseline> [current]`: 跨 Session 对比两个 release，并拆分流量结构与分段内部影响
- `/learn`（`/progress`）: 查看当前 turn 的 Observe / Propose / Apply / Verify 学习轨迹
- `/queue`: 查看 Agent 忙碌期间排队的后续指导
- `/queue remove <n>`: 删除一条排队指导
- `/queue edit <n>`: 把一条排队指导移回输入框修改
- `/queue clear`: 清空排队指导
- `/trace [on|off]`: 显示或隐藏成功的工具审计记录；阻止和失败记录始终显示
- `/permissions`（`/tools`）: 所有工具默认 `allow`；可按工具或 capability 收紧为 `ask`/`deny`，`ask` 才显示逐次审批卡
- `/compact`（`/zip`）: Context 达到 70% 后执行可中断压缩，并动态显示正在生成的摘要
- `/compact --force`: 在 Context 低于 70% 时显式执行压缩
- `/undo-compact`（`/unzip`）: 在产生新模型消息前恢复最近一次压缩前的 Session 分支
- `/new`: 创建一个新 Session
- `/exit`: 退出
- `Esc`: 中断正在执行的 turn
- `Ctrl+O`: 在折叠摘要和完整工具输出之间切换；新工具事件继承当前展开状态
- `Enter`: 提交当前目标；Agent 忙碌时改为排队后续指导
- `Shift+Enter` 或 `Ctrl+J`: 插入换行
- 输入 `/`: 搜索命令；输入 `@`: 补全注入工作区内的文件路径
- `↑`/`↓`: 在补全面板中移动，或由输入框在首尾位置浏览历史；多行输入中移动光标
- `Ctrl+C`（输入为空时）或 `Ctrl+D`: 安全退出并恢复终端
- Agent 提问时使用 `↑`/`↓` 选择，按 Enter 确认；可选择自由输入或 `Chat about this`，按 Esc 取消当前 turn
- 操作审批期间使用 `↑`/`↓`、`PgUp`/`PgDn`、`Home`/`End` 检查完整内容
- 操作审批期间按 `y`: 仅批准当前操作
- 操作审批期间按 `n` 或 `Esc`: 拒绝当前操作

TUI 使用 `● tool(args)` 与 `⎿ result` 事件块原位更新工具状态；多行结果默认折叠并提示
`ctrl+o to expand`。模型文本直接流式显示，不额外添加 `Agent` 标题。状态栏保留模型、
Session、token 与 Context 信息，并把 Logos Agent 的工作显示为
`reason → observe → propose → review → apply → verify`。活动区使用动画符号、阶段化动词、
实时耗时和 Logos Agent 提示展示当前事件，例如
`✢ Nebulizing… (thought for 1s)` 或 `✣ Inspecting evidence… (worked for 3s)`。
Agent 忙碌时提交的普通输入会进入
可检查的指导队列；未知 `/command` 不会发送给模型，而是保留在输入框并给出相近命令建议。

Context 压缩说明：

- `/compact` 是显式命令，不需要二次摘要审批。
- 摘要文本通过 Harness 的只读 `compaction_update` 事件流式展示，生成完成后自动写入 Session。
- `Esc` 会通过 `AbortSignal` 终止摘要生成；中断时不会写入 compaction entry。进入 `committing compaction…` 后提交已开始，应用会等待 Session 写入完成，不再取消。
- 原始消息仍保留在 Session 树中。`/undo-compact` 只允许恢复当前叶节点上的最近一次压缩，避免静默丢弃压缩后的新工作。
- Context 数字使用 `estimateContextTokens()`，以 `~` 标记为估算值；压缩后会忽略压缩前保留消息中的陈旧 Provider usage。

缓存运营观测：

- `cacheRead` 和 `cacheWrite` 来自 Provider usage，由 `pi-ai` adapter 统一归一化；命中率不是根据 prompt 内容推测。
- 每次 assistant 请求会追加一个 `cache_observation` 普通 custom entry，记录 release、commit、features、模型、该 adapter 是否提供缓存遥测、idle 时间、缓存保留策略、system prompt hash、tool definitions hash 和 token usage。
- idle 使用“上一请求完成到下一请求开始”的间隔；重启或切换 Session 时会从最近的持久化 observation 恢复。
- 观测只保存结构 hash，不保存 system prompt、工具定义或用户内容。
- 普通 custom entry 默认不会被 `buildContext()` 投影为模型消息，因此观测数据只供 TUI 和运营分析使用，不增加模型上下文 token。
- `/cache-compare` 使用 token 加权命中率，并把 release 变化拆成流量分段变化与相同分段内部变化；匿名 compaction/branch-summary usage 因缺少 provider/model 身份不纳入归因。

让 Agent 分析自己的示例：

```text
先使用 list_files 查看当前项目，再使用 grep 和 read_file
分析项目入口、核心模块和测试之间的关系。
```

受控修改示例：

```text
阅读当前工作区中的一个现有源码文件，
提出一个小型改进。使用 propose_patch 创建精确替换提案，然后立即调用 apply_edit 应用修改。
不要尝试修改当前工作区之外的文件。
```

安装并启动前端项目：

```text
读取 package.json。使用 run_command 执行 npm_install；安装成功后以 service 模式运行 dev 脚本。
从结果或 command_status 中报告检测到的本地 URL。验证结束后使用 stop_command 停止开发服务器。
```
