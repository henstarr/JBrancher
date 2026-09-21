# Live Codex actor-learning benchmark — 2026-09-21

This run used the installed Codex CLI as the frontier actor over seven
SWE-bench Lite-derived problem statements and four repetitions per task. The
baseline arm called Codex for every repetition. The JBrancher arm called Codex
for the first two successful observations, promoted the verified read route,
and replayed the route locally afterward.

This measures real provider usage and local replay. It is not an official
SWE-bench patch-resolution result: the benchmark uses deterministic read
execution and does not generate or grade repository patches.

## Result

| Metric | Actor-only baseline | JBrancher learned arm |
| --- | ---: | ---: |
| Tasks | 7 | 7 |
| Repetitions | 28 | 28 |
| Codex actor calls | 28 | 14 |
| Provider input tokens | 446,204 | 223,102 |
| Provider output tokens | 437 | 126 |
| Total provider tokens | 446,641 | 223,228 |
| Correct task attempts | 28/28 | 28/28 |
| Learned-route coverage | — | 100% after warm-up |

JBrancher avoided 14 Codex calls and 223,413 provider tokens, a 50% reduction
for this four-repetition workload. Learned replays completed in roughly 3–4 ms
per attempt in the observed rows, compared with several seconds for the Codex
decision calls.

## Reproduction

```sh
npm run bench:live-codex -- --instances 7 --repetitions 4
```

The benchmark uses the existing local Codex login and does not print or store
the TypeSafe credential. It deletes its temporary learning directory after the
run.

## Interpretation

The savings are repeat-work savings, not a claim that JBrancher improves the
frontier model's ability to solve a new bug. The first two observations are the
learning cost; the value appears when the same authorized workflow recurs. An
official SWE-bench evaluation still requires a patch-producing agent, valid
prediction JSONL, and the official Docker or Modal harness.
