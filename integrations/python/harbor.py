"""Async harness loop for Harbor-style external agents.

This module deliberately does not import Harbor. A Harbor ``BaseAgent`` (or
any other harness) can provide its frontier chooser, executor, and verifier to
this small loop. JBrancher remains advisory: the host owns authorization,
execution, sandboxing, and task completion.
"""

from __future__ import annotations

import asyncio
import inspect
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence

from .jbrancher_proxy import JBrancherProxy


Action = Mapping[str, Any]
Callback = Callable[..., Any]


async def _invoke(callback: Callback, *args: Any) -> Any:
    value = callback(*args)
    if inspect.isawaitable(value):
        return await value
    return value


def _normalize_action(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ValueError("frontier must return an action mapping or None")
    nested = value.get("action")
    if isinstance(nested, Mapping):
        value = nested
    action = dict(value)
    if not isinstance(action.get("tool"), str) or not action["tool"]:
        raise ValueError("actions need a non-empty tool")
    if "args" not in action:
        raise ValueError("actions need args")
    return action


def _result_ok(result: Any, verified: bool | None) -> bool:
    if verified is not None:
        return verified
    if isinstance(result, Mapping) and "ok" in result:
        return bool(result["ok"])
    return True


def _tool_call(
    action: dict[str, Any],
    result: Any,
    ok: bool,
    context: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    call: dict[str, Any] = {
        "tool_name": action["tool"],
        "input": action["args"],
        "ok": ok,
    }
    if isinstance(result, Mapping):
        if "output" in result:
            call["output"] = result["output"]
        elif "content" in result:
            call["content"] = result["content"]
    elif result is not None:
        call["output"] = result
    if context is not None:
        call["context"] = dict(context)
    return call


def _episode_metadata(
    metadata: Mapping[str, Any] | None,
    state: Any,
    decision: Mapping[str, Any],
    *,
    recovery: bool = False,
) -> dict[str, Any]:
    routing = {
        "source": decision.get("source"),
        "routeResolution": decision.get("routeResolution"),
        "candidateCount": len(decision.get("candidates", []))
        if isinstance(decision.get("candidates"), list)
        else 0,
    }
    if isinstance(decision.get("routeId"), str):
        routing["routeId"] = decision["routeId"]
    if recovery:
        routing["recovery"] = True
    return {**(metadata or {}), "state": state, "routing": routing}


@dataclass(frozen=True)
class JBrancherStepResult:
    """One completed harness decision and its local learning feedback."""

    decision: dict[str, Any]
    action: dict[str, Any] | None
    source: str
    result: Any
    verified: bool | None
    episode: dict[str, Any] | None
    recovered: bool = False


class JBrancherHarborLoop:
    """Run one safe JBrancher step inside a Harbor-style agent.

    ``frontier`` chooses an action when JBrancher abstains or when a learned
    action fails. ``execute`` runs the action in the host environment.
    ``verify`` is optional but recommended for writes and other side effects;
    it receives ``(action, result)`` and may be synchronous or asynchronous.
    """

    def __init__(
        self,
        proxy: JBrancherProxy,
        *,
        source: str = "harbor",
        cwd: str | None = None,
    ) -> None:
        if not isinstance(proxy, JBrancherProxy):
            raise TypeError("proxy must be a JBrancherProxy")
        if not isinstance(source, str) or not source.strip():
            raise ValueError("source must be a non-empty string")
        self.proxy = proxy
        self.source = source
        self.cwd = cwd

    async def _record(
        self,
        *,
        task: str,
        action: dict[str, Any] | None,
        result: Any,
        outcome: str,
        route_resolution: str,
        route_id: str | None = None,
        metadata: Mapping[str, Any] | None = None,
        finish_metadata: Mapping[str, Any] | None = None,
        failure_reason: str | None = None,
        context: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        calls = [] if action is None else [_tool_call(action, result, outcome == "success", context)]
        return await asyncio.to_thread(
            self.proxy.record_episode,
            task,
            calls,
            outcome,
            cwd=self.cwd,
            source=self.source,
            route_resolution=route_resolution,
            route_id=route_id,
            metadata=metadata,
            finish_metadata=finish_metadata,
            failure_reason=failure_reason,
        )

    async def step(
        self,
        task: str,
        state: Any,
        *,
        frontier: Callback,
        execute: Callback,
        candidates: Sequence[Any] | None = None,
        history: Sequence[Any] | None = None,
        verify: Callback | None = None,
        metadata: Mapping[str, Any] | None = None,
        finish_metadata: Mapping[str, Any] | None = None,
    ) -> JBrancherStepResult:
        """Choose, execute, verify, and record one action.

        The first unmatched call can omit ``candidates``. The frontier callback
        then supplies the action, and the completed episode becomes local
        training evidence. A failed learned route is reported as ``failed``
        and is immediately followed by one frontier recovery attempt.
        """

        if not callable(frontier) or not callable(execute):
            raise TypeError("frontier and execute callbacks are required")
        if verify is not None and not callable(verify):
            raise TypeError("verify must be callable when provided")

        decision = await asyncio.to_thread(
            self.proxy.decide,
            task,
            state,
            candidates,
            history,
        )
        learned = decision.get("source") == "learned"
        action = _normalize_action(decision.get("action") if learned else await _invoke(frontier, decision))
        if action is None:
            episode = await self._record(
                task=task,
                action=None,
                result=None,
                outcome="unknown",
                route_resolution=decision.get("routeResolution", "unmatched"),
                metadata=_episode_metadata(metadata, state, decision),
                finish_metadata=finish_metadata,
                context={"state": state, "routing": _episode_metadata({}, state, decision)["routing"]},
            )
            return JBrancherStepResult(decision, None, "abstain", None, None, episode)

        result = await _invoke(execute, action)
        verified = None if verify is None else bool(await _invoke(verify, action, result))
        ok = _result_ok(result, verified)
        episode = await self._record(
            task=task,
            action=action,
            result=result,
            outcome="success" if ok else "failure",
            route_resolution="learned" if learned and ok else "failed" if learned else decision.get("routeResolution", "unmatched"),
            route_id=decision.get("routeId") if learned else None,
            metadata=_episode_metadata(metadata, state, decision),
            finish_metadata=finish_metadata,
            failure_reason=None if ok else "Harness execution or postcondition failed",
            context={"state": state, "routing": _episode_metadata({}, state, decision)["routing"]},
        )
        if not learned or ok:
            return JBrancherStepResult(decision, action, "learned" if learned else "frontier", result, verified, episode)

        recovery_decision = {
            **decision,
            "source": "recovery",
            "routeResolution": "failed",
            "failedRouteId": decision.get("routeId"),
        }
        recovery_action = _normalize_action(await _invoke(frontier, recovery_decision))
        if recovery_action is None:
            return JBrancherStepResult(decision, action, "learned", result, verified, episode, recovered=False)
        recovery_result = await _invoke(execute, recovery_action)
        recovery_verified = None if verify is None else bool(await _invoke(verify, recovery_action, recovery_result))
        recovery_ok = _result_ok(recovery_result, recovery_verified)
        recovery_episode = await self._record(
            task=task,
            action=recovery_action,
            result=recovery_result,
            outcome="success" if recovery_ok else "failure",
            route_resolution="unmatched",
            metadata=_episode_metadata(metadata, state, recovery_decision, recovery=True),
            finish_metadata=finish_metadata,
            failure_reason=None if recovery_ok else "Frontier recovery failed",
            context={"state": state, "routing": _episode_metadata({}, state, recovery_decision, recovery=True)["routing"]},
        )
        return JBrancherStepResult(
            recovery_decision,
            recovery_action,
            "frontier",
            recovery_result,
            recovery_verified,
            recovery_episode,
            recovered=True,
        )


__all__ = ["JBrancherHarborLoop", "JBrancherStepResult"]
