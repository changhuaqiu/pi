# Logos Agent 接入 Buzz 的 ACP Adapter

> 状态：首版已实现，目标客户端为本地 Buzz `buzz-acp`。

## 架构

```text
Buzz Relay -> buzz-acp -> ACP/stdio -> LogosAcpServer -> LogosAgent
                                                     |-> AgentHarness / Provider
                                                     |-> ToolSystem
                                                     +-> buzz_cli -> Buzz Relay
```

ACP 是 `LogosAgent` interface 上与 TUI 同级的输入输出 Adapter。它不绕过
`AgentHarness`、ToolSystem、Session、审批或审计，也不直接调用 Provider。

## 启动

```powershell
$env:BUZZ_ACP_AGENT_COMMAND="logos-agent"
$env:BUZZ_ACP_AGENT_ARGS="acp"
buzz-acp
```

`logos-agent acp` 使用 stdin/stdout 上的逐行 JSON-RPC 2.0。stdout 只承载协议消息，
日志写入 stderr。Buzz 当前以 `protocolVersion: 2` 发起初始化，但兼容 Agent 返回版本 1；
Logos 返回版本 1，使 Buzz 将 standing context 放入首次用户 Prompt，而不是使用 Buzz 的
扩展 v2 `session/new.systemPrompt` 路径。

## 协议范围

| Buzz 调用 | Logos 行为 |
|---|---|
| `initialize` | 返回 ACP v1、Agent 信息和文本 Prompt 能力 |
| `session/new` | 校验绝对 `cwd`，创建独立 Logos 运行时和新 JSONL Session |
| `session/prompt` | 合并文本块并调用 `LogosAgent.prompt()` |
| `session/cancel` | 中止该 Session 的活动 Turn；空闲时幂等 |
| `session/close` | 拒绝遗留审批、中止活动 Turn、释放运行时 |
| `session/request_permission` | 将 Logos `approval_request` 转成 allow-once/reject-once |
| `session/update` | 流式发送文本、思考和工具生命周期 |

暂不支持 `session/load`、图片/音频 Prompt、ACP MCP server 注入、模型切换和结构化用户
询问。Logos 的 `ask_user` 在 ACP 模式会被取消；需要用户回答的问题应通过 `buzz_cli`
发布到来源频道，并结束当前 Turn 等待后续 Buzz 消息。

## 事件映射

| Logos 事件 | ACP update |
|---|---|
| `message_update.text_delta` | `agent_message_chunk` |
| `message_update.thinking_delta` | `agent_thought_chunk` |
| `tool_execution_start` | `tool_call` / `in_progress` |
| `tool_execution_update` | `tool_call_update` / `in_progress` |
| `tool_execution_end` | `tool_call_update` / `completed` 或 `failed` |

工具的原始输入、输出和 Provider Context 不通过 ACP 事件外泄。只有工具名、调用 ID、
类别和状态进入 Buzz 的活动流。

## Session 与并发

- 一个 ACP Session 对应一个 `LogosAgent` 实例，不共享消息、审批、工具状态或中止信号。
- 同一 Session 同时只允许一个活动 Prompt；不同 Session 可并发运行。
- `session/cancel` 仅作用于目标 Session。
- stdin EOF、SIGINT 或 SIGTERM 会关闭所有 Session；即使 abort 失败也继续执行 shutdown。
- 每条输入限制为 1 MiB，Prompt 目前只接受非空文本块。

## `buzz_cli` 安全边界

ACP 模式为 Logos 注册独立的 `buzz_cli`，因为已有 `run_command` 只允许 npm 操作：

- 可执行文件固定为 `buzz`，参数直接传给 `spawn`，不经过 shell；
- 不接受 cwd、环境变量或可执行文件覆盖；cwd 固定为 ACP Session 工作区；
- 只继承 Buzz 连接/身份变量以及启动进程所需的最小系统环境；
- 参数总量、stdin、stdout/stderr、执行时间均有硬上限；
- stdout/stderr 清理终端控制字符，再进入 ToolSystem 的统一结果治理；
- 审计只记录参数和 stdin 的字节数与 hash，不记录正文；
- 工具进度只显示首个命令组，例如 `buzz messages`，不回显正文或身份参数；
- 具备 Buzz 读、写和网络 capability，默认权限为 `ask`。Buzz 会通过 ACP 权限请求作出
  allow-once/reject-once 决策。

ACP 模型输出不会自动成为 Buzz 消息。任何答案、结果、阻塞或必须由用户回答的问题，
都必须调用类似下面的工具参数来发布：

```json
{
  "args": ["messages", "send", "--channel", "<uuid>", "--reply-to", "<event-id>", "--content", "-"],
  "stdin": "要发布的多行内容"
}
```

频道、reply-to 和 mention 信息来自 Buzz 注入的 standing context，不应由 Agent 猜测。

## 验证

回归测试覆盖：

- Buzz 使用的 initialize/session/new/session/prompt/session/cancel 消息序列；
- 文本和工具事件映射；
- ACP 权限 allow-once 回传；
- Session 关闭与取消；
- `buzz_cli` argv/stdin 透传、无 shell 执行和输入上限；
- CLI `acp` 模式解析。

本地端到端验收还需要有效 Provider key、已注册的 Buzz agent 私钥、可访问 Relay，以及
`logos-agent`、`buzz-acp`、`buzz` 三个命令在 `PATH`。在频道 @mention Agent 后，应看到
流式活动，最终收到由 `buzz messages send` 发布且带正确 reply-to 的频道消息。
