"""Small dependency-free Python client for the JBrancher local proxy.

The harness remains responsible for executing actions and checking outcomes.
This module only transports bounded decisions and redacted episode metadata to
the local JBrancher service; it does not call a hosted database or model.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Iterable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class JBrancherProxyError(RuntimeError):
    """Raised when the local proxy cannot return a valid JSON response."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class JBrancherProxy:
    """Call a local JBrancher proxy without third-party Python dependencies."""

    def __init__(self, base_url: str = "http://127.0.0.1:8787", timeout: float = 5.0) -> None:
        if not isinstance(base_url, str) or not base_url.strip():
            raise ValueError("base_url must be a non-empty string")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _request(self, path: str, payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = Request(
            f"{self.base_url}{path}",
            data=data,
            headers={"Accept": "application/json", "Content-Type": "application/json"},
            method="GET" if data is None else "POST",
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
                status = response.status
        except HTTPError as error:
            raw = error.read()
            try:
                detail = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                detail = {"error": raw.decode("utf-8", errors="replace")}
            raise JBrancherProxyError(
                f"JBrancher proxy returned HTTP {error.code}: {detail.get('error', detail)}",
                status=error.code,
            ) from error
        except URLError as error:
            raise JBrancherProxyError(f"JBrancher proxy is unavailable: {error.reason}") from error

        try:
            result = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise JBrancherProxyError(f"JBrancher proxy returned invalid JSON (HTTP {status})") from error
        if not isinstance(result, dict):
            raise JBrancherProxyError("JBrancher proxy response must be a JSON object", status=status)
        return result

    def health(self) -> dict[str, Any]:
        return self._request("/health")

    def stats(self) -> dict[str, Any]:
        return self._request("/stats")

    def learning(self) -> dict[str, Any]:
        return self._request("/v1/learning")

    def decide(
        self,
        task: str,
        state: Any,
        candidates: Sequence[Any] | None = None,
        history: Sequence[Any] | None = None,
    ) -> dict[str, Any]:
        if not isinstance(task, str) or not task.strip():
            raise ValueError("task must be a non-empty string")
        if candidates is not None and not isinstance(candidates, (list, tuple)):
            raise ValueError("candidates must be a sequence when provided")
        return self._request(
            "/v1/decide",
            {
                "task": task,
                "state": state,
                "history": list(history or []),
                "candidates": list(candidates or []),
            },
        )

    def record_episode(
        self,
        task: str,
        tool_calls: Iterable[Mapping[str, Any]],
        outcome: str | None = None,
        *,
        cwd: str | None = None,
        source: str = "python-harness",
        route_resolution: str = "unmatched",
        route_id: str | None = None,
        metadata: Mapping[str, Any] | None = None,
        finish_metadata: Mapping[str, Any] | None = None,
        failure_reason: str | None = None,
    ) -> dict[str, Any]:
        calls: list[dict[str, Any]] = []
        for call in tool_calls:
            if not isinstance(call, Mapping) or not isinstance(call.get("tool_name", call.get("toolName")), str):
                raise ValueError("each tool call needs tool_name and input")
            if "input" not in call:
                raise ValueError("each tool call needs tool_name and input")
            normalized: dict[str, Any] = {
                "toolName": call.get("tool_name", call.get("toolName")),
                "input": call["input"],
            }
            for source_key, target_key in (
                ("tool_call_id", "toolCallId"),
                ("toolCallId", "toolCallId"),
                ("context", "context"),
                ("ok", "ok"),
                ("output", "output"),
                ("content", "content"),
            ):
                if source_key in call:
                    normalized[target_key] = call[source_key]
            calls.append(normalized)

        payload: dict[str, Any] = {
            "task": task,
            "source": source,
            "routeResolution": route_resolution,
            "toolCalls": calls,
        }
        if outcome is not None:
            payload["outcome"] = outcome
        if cwd is not None:
            payload["cwd"] = cwd
        if route_id is not None:
            payload["routeId"] = route_id
        if metadata is not None:
            payload["metadata"] = dict(metadata)
        if finish_metadata is not None:
            payload["finishMetadata"] = dict(finish_metadata)
        if failure_reason is not None:
            payload["failureReason"] = failure_reason
        return self._request("/v1/episodes", payload)

    def decide_and_record_frontier(
        self,
        task: str,
        state: Any,
        candidates: Sequence[Any] | None,
        frontier: Callable[[dict[str, Any]], Mapping[str, Any]],
        *,
        history: Sequence[Any] | None = None,
        **episode_options: Any,
    ) -> tuple[dict[str, Any], Mapping[str, Any]]:
        """Choose locally when possible, otherwise ask the caller's frontier actor.

        The returned action is not executed here. The caller must execute it,
        validate the result, and call ``record_episode`` with the final outcome.
        """

        decision = self.decide(task, state, candidates, history)
        if decision.get("source") == "learned":
            return decision, decision.get("action")
        action = frontier(decision)
        if not isinstance(action, Mapping):
            raise ValueError("frontier must return an action mapping")
        return decision, action
