# Claude Code wrapper

The initial integration is shadow-only. `jbrancher wrap claude` launches the
native CLI with temporary `--settings` containing authenticated HTTP hooks for
`UserPromptSubmit` and `PreToolUse`. Hook replies are always empty JSON objects;
scores cannot become permission decisions. Existing permissions still apply.

The wrapper launches without a shell, passes arguments after `--` directly,
inherits terminal IO, propagates exit codes, forwards termination signals, and
cleans up its temporary settings on normal exit or launch failure. No global or
project Claude configuration is edited. Native Windows `claude.exe` is supported;
legacy npm command shims are not a tested launch target.

Current-prompt context is held in memory for up to 32 prompt IDs. Events with no
matching prompt are skipped, including some resumed or subagent events. At most
two evaluations run concurrently, with a three-second provider timeout and a
default total cap of 25. Hook responses do not wait for inference. Shutdown waits
for outstanding evaluations. The cap counts attempts, including failures.

The prompt and proposed tool input are sent to TypeSafe. No transcripts or project
files are read by the wrapper. Logs store only score, timestamp, elapsed inference
time, availability status and counters. The TypeSafe key is removed from the
launched child's environment; this does not prevent Claude from accessing an
otherwise readable `.env` file. Protect local credentials through normal permissions.

## Verification on 2026-09-18

- Automated HTTP tests exercise authentication, shadow replies before inference
  finishes, evaluation caps, missing context, provider errors and sanitized logs.
- Argument tests reject guard mode, invalid budgets and conflicting settings.
- Launch failure tests confirm service shutdown and summary recording.
- Native Claude Code 2.1.117 launched successfully through the wrapper with
  `--max-evaluations 0 -- --version`.
- A real TypeSafe request through the hook service scored a synthetic README read
  at 0.94 in 460 ms. Both hook replies were `200 {}`. This verifies transport and
  parsing, not judgment accuracy or savings.
- A bounded real Claude task could not run: the local CLI reported
  `Not logged in`. Actual Claude-emitted hook delivery remains unverified.

After signing into Claude, validate delivery in a disposable project:

```sh
npx jbrancher wrap claude --max-evaluations 1 -- -p "Use Read to read README.md, then return its title" --tools Read --allowedTools Read --max-budget-usd 0.15
```

Confirm the printed summary has `observed > 0`, and inspect the local score log.
An observed count of zero can mean hooks were disabled, managed policy blocked
them, the Claude version lacks HTTP hook support, or Claude never called a tool.
Interactive terminal behavior and signal forwarding should also be checked on
each supported operating system before declaring general compatibility.

## Product boundary

This is an observation integration. Every proposed tool has already been selected
by Claude, so `actorCallsAvoided` is always zero. Scores use incomplete context
and do not establish that an action is safe, authorized, or optimal. Guard mode
and accelerated orchestration are not implemented. An Agent SDK runner alone
does not automatically expose control over every model turn; acceleration needs
an explicit, tested decision boundary before inference.

Official contracts: [Claude hooks](https://code.claude.com/docs/en/hooks) and
[CLI settings](https://code.claude.com/docs/en/cli-reference).
