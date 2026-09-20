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
| Input tokens | 47,838 observed | 31,892 observed |
| Output tokens | 27 observed | 42 observed |
| Total tokens | 47,865 | 31,934 |
| Learned-route coverage | — | 100% |

JBrancher used Codex for the first two attempts, promoted the successful
read-only route locally, and handled the third attempt with the learned route.
The learned replay took 4.7 ms in this run and made no provider request. The
route record retained one `successfulReplays` hit and its `lastReplayAt` value.

For an illustrative rate calculation only, the command used $3 per million
input tokens and $15 per million output tokens. That estimates $0.143919 for
the actor-only arm and $0.096306 for the JBrancher arm, saving $0.047613
(33.3%). The rates are not a Codex pricing claim; supply current rates for a
meaningful cost comparison.

The paired run saved 15,931 observed provider tokens while preserving the
fixture success result.

Reproduce with:

```sh
npm run bench:live-codex -- --instances 1 --repetitions 3 \
  --actor-input-rate 3 --actor-output-rate 15
```

No API key or task output is stored in this report. The benchmark removes its
temporary learning directory after completion.
