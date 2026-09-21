# Multi-step HTTP workflow replay benchmark — 2026-09-21

This local benchmark used 14 SWE-bench Lite-derived tasks across seven
repositories. Each task consisted of a two-step read-only investigation. The
first two repetitions were open-world frontier trajectories; later repetitions
used the local `/v1/workflow` endpoint with per-step authorization catalogs.

| Metric | Frontier baseline | JBrancher |
| --- | ---: | ---: |
| Actor steps | 112 | 56 |
| Synthetic provider tokens | 217,280 | 108,640 |
| Learned workflow replays | — | 28 |
| Workflow route coverage | — | 100% |
| Task success | — | 100% |

The run recorded 56 local episodes, promoted 14 workflows, and replayed 28
workflows without actor steps. The endpoint abstained during every open-world
warm-up and returned a learned workflow only when both actions were present in
the host-supplied capability catalog.

This is a routing/replay efficiency benchmark using deterministic read
execution, not an official SWE-bench patch-resolution score.

Reproduce with:

```sh
npm run bench:workflow -- --assert
```
