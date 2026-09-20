# Changelog

## 0.1.0 - 2026-09-17

- Added the initial JBrancher runtime.
- Added bounded Jev candidate evaluation with actor fallback.
- Added an offline demo, tests, documentation, and CI.
- Added `jbrancher demo`, `doctor`, and bounded `live-check` commands.
- Added GitHub README buttons and safe `.env.example` onboarding.
# Unreleased

- Add a native Pi package/extension with deterministic-first input routing,
  project-local routes, optional Jev disambiguation, safe read-only built-ins,
  shadow mode, and frontier fallback on uncertainty or failure.
- Add local Pi learning mode with redacted JSONL traces, repeated-workflow
  candidate mining, conservative paraphrase generalization, automatic read-only
  promotion, guarded path templates, a harness-neutral episode recorder, and a
  SWE-bench Lite routing replay.
- Add optional generic-runtime learning: actor fallback episodes can be stored
  locally, promoted after repeated safe success, and reused only when the
  harness still exposes the learned action as an allowed candidate.
- Add multi-step generic workflow replay, learned-route quarantine after
  execution failure, and an official SWE-bench evaluator command wrapper.
- Add an optional harness-owned learning outcome/postcondition hook so tool
  completion alone does not have to qualify a trace for promotion.
- Add open-world local learning: successful non-registered fallback episodes are
  captured as dataset rows and reviewable candidates on first observation, while
  automatic execution still requires repeated safe evidence.
- Record generic no-tool fallback episodes as non-reusable dataset evidence and
  assign dataset splits from stable task/action fingerprints for reliable
  holdout evaluation across repeated runs.
- Add `jbrancher dataset` for exporting and inspecting local fallback episodes
  without changing learned-route status.
- Expand the local SWE-bench Lite replay to 14 prompts across seven repositories
  and normalize two conservative investigation wrappers so held-out route
  coverage remains measurable across varied issue text.
- Run offline routing, token-optimization, and local-learning benchmarks in CI
  alongside the test suite.
- Add benchmark `--assert` gates so coverage and efficiency regressions fail in
  local and CI runs instead of remaining informational output.
- Serialize local learning-store mutations across concurrent harness sessions
  with a bounded crash-recoverable lock and unique atomic temp files.
- Revalidate learned multi-step workflows against the current harness
  postcondition and capture frontier recovery after a quarantined Pi route.
- Add opt-in postcondition-verified promotion for generic harness workflows,
  plus a benchmark arm covering a repeated side-effecting action.
- Quarantine learned single-step actions when their current postcondition
  rejects execution, matching multi-step replay behavior.
- Add active context optimization with bounded Jev relevance scoring, required-context
  preservation, token budgets, local fallback, and a token-usage hill-climb benchmark.
- Add `jbrancher wrap codex --prompt "task"` for bounded command-event shadow
  scoring in Codex batch sessions, with opt-in local episode learning.
- Add `jbrancher wrap claude` with session-scoped HTTP hooks, bounded background
  Jev scoring, private score logs, opt-in local episode learning, and unchanged
  permission decisions.
- Document shadow mode and the outstanding authenticated Claude integration check.
