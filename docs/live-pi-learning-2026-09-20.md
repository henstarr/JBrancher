# Live Pi preference-learning benchmark — 2026-09-20

This is a bounded TypeSafe integration measurement for the Pi router. The API
key was loaded from the ignored local `.env` file and is not present here. The
run used `jev-1.13.0`, one SWE-bench Lite problem statement, four repetitions,
two competing route choices, and deterministic route verification.

| Metric | Result |
| --- | ---: |
| Baseline Jev calls | 4 |
| Actual Jev calls | 2 |
| Jev calls avoided | 2 (50%) |
| Observed Jev input tokens | 1,276 |
| Observed Jev output tokens | 80 |
| Verified learned-route coverage | 100% |

Jev selected the correct failing-test route on both warm-up attempts. After the
second verified success, the project-local preference handled the final two
attempts with no provider usage. This validates the Pi preference optimization,
not patch generation or bug resolution; the route executor was deterministic
and the official SWE-bench Docker grader was not run.

Reproduce with:

```sh
npm run bench:live-pi-learning -- --instances 1 --repetitions 4
```

Source prompt: [SWE-bench Lite](https://huggingface.co/datasets/SWE-bench/SWE-bench_Lite).
