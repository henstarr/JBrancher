# Live Pi preference-learning benchmark: three-task sample — 2026-09-20

This bounded run used the live TypeSafe `jev-1.13.0` evaluator through the Pi
router on three SWE-bench Lite problem statements, four repetitions per task,
two competing route choices, and deterministic route verification. The API key
was loaded from the ignored local `.env` file and is not present here.

| Metric | Result |
| --- | ---: |
| Baseline Jev calls | 12 |
| Actual Jev calls | 6 |
| Jev calls avoided | 6 (50%) |
| Observed Jev input tokens | 3,746 |
| Observed Jev output tokens | 240 |
| Estimated avoided input tokens at observed average | 3,746 |
| Estimated avoided output tokens at observed average | 240 |
| Verified learned-route coverage | 100% |

Each task used Jev for two warm-up decisions. After the second verified
success, the project-local preference handled the remaining two attempts with
no provider usage. The local route preserved the deterministic verifier result
for every attempt.

This validates the Pi preference optimization, not patch generation or bug
resolution. The route executor was deterministic and the official SWE-bench
Docker grader was not run.

Reproduce with:

```sh
npm run bench:live-pi-learning -- --instances 3 --repetitions 4
```

Source instances: [SWE-bench Lite](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite),
using the checked-in compact summaries and current `FAIL_TO_PASS` values.
