# Live Codex HTTP-proxy learning benchmark — 2026-09-20

This run used the installed Codex CLI as the frontier actor, one SWE-bench
Lite problem statement, three repetitions, and the local JBrancher HTTP proxy.
The executor returned deterministic fixture contents; this measures actor-call
avoidance and local replay, not patch generation or official SWE-bench
resolution.

| Metric | Actor-only | JBrancher proxy |
| --- | ---: | ---: |
| Fixture task success | 100% | 100% |
| Codex actor calls | 3 | 2 |
| Input tokens | 47,838 observed | 31,892 observed |
| Output tokens | 27 observed | 18 observed |
| Total tokens | 47,865 | 31,910 |
| Learned-route coverage | — | 100% |
| Successful replay records | — | 1 |

The proxy used Codex for two warm-up episodes, promoted the successful
read-only route locally, and handled the third decision without a frontier
call. The learned replay took 15.3 ms in this run. The local store contained
three redacted traces and one active route after completion.

For an illustrative rate calculation only, the command used $3 per million
input tokens and $15 per million output tokens. That estimates $0.143919 for
the actor-only arm and $0.095946 for the JBrancher arm, saving $0.047973
(33.3%). These rates are not a Codex pricing claim; supply current rates for a
meaningful cost comparison.

Reproduce with:

```sh
npm run bench:live-codex-proxy -- --instances 1 --repetitions 3 \
  --actor-input-rate 3 --actor-output-rate 15 --assert
```

The benchmark uses a temporary read-only workspace, stores no API key or task
output, and removes its local learning directory after completion.
