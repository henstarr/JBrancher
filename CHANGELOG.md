# Changelog

## 0.1.0 - 2026-09-17

- Added the initial JBrancher runtime.
- Added bounded Jev candidate evaluation with actor fallback.
- Added an offline demo, tests, documentation, and CI.
- Added `jbrancher demo`, `doctor`, and bounded `live-check` commands.
- Added GitHub README buttons and safe `.env.example` onboarding.
# Unreleased

- Add an opt-in local HTTP episode bridge for open-world harnesses, including
  learned-route replay through `/v1/decide` and a SWE-bench-derived proxy
  benchmark with CI assertions.
- Accept learned-route completion feedback from remote harnesses and persist
  successful replay telemetry in the local route store.
- Add opt-in postcondition-verified promotion for proxy-managed write routes;
  read-only promotion remains the default.
- Quarantine a learned proxy route when a harness reports a failed outcome or
  postcondition.
- Add an opt-in live Codex benchmark that exercises the local HTTP proxy and
  measures real frontier token savings.
- Add a dependency-free Python proxy client and cross-language learning-loop
  test for Python/Harbor-style harnesses.
- Allow proxy callers to omit candidate actions for safe open-world abstention;
  the harness can send the frontier trajectory back for local dataset mining.
- Make the proxy benchmark exercise and assert that open-world abstentions are
  safe before frontier trajectories are recorded.
- Check in a fresh one-task live Jev measurement with observed usage and local
  replay latency; credentials remain outside the repository.
- Refresh the checked-in live Codex proxy report with the latest real actor
  usage and cost comparison.
- Add a dependency-free async Harbor-style loop that connects frontier choice,
  environment execution, verification, and local route feedback.
- Cover learned-route quarantine and frontier recovery in the cross-language
  integration test.
- Require Python 3.12 in CI so the cross-language integration test cannot pass
  only because Python was unavailable and the test was skipped.
- Record SWE-bench Lite split provenance in the benchmark fixture and correct
  its current Astropy `FAIL_TO_PASS` identifier.
- Make the local proxy benchmark cover all 14 checked-in SWE-bench Lite
  instances by default; smaller runs remain available with `--instances`.
- Add an explicit live Hugging Face provenance check for fixture instance IDs
  and `FAIL_TO_PASS` values.
- Preserve bounded state and routing context in Python harness episodes so
  future local route mining can distinguish why an action was selected.
- Add a dedicated CI provenance job that checks the SWE-bench Lite fixture
  against the live dataset source.
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
- Allow opt-in learning from successful Jev and rule decisions, so repeated
  authorized workflows can bypass evaluator requests without recording learned
  cache hits as new evidence.
- Add a bounded live learning benchmark that reports real Jev usage and local
  route coverage without persisting benchmark data or exposing credentials.
- Check in the first three-prompt live learning report and pin the optional
  SWE-bench evaluator dependency for reproducible official runs.
- Add opt-in Pi preference learning: repeated successful Jev route choices are
  cached locally, reused only against the current matched route set, and
  quarantined after failure.
- Add a bounded live Pi preference benchmark with deterministic verification and
  real Jev usage reporting.
- Check in the first live Pi preference result: 4 Jev calls reduced to 2 with
  100% verified learned-route coverage.
- Add read-only preference inspection through `/jbrancher preferences` and
  `jbrancher preferences`.
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
