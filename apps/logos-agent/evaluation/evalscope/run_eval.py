"""Run an EvalScope dataset through the Logos Agent external runner."""

import argparse
import os

from evalscope import TaskConfig, run_task
from evalscope.agent.external import ExternalAgentConfig

import logos_agent_runner  # noqa: F401  Registers the custom runner.


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--limit", type=int, default=3)
    parser.add_argument("--timeout", type=float, default=1800.0)
    parser.add_argument("--context-window", type=int, default=131_072)
    parser.add_argument("--max-tokens", type=int, default=8_192)
    parser.add_argument("--reasoning", action="store_true")
    parser.add_argument("--environment", choices=["local", "docker"], default="local")
    parser.add_argument("--docker-image")
    parser.add_argument("--allow-local-write", action="store_true")
    parser.add_argument("--command")
    args = parser.parse_args()

    api_key = os.environ.get("EVALSCOPE_API_KEY")
    if not api_key:
        raise RuntimeError("EVALSCOPE_API_KEY is required")
    if args.environment == "local" and not args.allow_local_write:
        raise RuntimeError(
            "Local evaluation can modify the current workspace; "
            "use a disposable checkout and pass --allow-local-write"
        )
    if args.environment == "docker" and not args.docker_image:
        raise RuntimeError("--docker-image is required for Docker evaluation")
    command = args.command or (
        "logos-agent"
        if args.environment == "docker" or os.name != "nt"
        else "logos-agent.cmd"
    )
    environment_extra = (
        {
            "sandbox_config": {
                "image": args.docker_image,
                "network_enabled": True,
            }
        }
        if args.environment == "docker"
        else {}
    )

    run_task(
        TaskConfig(
            model=args.model,
            api_url=args.api_url,
            api_key=api_key,
            eval_type="openai_api",
            datasets=[args.dataset],
            limit=args.limit,
            agent_config=ExternalAgentConfig(
                framework="logos-agent",
                environment=args.environment,
                environment_extra=environment_extra,
                timeout=args.timeout,
                kwargs={
                    "command": [command],
                    "context_window": args.context_window,
                    "max_tokens": args.max_tokens,
                    "reasoning": args.reasoning,
                    "auto_approve": True,
                },
            ),
        )
    )


if __name__ == "__main__":
    main()
