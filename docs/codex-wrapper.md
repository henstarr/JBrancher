# Codex shadow wrapper

```sh
npm install github:henstarr/JBrancher
# Configure TYPESAFE_API_KEY in the current directory's ignored .env.
npx jbrancher wrap codex --prompt "Read README.md and report the project name" --max-evaluations 1 -- --sandbox read-only --ephemeral
```

Requires Node >=20 and an authenticated native Codex CLI on PATH. The wrapper
launches `codex exec` using the existing model/configuration. Arguments after `--`
must be exec options, not a prompt or subcommand. The wrapper supplies the prompt
through stdin and owns JSON output. Interactive mode, resume, and fork are unsupported.

## Contract

- Observe `command_execution` items from the documented [Codex JSONL stream](https://developers.openai.com/codex/noninteractive).
- Deduplicate started/completed events by item ID; completed-only events can be scored.
- Score the initial task plus command, without file contents, output, or prior history.
- Never feed scores back to Codex, approve tools, bypass hook trust, or modify config.
- Forward stdout; keep wrapper diagnostics on stderr and propagate child exit status.
- Remove the TypeSafe credential from the child environment. This is not filesystem
  isolation: a child with access to `.env` could still read it under its own permissions.
- Store sanitized scores and summaries in `~/.jbrancher/sessions/*.jsonl`.
- Default cap 25 (0–1000 supported), two concurrent evaluations, three-second timeout,
  no retries. Pending evaluations finish at shutdown. Skipped commands are counted.
- Ignore malformed/oversized event lines for observation while still forwarding them.

The wrapper does not observe MCP calls, web searches, or file-change items. A zero
observed count is not proof of integration. Native hooks have a separate review/trust
workflow; this adapter intentionally uses stream observation instead. Execution may
already have started when a score arrives. `actorCallsAvoided` is always zero.

## Live validation: 2026-09-18 (local date)

Windows, Node 20.20.2, Codex 0.155.0-alpha.9, existing ChatGPT login, read-only sandbox:
the task requested one shell read of the first 15 README lines and only the project
name in the final answer. Actual result: `JBrancher`, child exit 0; one command
observed/evaluated, zero skipped/unavailable/log errors. Jev returned 0.87 in 573 ms.
This is one integration smoke test, not a latency distribution, calibrated quality
measurement, or SWE-bench/Terminal-Bench result.

A second run through `bin/jbrancher.js wrap codex`, loading the credential from
the current directory's `.env`, also exited 0 with one observed/evaluated command
and no errors (score 0.84, 475 ms). A packed-and-installed artifact launched
`codex exec --version` successfully with evaluation cap zero. An invalid Codex
option propagated exit 1 without making any TypeSafe requests.

Unit tests cover lifecycle deduplication, caps, concurrent requests, invalid scores,
provider/log errors, split/malformed/oversized events, argument validation, and launch
failure. Other OSes/CLI versions and interactive sessions are not verified. The
Claude native CLI is installed but currently logged out, so authenticated Claude
event delivery remains unverified.
