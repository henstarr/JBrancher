# Live Jev route-learning benchmark — 2026-09-21

This bounded run used the real TypeSafe endpoint with `jev-latest` on three
SWE-bench Lite-derived instances. It measured route learning and provider
usage, not patch generation or official SWE-bench grading.

| Metric | Result |
| --- | ---: |
| Instances | 3 |
| Repetitions per instance | 4 |
| Baseline modeled actor calls | 12 |
| Actual actor calls | 0 |
| Jev warm-up calls | 6 |
| Jev calls avoided by learned routes | 6 (50%) |
| Baseline modeled actor tokens | 23,280 |
| Observed Jev input tokens | 2,984 |
| Observed Jev output tokens | 222 |
| Actual provider tokens | 3,206 |
| Modeled provider tokens saved | 20,074 (86.3%) |
| Task success preserved | 100% |
| Learned route coverage | 100% |
| Average Jev decision latency | 236 ms |
| Average learned replay latency | 3.8 ms |

The actor baseline assumes 1,800 input tokens and 140 output tokens per actor
call, supplied explicitly to the benchmark. Jev usage is observed directly;
the actor was not actually launched in this fixture because the single legal
candidate could be routed without an actor call. Therefore the token-saving
comparison is a paired modeled baseline, not a provider invoice or a claim
about official SWE-bench patch resolution.

Reproduce with:

```powershell
npm run bench:live-learning -- --instances 3 --repetitions 4 `
  --actor-input-tokens 1800 --actor-output-tokens 140
```

The API key is loaded from the ignored `.env` or the process environment and
is never written to the report.
