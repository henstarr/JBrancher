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


@dataclass(frozen=True)
class JBrancherRunResult:
    """A completed multi-step workflow and its local learning feedback."""

    events: list[dict[str, Any]]
    state: Any
    history: list[Any]
    source: str
    outcome: str
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

    async def _record_trajectory(
        self,
        *,
        task: str,
        calls: Sequence[Mapping[str, Any]],
        outcome: str,
        route_resolution: str,
        route_id: str | None = None,
        metadata: Mapping[str, Any] | None = None,
        finish_metadata: Mapping[str, Any] | None = None,
        failure_reason: str | None = None,
    ) -> dict[str, Any]:
        """Persist one complete frontier trajectory as one local dataset row."""

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

    async def run(
        self,
        task: str,
        state: Any,
        *,
        frontier: Callback,
        execute: Callback,
        candidates: Sequence[Any] | None = None,
        candidate_steps: Sequence[Sequence[Any]] | None = None,
        candidate_provider: Callback | None = None,
        history: Sequence[Any] | None = None,
        observe: Callback | None = None,
        verify: Callback | None = None,
        max_steps: int = 12,
        metadata: Mapping[str, Any] | None = None,
        finish_metadata: Mapping[str, Any] | None = None,
    ) -> JBrancherRunResult:
        """Run and record a complete workflow, with optional local replay.

        ``candidate_steps`` enables a bounded multi-step learned-workflow
        lookup. Every learned action must still appear in the host's current
        per-step capability catalog. If no workflow matches, each step falls
        back to the supplied frontier actor and the entire successful
        trajectory is recorded as one dataset example.
        """

        if not isinstance(task, str) or not task.strip():
            raise ValueError("task must be a non-empty string")
        if not callable(frontier) or not callable(execute):
            raise TypeError("frontier and execute callbacks are required")
        if verify is not None and not callable(verify):
            raise TypeError("verify must be callable when provided")
        if observe is not None and not callable(observe):
            raise TypeError("observe must be callable when provided")
        if candidate_provider is not None and not callable(candidate_provider):
            raise TypeError("candidate_provider must be callable when provided")
        if not isinstance(max_steps, int) or isinstance(max_steps, bool) or max_steps < 1 or max_steps > 100:
            raise ValueError("max_steps must be an integer from 1 to 100")
        if candidate_steps is not None:
            if not isinstance(candidate_steps, (list, tuple)) or any(
                not isinstance(step, (list, tuple)) for step in candidate_steps
            ):
                raise ValueError("candidate_steps must be a sequence of candidate sequences")

        current_state = state
        current_history = list(history or [])
        events: list[dict[str, Any]] = []

        # A workflow match is checked once against the host's complete current
        # capability catalog. Execution and verification remain host-owned.
        if candidate_steps is not None:
            workflow = await asyncio.to_thread(
                self.proxy.workflow,
                task,
                current_state,
                candidate_steps,
                current_history,
                max_steps,
            )
            if workflow.get("source") == "learned" and isinstance(workflow.get("actions"), list):
                calls: list[dict[str, Any]] = []
                learned_ok = True
                for step_number, raw_action in enumerate(workflow["actions"]):
                    action = _normalize_action(raw_action)
                    if action is None:
                        learned_ok = False
                        break
                    result = await _invoke(execute, action)
                    verified = None if verify is None else bool(await _invoke(verify, action, result))
                    ok = _result_ok(result, verified)
                    event = {
                        "step": step_number,
                        "state": current_state,
                        "decision": {**workflow, "action": action},
                        "action": action,
                        "result": result,
                        "verified": verified,
                        "source": "learned",
                    }
                    events.append(event)
                    calls.append(_tool_call(
                        action,
                        result,
                        ok,
                        {"state": current_state, "routing": {"source": "learned", "routeId": workflow.get("routeId"), "step": step_number}},
                    ))
                    if not ok:
                        learned_ok = False
                        break
                    current_history.append(event)
                    if observe is not None:
                        current_state = await _invoke(observe, current_state, event, current_history)
                if learned_ok and len(events) == len(workflow["actions"]):
                    episode = await self._record_trajectory(
                        task=task,
                        calls=calls,
                        outcome="success",
                        route_resolution="learned",
                        route_id=workflow.get("routeId"),
                        metadata={**(metadata or {}), "steps": len(events), "sources": ["learned"]},
                        finish_metadata=finish_metadata,
                    )
                    return JBrancherRunResult(events, current_state, current_history, "learned", "success", episode)

                # A failed learned workflow is durable failure evidence. The
                # single-step helper performs the immediate frontier recovery;
                # the caller still receives the failed learned events.
                failed_episode = await self._record_trajectory(
                    task=task,
                    calls=calls,
                    outcome="failure",
                    route_resolution="failed",
                    route_id=workflow.get("routeId"),
                    metadata={**(metadata or {}), "steps": len(events), "sources": ["learned"]},
                    finish_metadata=finish_metadata,
                    failure_reason="Learned workflow execution or postcondition failed",
                )
                recovery = await self.step(
                    task,
                    current_state,
                    frontier=frontier,
                    execute=execute,
                    candidates=candidates,
                    history=current_history,
                    verify=verify,
                    metadata={**(metadata or {}), "recovery": True},
                    finish_metadata=finish_metadata,
                )
                events.append({
                    "step": len(events),
                    "state": current_state,
                    "decision": recovery.decision,
                    "action": recovery.action,
                    "result": recovery.result,
                    "verified": recovery.verified,
                    "source": recovery.source,
                })
                return JBrancherRunResult(
                    events,
                    current_state,
                    [*current_history, events[-1]],
                    recovery.source,
                    "success" if recovery.episode and recovery.episode.get("trace", {}).get("outcome") == "success" else "failure",
                    recovery.episode or failed_episode,
                    recovered=True,
                )

        calls: list[dict[str, Any]] = []
        outcome = "unknown"
        route_resolutions: list[str] = []
        route_ids: list[str] = []
        sources: list[str] = []
        try:
            for step_number in range(max_steps):
                current_candidates = candidates
                if candidate_provider is not None:
                    current_candidates = await _invoke(candidate_provider, current_state, current_history)
                if current_candidates is None:
                    current_candidates = []
                if not isinstance(current_candidates, (list, tuple)):
                    raise TypeError("candidate_provider must return a sequence")
                decision = await asyncio.to_thread(
                    self.proxy.decide,
                    task,
                    current_state,
                    list(current_candidates),
                    current_history,
                )
                route_resolution = decision.get("routeResolution", "unmatched")
                route_resolutions.append(route_resolution)
                learned = decision.get("source") == "learned"
                action = _normalize_action(decision.get("action") if learned else await _invoke(frontier, decision))
                sources.append("learned" if learned else "frontier")
                if isinstance(decision.get("routeId"), str):
                    route_ids.append(decision["routeId"])
                if action is None:
                    outcome = "unknown"
                    break
                result = await _invoke(execute, action)
                verified = None if verify is None else bool(await _invoke(verify, action, result))
                ok = _result_ok(result, verified)
                event = {
                    "step": step_number,
                    "state": current_state,
                    "decision": decision,
                    "action": action,
                    "result": result,
                    "verified": verified,
                    "source": "learned" if learned else "frontier",
                }
                events.append(event)
                calls.append(_tool_call(
                    action,
                    result,
                    ok,
                    {"state": current_state, "routing": {"source": sources[-1], "routeResolution": route_resolution, "step": step_number}},
                ))
                if not ok:
                    outcome = "failure"
                    break
                outcome = "success"
                current_history.append(event)
                if observe is not None:
                    current_state = await _invoke(observe, current_state, event, current_history)
        except Exception:
            if calls:
                await self._record_trajectory(
                    task=task,
                    calls=calls,
                    outcome="failure",
                    route_resolution="failed",
                    route_id=route_ids[0] if len(set(route_ids)) == 1 else None,
                    metadata={**(metadata or {}), "steps": len(events), "sources": sources},
                    finish_metadata=finish_metadata,
                    failure_reason="Harness execution failed",
                )
            raise

        episode = await self._record_trajectory(
            task=task,
            calls=calls,
            outcome=outcome,
            route_resolution="learned" if sources and all(source == "learned" for source in sources)
            else route_resolutions[0] if route_resolutions else "unmatched",
            route_id=route_ids[0] if len(route_ids) == 1 else None,
            metadata={**(metadata or {}), "steps": len(events), "sources": sources},
            finish_metadata=finish_metadata,
        )
        source = "learned" if sources and all(item == "learned" for item in sources) else "frontier" if sources else "abstain"
        return JBrancherRunResult(events, current_state, current_history, source, outcome, episode)


__all__ = ["JBrancherHarborLoop", "JBrancherStepResult", "JBrancherRunResult"]
