"""Run a dependency-free Harbor-style JBrancher bridge benchmark.

This intentionally exercises the Python integration that a real Harbor
``BaseAgent`` can use. It uses SWE-bench-derived task metadata and a
deterministic two-action environment so the benchmark can run in CI without
Docker, Harbor, or a frontier API key. It is a bridge benchmark, not an
official Terminal-Bench result.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any, Mapping

# Keep the benchmark runnable directly from any working directory, including
# when a package manager launches it from a temporary checkout.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from integrations.python import JBrancherHarborLoop, JBrancherProxy


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--instances", type=int)
    parser.add_argument("--repetitions", type=int, default=4)
    parser.add_argument("--actor-input-tokens", type=int, default=1800)
    parser.add_argument("--actor-output-tokens", type=int, default=140)
    parser.add_argument("--assert", dest="should_assert", action="store_true")
    return parser.parse_args()


def action_for(instance: Mapping[str, Any]) -> list[dict[str, Any]]:
    fail_to_pass = instance.get("fail_to_pass")
    if not isinstance(fail_to_pass, list) or not fail_to_pass or not all(
        isinstance(item, str) and item for item in fail_to_pass
    ):
        raise ValueError(f"fixture row {instance.get('instance_id')} has no FAIL_TO_PASS path")
    return [
        {"tool": "read", "args": {"path": fail_to_pass[0]}},
        {"tool": "read", "args": {"path": "README.md"}},
    ]


async def run(args: argparse.Namespace) -> dict[str, Any]:
    fixture = json.loads(Path(args.fixture).read_text(encoding="utf-8"))
    all_instances = fixture.get("instances")
    if not isinstance(all_instances, list) or not all_instances:
        raise ValueError("fixture must contain a non-empty instances array")
    if args.repetitions < 3:
        raise ValueError("--repetitions must be at least 3 so the benchmark has cold and warm runs")
    if args.actor_input_tokens < 0 or args.actor_output_tokens < 0:
        raise ValueError("synthetic token counts must be non-negative")

    count = len(all_instances) if args.instances is None else args.instances
    if count < 1:
        raise ValueError("--instances must be positive")
    instances = all_instances[: min(count, len(all_instances))]
    proxy = JBrancherProxy(args.base_url)
    health = proxy.health()
    if health.get("status") != "healthy" or not health.get("learningConfigured"):
        raise RuntimeError(f"JBrancher proxy is not ready for learning: {health}")
    loop = JBrancherHarborLoop(proxy, source="harbor-style-benchmark")
    rows: list[dict[str, Any]] = []

    for instance in instances:
        instance_id = instance["instance_id"]
        task = f"{instance_id}: {instance['problem_statement']}"
        actions = action_for(instance)
        attempts: list[dict[str, Any]] = []

        for repetition in range(1, args.repetitions + 1):
            state = {
                "repository": instance["repo"],
                "instanceId": instance_id,
                "phase": 0,
            }
            frontier_queue = list(actions)
            frontier_calls = 0

            async def frontier(_decision: Mapping[str, Any]) -> dict[str, Any]:
                nonlocal frontier_calls
                if not frontier_queue:
                    raise RuntimeError(f"frontier was asked for an unexpected action on {instance_id}")
                frontier_calls += 1
                return frontier_queue.pop(0)

            async def execute(action: Mapping[str, Any]) -> dict[str, Any]:
                return {
                    "ok": True,
                    "output": f"fixture output for {action['args']['path']}",
                }

            async def observe(
                current_state: Mapping[str, Any],
                _event: Mapping[str, Any],
                _history: list[Any],
            ) -> dict[str, Any]:
                return {**current_state, "phase": int(current_state.get("phase", 0)) + 1}

            async def verify(_action: Mapping[str, Any], result: Mapping[str, Any]) -> bool:
                return result.get("ok") is True

            if repetition <= 2:
                result = await loop.run(
                    task,
                    state,
                    candidates=[],
                    frontier=frontier,
                    execute=execute,
                    observe=observe,
                    verify=verify,
                    max_steps=2,
                    metadata={"instanceId": instance_id, "repetition": repetition},
                )
            else:
                result = await loop.run(
                    task,
                    state,
                    candidates=actions,
                    candidate_steps=[[actions[0]], [actions[1]]],
                    frontier=frontier,
                    execute=execute,
                    observe=observe,
                    verify=verify,
                    max_steps=2,
                    metadata={"instanceId": instance_id, "repetition": repetition},
                )

            attempts.append(
                {
                    "repetition": repetition,
                    "source": result.source,
                    "outcome": result.outcome,
                    "frontierSteps": frontier_calls,
                    "steps": len(result.events),
                    "recovered": result.recovered,
                }
            )

        rows.append(
            {
                "instanceId": instance_id,
                "baselineFrontierSteps": args.repetitions * 2,
                "actualFrontierSteps": sum(item["frontierSteps"] for item in attempts),
                "learnedReplays": sum(item["source"] == "learned" for item in attempts),
                "routeCoverage": all(
                    item["source"] == "learned" and item["outcome"] == "success"
                    for item in attempts[2:]
                ),
                "attempts": attempts,
            }
        )

    snapshot = proxy.learning()
    stats = proxy.stats()
    baseline_frontier_steps = len(instances) * args.repetitions * 2
    actual_frontier_steps = sum(row["actualFrontierSteps"] for row in rows)
    frontier_steps_avoided = baseline_frontier_steps - actual_frontier_steps
    tokens_per_step = args.actor_input_tokens + args.actor_output_tokens
    baseline_tokens = baseline_frontier_steps * tokens_per_step
    actual_tokens = actual_frontier_steps * tokens_per_step
    learned_replays = sum(row["learnedReplays"] for row in rows)
    report = {
        "benchmark": "JBrancher Python Harbor-style open-world learning bridge",
        "source": {
            "url": fixture.get("sourceUrl"),
            "instances": len(instances),
            "repetitions": args.repetitions,
        },
        "caveat": (
            "SWE-bench-derived prompts and deterministic read workflows; this exercises "
            "JBrancherHarborLoop but is not an official Harbor or Terminal-Bench result."
        ),
        "baselineFrontierSteps": baseline_frontier_steps,
        "actualFrontierSteps": actual_frontier_steps,
        "frontierStepsAvoided": frontier_steps_avoided,
        "frontierStepReduction": round(frontier_steps_avoided / baseline_frontier_steps, 3),
        "syntheticProviderTokens": {
            "baseline": baseline_tokens,
            "actual": actual_tokens,
            "saved": baseline_tokens - actual_tokens,
        },
        "learnedReplays": learned_replays,
        "routeCoverage": all(row["routeCoverage"] for row in rows),
        "successRate": round(
            sum(
                attempt["outcome"] == "success"
                for row in rows
                for attempt in row["attempts"]
            )
            / (len(instances) * args.repetitions),
            3,
        ),
        "recordedEpisodes": stats["episodesRecorded"],
        "workflowRequests": stats["workflowRequests"],
        "datasetExamples": snapshot["traces"],
        "activeRoutes": snapshot["activeRoutes"],
        "successfulReplays": snapshot.get("successfulReplays", 0),
        "replay": snapshot["replay"],
        "rows": rows,
    }

    if args.should_assert:
        expected_episodes = len(instances) * args.repetitions
        expected_workflows = len(instances) * (args.repetitions - 2)
        assert report["activeRoutes"] == len(instances)
        assert report["recordedEpisodes"] == expected_episodes
        assert report["datasetExamples"] == expected_episodes
        assert report["workflowRequests"] == expected_workflows
        assert report["routeCoverage"] is True
        assert report["successRate"] == 1
        assert report["learnedReplays"] == expected_workflows
        assert report["successfulReplays"] == expected_workflows
        assert report["replay"]["successRate"] == 1
        assert report["replay"]["estimatedFrontierStepsAvoided"] == report["frontierStepsAvoided"]
        assert report["frontierStepReduction"] >= 0.5

    return report


def main() -> None:
    print(json.dumps(asyncio.run(run(parse_args())), indent=2))


if __name__ == "__main__":
    main()
