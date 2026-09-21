# Live Codex authorization-only benchmark — 2026-09-21

Command:

```sh
npm run bench:live-codex-template -- --values 4 --authorization-only --assert
```

This run used the installed `codex.exe` as the frontier actor. The JBrancher
arm omitted `getCandidates` entirely and authorized learned actions through a
dynamic callback. The executor and verifier were deterministic lookup fixtures;
this is not an official SWE-bench patch-resolution score.

Observed result:

| Measure | Result |
| --- | ---: |
| Baseline Codex calls | 4 |
| Learning-arm Codex calls | 2 |
| Codex calls avoided | 2 (50%) |
| Baseline observed tokens | 63,754 |
| Learning-arm observed tokens | 31,912 |
| Observed tokens saved | 31,842 |
| Verified teaching episodes | 2 |
| Novel frontier calls | 0 |
| Authorization checks | 2 |
| Learned route | 1 active verified action template |
| Novel replay coverage | 100% |

The learned route replayed `payments` and `reliability` locally in roughly
4–5 ms each. The actor-only baseline happened to select the expected action on
2/4 calls, while the learning arm completed its deterministic verifier at 4/4.
Because the frontier actor is stochastic and this is a four-value sample, the
quality difference is directional evidence only; the reliable result here is
the measured token/call reduction and zero frontier calls for unseen values.
