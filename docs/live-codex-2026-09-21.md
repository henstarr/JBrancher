# Live Codex actor-learning benchmark — 2026-09-21

This bounded run used the installed Codex CLI as the frontier actor, one
SWE-bench Lite problem statement, three repetitions, and a temporary
read-only workspace. The executor returned deterministic fixture contents, so
this measures real actor usage and local replay rather than patch generation or
official SWE-bench resolution.

| Metric | Actor-only | JBrancher |
| --- | ---: | ---: |
| Fixture task success | 100% | 100% |
| Codex actor calls | 3 | 2 |
| Input tokens | 47,838 observed | 31,892 observed |
| Output tokens | 27 observed | 36 observed |
| Total provider tokens | 47,865 | 31,928 |
| Learned-route coverage | — | 100% |
| Learned replay latency | — | 4.8 ms |

JBrancher used Codex for the first two attempts, promoted the successful
read-only route locally, and handled the third attempt without a provider
request. This avoided one of three actor calls and saved 15,937 observed
provider tokens while preserving the fixture result.

For an illustrative calculation only, applying $3 per million input tokens and
$15 per million output tokens gives $0.143919 for the actor-only arm and
$0.096216 for the JBrancher arm, a $0.047703 (33.1%) reduction. These rates are
not a Codex pricing claim; use current rates for a real cost report.

Reproduce with:

```sh
npm run bench:live-codex -- --instances 1 --repetitions 3
```

No API key or task output is stored in this report. The benchmark removes its
temporary learning directory after completion.
