# Learning Agent

一个真实 Provider 驱动的最小 TUI Agent，支持 OpenAI、Anthropic 和 DeepSeek。运行时链路是：

```text
TUI -> LearningAgent -> AgentHarness -> Agent loop -> Provider
                       |             |
                       |             +-> workspace_info
                       +-> JSONL Session
```

当前边界：

- 连接 OpenAI 或 Anthropic 的真实模型，不在运行时使用 Faux Provider。
- 提供 `workspace_info`、`list_files`、`read_file`、`search_text` 四个工作区只读工具。
- 提供 `git_status`、`git_diff`、`git_log`、`git_show`、`git_blame` 五个 Git 只读工具。
- 提供 `propose_patch` 和 `apply_edit` 两个受控编辑工具。
- 只能读取注入工作区内的有界元数据、目录结构和文本源码。
- 工具执行支持 `AbortSignal` 和 `onUpdate`。
- `beforeToolCall` 产生审计事件，`afterToolCall` 对结果脱敏。
- 不提供 shell 或任意路径读写能力。

Git 读取边界：

- Git 命令通过注入的 operations 适配器执行，不读取全局 CWD，也不使用 shell。
- 注入路径必须是包含本地 `.git` 目录的仓库根目录；为避免元数据逃逸，暂不支持 `.git` 文件形式的 linked worktree。
- Git 目录内的链接和外部 object alternates 会被拒绝，命令行固定仓库目录与 worktree。
- 路径必须是工作区相对路径；revision 拒绝选项注入和控制字符。
- 每个工具调用的完整执行过程最长 15 秒；脱敏后最终返回给模型的文本不超过 64 KiB。
- `git_diff`、`git_show` 的大 patch 会截断并明确标记；工具不会执行 checkout、add、commit、reset 或 push。
- 所有 Git 工具同样经过 `beforeToolCall` 审计和 `afterToolCall` 脱敏。

受控编辑流程：

1. `propose_patch` 接收目标路径、唯一匹配的 `oldText` 和 `newText`，读取当前文件并生成带 SHA-256 的提案，不写文件。
2. `apply_edit` 只能引用内存中尚未过期的 `proposalId`。
3. Harness 在 `beforeToolCall` 阶段暂停并向 TUI 发出审批请求。
4. 用户按 `y` 批准或按 `n`/`Esc` 拒绝。
5. 批准后获取同目录排他锁、重新校验文件哈希，再使用同目录临时文件原子替换。

编辑限制：

- 只能修改已经存在的 `apps/learning-agent/**` 文本文件。
- `oldText` 必须在文件中精确出现一次。
- 提案有效期为 15 分钟，并绑定读取时的文件哈希。
- 文件在提案后发生变化时，`apply_edit` 会拒绝陈旧提案。
- 排他锁协调多个 Learning Agent 写入；不遵守该锁的外部编辑器仍可能在最终复检与 rename 之间竞争，因此审批期间不要手工编辑目标文件。
- 当前进程不会热加载自身修改；应用成功后需要重启 Learning Agent。

代码读取边界：

- 只接受工作区相对路径，拒绝绝对路径和 `..`。
- 不跟随目录树中的符号链接。
- 排除 `.git`、`.data`、`node_modules`、环境文件、私钥和常见凭据文件。
- 文件读取、目录深度、遍历目录数、遍历条目数、结果数量和搜索文件数都有固定上限。
- `search_text` 是字面量搜索，不执行用户提供的正则表达式。

## 启动

在仓库根目录设置凭据后运行：

```powershell
$env:OPENAI_API_KEY="..."
npm run learning-agent
```

Anthropic：

```powershell
$env:LEARNING_AGENT_PROVIDER="anthropic"
$env:LEARNING_AGENT_MODEL="claude-sonnet-4-6"
$env:ANTHROPIC_API_KEY="..."
npm run learning-agent
```

DeepSeek：

```powershell
$env:LEARNING_AGENT_PROVIDER="deepseek"
$env:LEARNING_AGENT_MODEL="deepseek-v4-pro"
$env:DEEPSEEK_API_KEY="..."
learning-agent
```

DeepSeek 使用内置的 OpenAI Chat Completions 兼容 Provider，固定端点为
`https://api.deepseek.com`。

可选环境变量：

- `LEARNING_AGENT_PROVIDER`: `openai`、`anthropic` 或 `deepseek`
- `LEARNING_AGENT_MODEL`: Provider 中存在的模型 ID
- `LEARNING_AGENT_WORKSPACE`: 注入给 Agent 的工作区；默认是启动命令的当前目录

TUI 命令：

- `/session`: 查看当前 JSONL Session
- `/context`（`/ctx`）: 查看估算的 Context token 使用量
- `/compact`（`/zip`）: Context 达到 70% 后执行可中断压缩，并动态显示正在生成的摘要
- `/compact --force`: 在 Context 低于 70% 时显式执行压缩
- `/undo-compact`（`/unzip`）: 在产生新模型消息前恢复最近一次压缩前的 Session 分支
- `/new`: 创建一个新 Session
- `/exit`: 退出
- `Esc`: 中断正在执行的 turn
- `Ctrl+C`（输入为空时）或 `Ctrl+D`: 安全退出并恢复终端
- 编辑审批期间按 `y`: 批准当前提案
- 编辑审批期间按 `n` 或 `Esc`: 拒绝当前提案

TUI 会在同一行更新工具的 `validating`、`running` 和完成状态，保留模型、Session、
token 与 Context 状态栏信息；输入框支持 `↑`/`↓` 浏览历史并返回未提交草稿。

Context 压缩说明：

- `/compact` 是显式命令，不需要二次摘要审批。
- 摘要文本通过 Harness 的只读 `compaction_update` 事件流式展示，生成完成后自动写入 Session。
- `Esc` 会通过 `AbortSignal` 终止摘要生成；中断时不会写入 compaction entry。进入 `committing compaction…` 后提交已开始，应用会等待 Session 写入完成，不再取消。
- 原始消息仍保留在 Session 树中。`/undo-compact` 只允许恢复当前叶节点上的最近一次压缩，避免静默丢弃压缩后的新工作。
- Context 数字使用 `estimateContextTokens()`，以 `~` 标记为估算值；压缩后会忽略压缩前保留消息中的陈旧 Provider usage。

让 Agent 分析自己的示例：

```text
先使用 list_files 查看 apps/learning-agent，再使用 search_text 和 read_file
分析 LearningAgent、AgentHarness、工具审计和脱敏之间的关系。
```

受控修改示例：

```text
阅读 apps/learning-agent/src/system-prompt.ts（如果不存在则选择一个现有源码文件），
提出一个小型改进。使用 propose_patch 创建精确替换提案，然后调用 apply_edit 请求我审批。
不要尝试修改 apps/learning-agent 之外的文件。
```
