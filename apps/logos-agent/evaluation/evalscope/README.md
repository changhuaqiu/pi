# EvalScope Bridge 使用说明

该适配让 EvalScope 把数据集中的任务逐条交给 Logos Agent。EvalScope Bridge 转发并记录模型请求；Logos Agent 仍通过原有 Harness、Agent Loop 和 ToolSystem 使用工具。

## 1. 安装并检查

```powershell
py -m pip install evalscope
evalscope --version
logos-agent --version
```

`logos-agent --version` 当前应输出 `0.1.0`。如果命令不可用，先在 `apps/logos-agent` 目录执行 `npm link --ignore-scripts`。

## 2. 先跑一个样本

在一次性 checkout 的根目录执行：

```powershell
$env:EVALSCOPE_API_KEY = '<backend-api-key>'
py apps/logos-agent/evaluation/evalscope/run_eval.py `
  --model '<model-id>' `
  --api-url '<openai-compatible-api-url>' `
  --dataset '<evalscope-dataset>' `
  --limit 1 `
  --allow-local-write
```

参数含义：

- `--model`：被评测的后端模型 ID。
- `--api-url`：后端模型的 OpenAI Chat Completions 兼容地址，不要填 Logos Agent 地址。
- `--dataset`：EvalScope 数据集名称，例如 `gsm8k`。
- `--limit`：本次抽取的样本数，首次运行建议设为 `1`。
- `--reasoning`：后端模型支持推理时再添加。
- `--context-window`、`--max-tokens`：应与真实模型限制一致。

本地模式直接使用当前目录。`--allow-local-write` 是必须的显式确认；Runner 会传入 `--yes`，写入和命令工具会自动批准，但仍执行 ToolSystem 原有的权限、路径校验、审计和结果脱敏。多个可写样本共享当前目录，因此只能在一次性 checkout 中运行。

## 3. 查看结果

评测报告和 Agent Trace 位于当前目录的 `outputs/`。如需 Web 回放：

```powershell
py -m pip install 'evalscope[service]'
evalscope service --outputs ./outputs
```

浏览器打开命令输出的 Dashboard 地址，默认是 `http://127.0.0.1:9000`。

## 4. 多样本写入评测

多样本写入应使用 Docker，避免前一个样本修改工作区后影响后续样本。Docker 镜像中需要已经全局安装 `logos-agent`：

Docker 模式需要一个已经全局安装 `logos-agent` 的镜像：

```powershell
py apps/logos-agent/evaluation/evalscope/run_eval.py `
  --model '<model-id>' `
  --api-url '<openai-compatible-api-url>' `
  --dataset '<evalscope-dataset>' `
  --environment docker `
  --docker-image '<logos-agent-image>'
```

推理模型增加 `--reasoning`。模型上下文与输出上限可用 `--context-window` 和 `--max-tokens` 设置，评测时应与真实模型一致。

无界面模式为每个进程创建临时 Session，因此不同样本不会继承 Logos Agent 的历史对话。Agent 超时、报错或未正常结束时，Runner 会让该样本失败，不会把截断内容当成成功结果。
