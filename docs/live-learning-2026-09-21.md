# Live JBrancher learning benchmark — 2026-09-21

This is a bounded live TypeSafe integration measurement using the local
`TYPESAFE_API_KEY` from the ignored `.env` file. The credential is not stored
in this report. The run used `jev-1.13.0`, two SWE-bench Lite problem
statements, four repetitions per problem, and a temporary local learning
store.

| Metric | Result |
| --- | ---: |
| Baseline Jev calls | 8 |
| Actual Jev calls | 4 |
| Jev calls avoided | 4 (50%) |
| Observed Jev input tokens | 2,010 |
| Observed Jev output tokens | 148 |
| Learned-route coverage after warm-up | 100% |
| Fixture success rate | 100% |

For the paired cost comparison, the benchmark was supplied with explicit
assumptions of 1,800 actor input tokens plus 140 actor output tokens per
actor call. The rates were $3/M input and $15/M output for the actor, and
$0.50/M input and $2/M output for Jev:

| Paired metric | Result |
| --- | ---: |
| Baseline modeled provider tokens | 15,520 |
| Actual provider tokens | 2,158 |
| Modeled provider tokens saved | 13,362 (86.1%) |
| Baseline modeled cost | $0.060000 |
| Actual modeled cost | $0.001301 |
| Modeled cost saved | $0.058699 (97.8%) |
| Baseline success rate | 100% |
| Actual success rate | 100% |

The Jev token counts are observed from live TypeSafe responses. Actor token
counts and all provider rates are explicit benchmark assumptions, not actor
provider telemetry or a billing statement. The deterministic executor reads
fixture files; this validates the local routing and reuse loop, not patch
generation or official SWE-bench resolution.

Reproduce with:

```sh
npm run bench:live-learning -- --instances 2 --repetitions 4 \
  --actor-input-tokens 1800 --actor-output-tokens 140 \
  --actor-input-rate 3 --actor-output-rate 15 \
  --jev-input-rate 0.5 --jev-output-rate 2
```

Source instances: [SWE-bench Lite](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite), using the checked-in compact summaries and current `FAIL_TO_PASS` values.
