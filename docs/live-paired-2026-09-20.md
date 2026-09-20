# Live paired routing sample — 2026-09-20

This bounded run used the real TypeSafe `jev-1.13.0` endpoint with one
SWE-bench Lite problem statement and three repetitions. The task executor was
deterministic and only read a fixture path; this is a routing-cost measurement,
not a patch-generation or official SWE-bench result.

The API key was loaded from the ignored local `.env` file and is not present in
this report.

| Metric | Actor-only baseline | JBrancher run |
| --- | ---: | ---: |
| Task success rate | 100% | 100% |
| Actor calls | 3 | 2 |
| Jev calls | 0 | 2 |
| Provider input tokens | 5,400 assumed | 4,560 observed/assumed |
| Provider output tokens | 420 assumed | 324 observed/assumed |
| Total provider tokens | 5,820 | 4,884 |
| Learned-route coverage | — | 100% |

The third repetition used the learned local route with no provider call. Jev
input/output usage was observed directly: 960/44 tokens across two requests.
The actor usage assumption was 1,800 input and 140 output tokens per call,
provided explicitly to the benchmark; it was not measured from a frontier
provider.

For an illustrative rate check only, the run used $3/$15 per million actor
input/output tokens and $0.50/$2 per million Jev input/output tokens. That
produced an estimated $0.022500 baseline versus $0.015568 with JBrancher. The
rates are not a product pricing claim; users should supply current rates for
their own model and provider.

Reproduce the shape of this run with:

```sh
npm run bench:live-learning -- --instances 1 --repetitions 3 \
  --actor-input-tokens 1800 --actor-output-tokens 140 \
  --actor-input-rate 3 --actor-output-rate 15 \
  --jev-input-rate 0.5 --jev-output-rate 2
```
