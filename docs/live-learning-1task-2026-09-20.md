# Live JBrancher learning benchmark — 2026-09-20 (one task)

This bounded run used the real TypeSafe `jev-1.13.0` endpoint with one
SWE-bench Lite problem statement and three repetitions. The executor was a
deterministic read fixture; this is a routing-efficiency measurement, not an
official SWE-bench patch-resolution result.

The API key was loaded from the ignored local `.env` file and is not present in
this report. The learning store was temporary and local.

| Metric | Result |
| --- | ---: |
| Baseline Jev calls | 3 |
| Actual Jev calls | 2 |
| Jev calls avoided | 1 (33.3%) |
| Observed Jev input tokens | 960 |
| Observed Jev output tokens | 44 |
| Estimated avoided usage at observed average | 480 input + 22 output tokens |
| Learned-route coverage after warm-up | 100% |
| Baseline fixture success rate | 100% |
| JBrancher fixture success rate | 100% |

The first two attempts used the frontier fallback after live Jev evaluation.
The third attempt used the locally learned candidate-authorized route, taking
4.1 ms with zero evaluator or actor calls. No external database was used.

Reproduce with:

```sh
npm run bench:live-learning -- --instances 1 --repetitions 3
```

Source prompts: [SWE-bench Lite](https://huggingface.co/datasets/SWE-bench/SWE-bench_Lite).
