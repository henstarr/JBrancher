# Live Codex authorization-only benchmark — 2026-09-21

Command:

```sh
npm run bench:live-codex-template -- --values 4 --authorization-only --assert
```

This run used the installed `codex.exe` as the frontier actor. The JBrancher
arm omitted `getCandidates` entirely and authorized learned actions through a
dynamic callback. The executor and verifier were deterministic lookup fixtures;
this is not an official SWE-bench patch-resolution score.

Observed result from the current paired run. Both arms used the same bounded
correctness verifier; baseline retries, when needed, are included in its call
and token totals.

| Measure | Result |
| --- | ---: |
| Baseline Codex calls | 4 |
| Learning-arm Codex calls | 2 |
| Codex calls avoided | 2 (50%) |
| Baseline observed tokens | 63,639 |
| Learning-arm observed tokens | 31,818 |
| Observed tokens saved | 31,821 |
| Verified teaching episodes | 2 |
| Novel frontier calls | 0 |
| Authorization checks | 2 |
| Learned route | 1 active verified action template |
| Novel replay coverage | 100% |

The learned route replayed `payments` and `reliability` locally in roughly
4–5 ms each. Both arms completed the deterministic verifier at 4/4 in this
run. Because the frontier actor is stochastic and this is a four-value sample,
the quality result is directional evidence only; the useful result is the
paired token/call reduction and zero frontier calls for unseen values.
