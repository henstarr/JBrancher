# Claude Code wrapper

The initial integration is shadow-only. `jbrancher wrap claude` launches the
native CLI with temporary `--settings` containing authenticated HTTP hooks for
`UserPromptSubmit` and `PreToolUse`. Hook replies are always empty JSON objects;
scores cannot become permission decisions. Existing permissions still apply.
When `JBRANCHER_LEARNING=1` is set, the wrapper additionally observes
`PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure`, and `SessionEnd` to
record complete local episodes.

The wrapper launches without a shell, passes arguments after `--` directly,
inherits terminal IO, propagates exit codes, forwards termination signals, and
cleans up its temporary settings on normal exit or launch failure. No global or
project Claude configuration is edited. Native Windows `claude.exe` is supported;
legacy npm command shims are not a tested launch target.

## Adaptive local replay

For explicit non-interactive `-p`/`--print` prompts, opt into adaptive mode:

```sh
JBRANCHER_LEARNING=1 npx jbrancher wrap claude --mode adaptive --max-evaluations 0 -- \
  -p "read README.md"
```

Adaptive mode first checks the project-local `.jbrancher/routes.json`. It can
execute only an active, sufficiently observed, read-only exact or safe
path-parameterized route. A hit prints the local result and does not launch
Claude. A miss launches Claude normally and records the fallback episode for
future learning. Interactive prompts and side-effecting routes always stay on
the frontier path.

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

## Local workflow learning

Enable learning without making any Jev requests:

```sh
JBRANCHER_LEARNING=1 npx jbrancher wrap claude --max-evaluations 0 -- -p "Read README.md"
```

The wrapper writes redacted traces, dataset rows, and learned candidates to the
ignored `.jbrancher/` directory in the current working directory. Claude still
owns every permission and execution decision; this mode only records what
happened so a later JBrancher-enabled run can learn from it.

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

Shadow mode remains observation-only and reports `actorCallsAvoided: 0`. Adaptive
mode adds a deliberately narrow preflight boundary for local read-only replay;
it does not approve Claude tools or control arbitrary model turns. Scores use
incomplete context and do not establish that an action is safe, authorized, or
optimal. Side-effecting acceleration is not implemented.

Official contracts: [Claude hooks](https://code.claude.com/docs/en/hooks) and
[CLI settings](https://code.claude.com/docs/en/cli-reference).
