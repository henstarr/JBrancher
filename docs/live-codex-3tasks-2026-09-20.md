# Live Codex actor-learning benchmark: three-task sample — 2026-09-20

This follow-up used the installed Codex CLI as the frontier actor across three
SWE-bench Lite problem statements, three repetitions per task, and a temporary
read-only workspace. The task executor returned deterministic fixture contents;
this measures actor-call avoidance and local replay, not patch generation or
official SWE-bench resolution.

Tasks:

- `marshmallow-code__marshmallow-1343`
- `marshmallow-code__marshmallow-1359`
- `pvlib__pvlib-python-1072`

| Metric | Actor-only | JBrancher |
| --- | ---: | ---: |
| Fixture task success | 100% | 100% |
| Codex actor calls | 9 | 6 |
| Input tokens | 143,424 observed | 95,616 observed |
| Output tokens | 81 observed | 54 observed |
| Total tokens | 143,505 | 95,670 |
| Learned-route coverage | — | 100% |

Each task used Codex for its first two JBrancher attempts, then used the
project-local learned route on the third attempt. The result is a 33.3%
reduction in actor calls and total observed tokens while preserving the fixture
verifier result on every attempt.

For an illustrative rate calculation only, the command used $3 per million
input tokens and $15 per million output tokens. That estimates $0.431487 for
the actor-only arm and $0.287658 for the JBrancher arm, saving $0.143829
(33.3%). The rates are not a Codex pricing claim; supply current rates for a
meaningful cost comparison.

Reproduce with:

```sh
npm run bench:live-codex -- --instances 3 --repetitions 3 \
  --actor-input-rate 3 --actor-output-rate 15
```

The benchmark stores no API key or task output and removes its temporary local
learning directory after completion.
