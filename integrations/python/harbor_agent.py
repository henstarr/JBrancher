"""Optional Harbor ``BaseAgent`` adapter for JBrancher.

Harbor is intentionally an optional dependency. When Harbor is installed,
``JBrancherHarborAgent`` subclasses its current ``BaseAgent`` interface. When
it is not installed, this module remains importable so local tests and custom
harnesses can still use the class as a lightweight adapter base.

The adapter owns routing, local learning, and redacted episode capture. A
subclass owns the frontier model and any non-``exec`` tools. This preserves the
host's authorization and execution boundary instead of allowing a learned
route to invent commands.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Any, Mapping, Sequence

from .harbor import JBrancherHarborLoop
from .jbrancher_proxy import JBrancherProxy

try:  # pragma: no cover - the optional dependency is exercised by Harbor.
    from harbor.agents.base import BaseAgent as _HarborBaseAgent
    from harbor.environments.base import BaseEnvironment
    from harbor.models.agent.context import AgentContext
except ImportError:  # Keep the package usable without installing Harbor.
    BaseEnvironment = Any  # type: ignore[assignment,misc]
    AgentContext = Any  # type: ignore[assignment,misc]

    class _HarborBaseAgent:
        """Small fallback matching the constructor shape used by this adapter."""

        def __init__(self, logs_dir: Path | str | None = None, model_name: str | None = None, **_: Any) -> None:
            self.logs_dir = Path(logs_dir or ".")
            self.model_name = model_name
            self.logger = logging.getLogger("jbrancher.harbor")


class JBrancherHarborAgent(_HarborBaseAgent):
    """A Harbor-compatible base agent with local JBrancher learning.

    Subclasses normally implement only :meth:`frontier_action`. The default
    action catalog is empty, which makes the first encounter open-world and
    sends it to the frontier. To enable replay, override
    :meth:`candidate_actions` or :meth:`candidate_steps` with the actions that
    the current environment and policy authorize.

    The default executor supports a deliberately narrow ``exec`` action:

    ``{"tool": "exec", "args": {"command": "pytest -q"}}``

    Other tools must be implemented by overriding :meth:`execute_action`.
    """

    def __init__(
        self,
        *args: Any,
        proxy: JBrancherProxy | None = None,
        proxy_url: str | None = None,
        source: str = "harbor-jbrancher",
        learning_cwd: str | None = None,
        max_steps: int = 12,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        if proxy is not None and not isinstance(proxy, JBrancherProxy):
            raise TypeError("proxy must be a JBrancherProxy")
        if not isinstance(source, str) or not source.strip():
            raise ValueError("source must be a non-empty string")
        if not isinstance(max_steps, int) or isinstance(max_steps, bool) or not 1 <= max_steps <= 100:
            raise ValueError("max_steps must be an integer from 1 to 100")
        self.proxy = proxy or JBrancherProxy(
            proxy_url or os.environ.get("JBRANCHER_PROXY_URL", "http://127.0.0.1:8787")
        )
        self.source = source
        self.learning_cwd = learning_cwd or os.environ.get("JBRANCHER_LEARNING_CWD", "/workspace")
        self.max_steps = max_steps
        self._environment: BaseEnvironment | None = None
        self._loop = JBrancherHarborLoop(self.proxy, source=source, cwd=self.learning_cwd)

    @staticmethod
    def name() -> str:
        return "jbrancher-harbor"

    def version(self) -> str | None:
        return "0.1.0"

    async def setup(self, environment: BaseEnvironment) -> None:
        """Validate the local proxy and retain Harbor's environment handle."""

        self._environment = environment
        health = await asyncio.to_thread(self.proxy.health)
        if health.get("status") != "healthy" or not health.get("learningConfigured"):
            raise RuntimeError(
                "JBrancher proxy is not ready for learning; start `jbrancher proxy "
                "--learning-dir .jbrancher` and set JBRANCHER_PROXY_URL if needed"
            )

    async def candidate_actions(
        self,
        instruction: str,
        state: Any,
        history: Sequence[Any],
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> Sequence[Any] | None:
        """Return actions currently authorized for the next step.

        The default empty catalog intentionally keeps unknown work on the
        frontier. A production subclass should derive this from permissions,
        current state, and available tools—not from the learned dataset.
        """

        return []

    async def candidate_steps(
        self,
        instruction: str,
        state: Any,
        history: Sequence[Any],
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> Sequence[Sequence[Any]] | None:
        """Return a per-step workflow catalog, or ``None`` for step routing."""

        return None

    async def frontier_action(
        self,
        instruction: str,
        state: Any,
        decision: Mapping[str, Any],
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> Mapping[str, Any] | None:
        """Choose an action with the existing frontier model.

        Implement this hook with Claude, Codex, an internal model, or another
        harness actor. It is called for unmatched, uncertain, and recovered
        decisions; JBrancher never fabricates the fallback action.
        """

        raise NotImplementedError(
            "Implement frontier_action() with the Harbor agent's existing frontier model"
        )

    async def execute_action(
        self,
        action: Mapping[str, Any],
        environment: BaseEnvironment,
        state: Any,
        context: AgentContext,
    ) -> Mapping[str, Any]:
        """Execute one action; subclasses add their tool types here."""

        if action.get("tool") != "exec":
            raise NotImplementedError(
                f"No default executor for tool {action.get('tool')!r}; override execute_action()"
            )
        args = action.get("args")
        if not isinstance(args, Mapping) or not isinstance(args.get("command"), str) or not args["command"].strip():
            raise ValueError("exec actions require args.command")
        result = await environment.exec(
            args["command"],
            cwd=args.get("cwd"),
            timeout_sec=args.get("timeout_sec"),
        )
        return {
            "ok": getattr(result, "return_code", 1) == 0,
            "output": getattr(result, "stdout", None),
            "error": getattr(result, "stderr", None),
            "returnCode": getattr(result, "return_code", None),
        }

    async def verify_action(
        self,
        action: Mapping[str, Any],
        result: Any,
        environment: BaseEnvironment,
        state: Any,
        context: AgentContext,
    ) -> bool | None:
        """Return a host-owned postcondition result for this action."""

        if isinstance(result, Mapping) and "ok" in result:
            return bool(result["ok"])
        return True

    async def observe_state(
        self,
        state: Any,
        event: Mapping[str, Any],
        history: Sequence[Any],
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> Any:
        """Update state after an action; the default state is immutable."""

        return state

    def _write_context(self, context: AgentContext, result: Any) -> None:
        summary = {
            "source": result.source,
            "outcome": result.outcome,
            "steps": len(result.events),
            "recovered": result.recovered,
        }
        if isinstance(result.episode, Mapping):
            trace = result.episode.get("trace")
            if isinstance(trace, Mapping) and isinstance(trace.get("routeId"), str):
                summary["routeId"] = trace["routeId"]
        existing = getattr(context, "metadata", None) or {}
        try:
            context.metadata = {**existing, "jbrancher": summary}
        except (AttributeError, TypeError):
            # A custom harness context may be immutable; learning already
            # completed, so context reporting must remain best-effort.
            self.logger.debug("Harbor context does not accept JBrancher metadata")

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Route one Harbor task through local replay or the frontier actor."""

        state: Any = {"cwd": self.learning_cwd, "agent": self.name()}
        live_state = state

        async def frontier(decision: Mapping[str, Any]) -> Mapping[str, Any] | None:
            return await self.frontier_action(instruction, live_state, decision, environment, context)

        async def execute(action: Mapping[str, Any]) -> Mapping[str, Any]:
            return await self.execute_action(action, environment, live_state, context)

        async def verify(action: Mapping[str, Any], result: Any) -> bool | None:
            return await self.verify_action(action, result, environment, live_state, context)

        async def observe(current_state: Any, event: Mapping[str, Any], history: list[Any]) -> Any:
            nonlocal live_state
            live_state = await self.observe_state(current_state, event, history, environment, context)
            return live_state

        async def provide_candidates(current_state: Any, history: list[Any]) -> Sequence[Any] | None:
            return await self.candidate_actions(instruction, current_state, history, environment, context)

        workflow_candidates = await self.candidate_steps(
            instruction, state, [], environment, context
        )
        result = await self._loop.run(
            instruction,
            state,
            candidates=[],
            candidate_steps=workflow_candidates,
            candidate_provider=provide_candidates,
            frontier=frontier,
            execute=execute,
            observe=observe,
            verify=verify,
            max_steps=self.max_steps,
            metadata={"harborAgent": self.name()},
        )
        self._write_context(context, result)


__all__ = ["JBrancherHarborAgent"]
