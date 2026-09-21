# Live Pi preference-learning benchmark: 14-task sample — 2026-09-20

This run used TypeSafe's `jev-1.13.0` Choice evaluator through the Pi router
on all 14 checked-in SWE-bench Lite fixtures (11 dev and 3 test examples), four
repetitions per task, and deterministic route verification. The API key was
loaded from the ignored local `.env` file and is not present here.

The run used an explicitly calibrated route profile:

```text
minimumProbability = 0.45
minimumMargin = 0.05
```

These values are benchmark configuration, not universal safety defaults. The
default router thresholds remain conservative until a larger harness-native
calibration set is available.

| Metric | Result |
| --- | ---: |
| Baseline Jev calls | 56 |
| Actual Jev calls | 28 |
| Jev calls avoided | 28 (50%) |
| Observed Jev input tokens | 18,080 |
| Observed Jev output tokens | 1,288 |
| Estimated avoided input tokens at observed average | 18,080 |
| Estimated avoided output tokens at observed average | 1,288 |
| Verified learned-route coverage | 100% |
| Verified route outcome preservation | 100% |

Each task used Jev for two warm-up choices. After the second verified success,
the project-local preference handled the remaining two attempts without a Jev
request. The route verifier accepted every attempt.

The evaluator uses a TypeSafe Choice question with an explicit `no_match`
option. JBrancher compares the selected candidate against the no-match
probability and the runner-up before executing anything; an uncertain result
still falls through to Pi's frontier model.

This validates route-choice and local preference optimization, not patch
generation or bug resolution. The official SWE-bench Docker grader was not run.

Reproduce with:

```sh
npm run bench:live-pi-learning -- --instances 14 --repetitions 4 \
  --min-probability 0.45 --min-margin 0.05 --assert
```

Source: [SWE-bench Lite](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite),
using the checked-in compact summaries and current `FAIL_TO_PASS` values.
