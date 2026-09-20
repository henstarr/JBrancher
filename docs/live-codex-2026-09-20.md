# Live Codex actor-learning benchmark — 2026-09-20

This run used the installed Codex CLI as the frontier actor, one SWE-bench
Lite problem statement, three repetitions, and a temporary read-only workspace.
The task executor only returned deterministic fixture contents; this measures
actor-call avoidance and local replay, not patch generation or official
SWE-bench resolution.

| Metric | Actor-only | JBrancher |
| --- | ---: | ---: |
| Fixture task success | 100% | 100% |
| Codex actor calls | 3 | 2 |
| Input tokens | 47,832 observed | 31,888 observed |
| Output tokens | 54 observed | 40 observed |
| Total tokens | 47,886 | 31,928 |
| Learned-route coverage | — | 100% |

JBrancher used Codex for the first two attempts, promoted the successful
read-only route locally, and handled the third attempt with the learned route.
The learned replay took 0.9 ms in this run and made no provider request.

For an illustrative rate calculation only, the command used $3 per million
input tokens and $15 per million output tokens. That estimates $0.144306 for
the actor-only arm and $0.096264 for the JBrancher arm, saving $0.048042
(33.3%). The rates are not a Codex pricing claim; supply current rates for a
meaningful cost comparison.

Reproduce with:

```sh
npm run bench:live-codex -- --instances 1 --repetitions 3 \
  --actor-input-rate 3 --actor-output-rate 15
```

No API key or task output is stored in this report. The benchmark removes its
temporary learning directory after completion.
