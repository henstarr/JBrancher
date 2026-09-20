# Live JBrancher learning benchmark — 2026-09-20

This is a bounded TypeSafe integration and cost-efficiency measurement. The
API key was loaded from the ignored local `.env` file and is not present here.
The run used `jev-1.13.0`, three SWE-bench Lite problem statements, four
repetitions per problem, and a temporary local learning store.

| Metric | Result |
| --- | ---: |
| Baseline Jev calls | 12 |
| Actual Jev calls | 6 |
| Jev calls avoided | 6 (50%) |
| Observed Jev input tokens | 2,798 |
| Observed Jev output tokens | 132 |
| Learned-route coverage after warm-up | 100% |

The first two attempts for each problem paid the Jev evaluation cost and then
used the actor fallback when Jev was not confident enough. The final two
attempts used the locally learned, candidate-authorized route with no provider
usage. This validates the local cost-reduction loop, not patch generation or
bug resolution: execution was a deterministic read fixture and the official
SWE-bench Docker grader was not run.

Reproduce with:

```sh
npm run bench:live-learning -- --instances 3 --repetitions 4
```

Source prompts: [SWE-bench Lite](https://huggingface.co/datasets/SWE-bench/SWE-bench_Lite).
