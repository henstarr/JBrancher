# Changelog

## 0.1.0 - 2026-09-17

- Added the initial JBrancher runtime.
- Added bounded Jev candidate evaluation with actor fallback.
- Added an offline demo, tests, documentation, and CI.
- Added `jbrancher demo`, `doctor`, and bounded `live-check` commands.
- Added GitHub README buttons and safe `.env.example` onboarding.
# Unreleased

- Add active context optimization with bounded Jev relevance scoring, required-context
  preservation, token budgets, local fallback, and a token-usage hill-climb benchmark.
- Add `jbrancher wrap codex --prompt "task"` for bounded command-event shadow
  scoring in Codex batch sessions; validate a real authenticated read-only session.
- Add `jbrancher wrap claude` with session-scoped HTTP hooks, bounded background
  Jev scoring, private score logs, and unchanged permission decisions.
- Document shadow mode and the outstanding authenticated Claude integration check.
