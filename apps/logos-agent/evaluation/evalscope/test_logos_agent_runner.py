"""Regression tests for the Logos Agent EvalScope runner."""

import asyncio
import unittest
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

from evalscope.agent.external import BridgeEndpoint, ExternalAgentTask

from logos_agent_runner import LogosAgentRunner


class RecordingEnvironment:
    def __init__(self, name: str) -> None:
        self.name = name
        self.calls: List[Dict[str, Any]] = []

    async def exec(
        self,
        cmd: List[str],
        *,
        cwd: Optional[str] = None,
        input: Optional[str] = None,
        timeout: Optional[float] = None,
        env: Optional[Dict[str, str]] = None,
    ) -> Any:
        self.calls.append(
            {
                "cmd": cmd,
                "cwd": cwd,
                "input": input,
                "timeout": timeout,
                "env": env,
            }
        )
        return SimpleNamespace(
            returncode=0,
            stdout="complete",
            stderr="",
            timed_out=False,
            duration=0.25,
        )


class LogosAgentRunnerTest(unittest.TestCase):
    def test_multiline_instruction_uses_stdin(self) -> None:
        async def scenario() -> None:
            instruction = "first line\n\nsecond line with a question?"
            environment = RecordingEnvironment("local")
            runner = LogosAgentRunner(command=["logos-agent.cmd"])

            result = await runner.run(
                ExternalAgentTask(instruction=instruction, timeout=30),
                environment,
                BridgeEndpoint(base_url="http://127.0.0.1:9000", trial_token="trial-test"),
            )

            self.assertEqual(result.output, "complete")
            self.assertEqual(len(environment.calls), 1)
            call = environment.calls[0]
            self.assertEqual(call["cmd"][-2:], ["--print", "-"])
            self.assertEqual(call["input"], instruction)
            self.assertNotIn(instruction, call["cmd"])

        asyncio.run(scenario())

    def test_multiline_instruction_uses_argument_without_stdin_support(self) -> None:
        async def scenario() -> None:
            instruction = "first line\n\nsecond line with a question?"
            environment = RecordingEnvironment("enclave")
            runner = LogosAgentRunner(command=["logos-agent"])

            result = await runner.run(
                ExternalAgentTask(instruction=instruction, timeout=30),
                environment,
                BridgeEndpoint(
                    base_url="http://127.0.0.1:9000",
                    trial_token="trial-test",
                ),
            )

            self.assertEqual(result.output, "complete")
            self.assertEqual(len(environment.calls), 1)
            call = environment.calls[0]
            self.assertEqual(call["cmd"][-2:], ["--print", instruction])
            self.assertIsNone(call["input"])

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
