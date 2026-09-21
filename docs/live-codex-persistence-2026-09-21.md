# Live Codex persistence benchmark — 2026-09-21

This benchmark ran the teaching and replay phases in separate Node processes
against the same local learning directory. The action catalog was omitted; the
harness used only the dynamic authorization callback.

## Teaching process

```sh
npm run bench:live-codex-template -- \
  --values 4 --authorization-only --phase teach \
  --learning-dir .jbrancher/live-codex-template --assert
```

| Measure | Result |
| --- | ---: |
| Codex actor calls | 2 |
| Observed input tokens | 31,698 |
| Observed output tokens | 93 |
| Verified teaching episodes | 2 |
| Active verified template routes | 1 |
| Route | `lookup {{jbrancher.slot.key-query}} in docs` |

## Restarted replay process

```sh
npm run bench:live-codex-template -- \
  --values 4 --authorization-only --phase replay \
  --learning-dir .jbrancher/live-codex-template --assert
```

| Measure | Result |
| --- | ---: |
| Codex actor calls | 0 |
| Novel values replayed | 2/2 |
| Novel frontier calls | 0 |
| Authorization checks | 2 |
| Replay latency | 8.7 ms and 4.9 ms |
| Task success | 2/2 |

The teaching process paid the frontier cost once and persisted the route in
local `traces.jsonl`, `dataset.jsonl`, and `routes.json`. A new process then
replayed both unseen values locally. This is a live token/call measurement of
restart persistence, not an official SWE-bench patch-resolution score; the
executor and verifier are deterministic lookup fixtures.
