"""EvalScope External Agent Bridge runner for Logos Agent."""

import os
from typing import Any, Dict, List, Optional

from evalscope.agent.external import (
    AgentRunner,
    AgentRunResult,
    BridgeEndpoint,
    ExternalAgentTask,
)
from evalscope.agent.external.runners.base import RunnerTimeoutError
from evalscope.api.agent import AgentEnvironment
from evalscope.api.registry import register_runner


@register_runner("logos-agent")
class LogosAgentRunner(AgentRunner):
    """Run one isolated Logos Agent prompt through the EvalScope bridge."""

    framework = "logos-agent"

    def __init__(
        self,
        *,
        model_name: str = "",
        command: Optional[List[str]] = None,
        extra_args: Optional[List[str]] = None,
        context_window: int = 131_072,
        max_tokens: int = 8_192,
        reasoning: bool = False,
        auto_approve: bool = True,
        **_: Any,
    ) -> None:
        if context_window <= 0 or max_tokens <= 0:
            raise ValueError("context_window and max_tokens must be positive")
        if max_tokens > context_window:
            raise ValueError("max_tokens cannot exceed context_window")
        self._model_name = model_name or "default"
        default_command = "logos-agent.cmd" if os.name == "nt" else "logos-agent"
        self._command = list(command or [default_command])
        self._extra_args = list(extra_args or [])
        self._context_window = context_window
        self._max_tokens = max_tokens
        self._reasoning = reasoning
        self._auto_approve = auto_approve

    async def setup(self, env: AgentEnvironment) -> None:
        probe = await env.exec([*self._command, "--version"], timeout=30)
        if probe.returncode != 0:
            raise RuntimeError(
                "logos-agent is unavailable in the evaluation environment: "
                f"{(probe.stderr or probe.stdout).strip()[-2000:]}"
            )

    async def run(
        self,
        task: ExternalAgentTask,
        env: AgentEnvironment,
        bridge: BridgeEndpoint,
    ) -> AgentRunResult:
        env_vars: Dict[str, str] = {
            "CI": "1",
            "NO_COLOR": "1",
            "LOGOS_AGENT_PROVIDER": "openai-compatible",
            "LOGOS_AGENT_BASE_URL": f"{bridge.base_url}/openai/v1",
            "LOGOS_AGENT_API_KEY": bridge.trial_token,
            "LOGOS_AGENT_MODEL": self._model_name,
            "LOGOS_AGENT_CONTEXT_WINDOW": str(self._context_window),
            "LOGOS_AGENT_MAX_TOKENS": str(self._max_tokens),
            "LOGOS_AGENT_REASONING": "true" if self._reasoning else "false",
            "LOGOS_AGENT_THINKING": "high" if self._reasoning else "off",
            "LOGOS_AGENT_LOAD_PERSISTENT_ENV": "false",
            "LOGOS_AGENT_WORKSPACE": ".",
        }
        command = [*self._command, *self._extra_args]
        if self._auto_approve:
            command.append("--yes")
        command.extend(["--print", task.instruction])
        result = await env.exec(command, timeout=task.timeout, env=env_vars)
        if result.timed_out:
            raise RunnerTimeoutError(
                f"logos-agent timed out after {task.timeout}s "
                f"(returncode={result.returncode})"
            )
        if result.returncode != 0:
            raise RuntimeError(
                f"logos-agent exited with code {result.returncode}:\n"
                f"stderr: {(result.stderr or '').strip()[-2000:]}\n"
                f"stdout: {(result.stdout or '').strip()[-2000:]}"
            )
        return AgentRunResult(
            output=(result.stdout or "").strip(),
            metrics={
                "wall_time": result.duration,
                "returncode": result.returncode,
            },
        )
