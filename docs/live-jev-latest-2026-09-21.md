# Live `jev-latest` compatibility benchmark — 2026-09-21

This bounded run used the TypeSafe stable model alias through the real HTTP
endpoint. The request selected `jev-latest`; the service reported the concrete
revision `jev-1.13.0` that served the request. JBrancher accepts that alias
resolution while continuing to reject unrelated response model IDs.

| Metric | Result |
| --- | ---: |
| Requested model | `jev-latest` |
| Served model revision | `jev-1.13.0` |
| SWE-bench-derived instances | 1 |
| Repetitions | 4 |
| Jev calls | 2 |
| Jev calls avoided | 2 (50%) |
| Observed Jev input tokens | 1,022 |
| Observed Jev output tokens | 74 |
| Learned route coverage | 100% |
| Task success preserved | 100% |

The first two decisions paid Jev evaluation cost; the final two were local
learned replays with no Jev request. Actor tokens were not supplied, so this
run reports observed Jev usage and does not claim a dollar-cost reduction.

Reproduce with:

```powershell
$env:JBRANCHER_MODEL = 'jev-latest'
npm run bench:live-learning -- --instances 1 --repetitions 4
```

The API key is loaded from the ignored `.env` or the process environment and is
never written to the report.
