# Live Pi preference-learning benchmark — 2026-09-21

This bounded TypeSafe integration measurement used the real Pi route-choice
path with `jev-latest`, which resolved to `jev-1.13.0`. The run used one
SWE-bench Lite problem statement, four repetitions, two competing route
choices, and deterministic route verification. The API key was loaded from the
ignored local `.env` file and is not present here.

| Metric | Result |
| --- | ---: |
| Baseline Jev calls | 4 |
| Actual Jev calls | 2 |
| Jev calls avoided | 2 (50%) |
| Observed Jev input tokens | 1,340 |
| Observed Jev output tokens | 92 |
| Verified learned-route coverage | 100% |
| Task success preserved | 100% |

Jev selected the correct failing-test route on both warm-up attempts. After the
second verified success, the project-local preference handled the final two
attempts with no provider usage. This validates the Pi preference optimization,
not patch generation or bug resolution; the route executor was deterministic and
the official SWE-bench Docker grader was not run.

Reproduce with:

```sh
npm run bench:live-pi-learning -- --instances 1 --repetitions 4 --assert
```

Source instance: [SWE-bench Lite](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite), using the checked-in compact summary and current `FAIL_TO_PASS` value.
