# Live Codex learning benchmark — 2026-09-21

This run used the installed Codex CLI as the frontier actor across three
SWE-bench Lite-derived investigation prompts. Each prompt was run four times:
the first two repetitions paid the frontier decision cost to build local
evidence, and the last two repetitions used the learned, authorized read route.

| Metric | Actor-only baseline | JBrancher |
| --- | ---: | ---: |
| Codex actor calls | 12 | 6 |
| Actor calls avoided | — | 6 (50%) |
| Input tokens | 191,280 | 95,640 |
| Output tokens | 131 | 54 |
| Total provider tokens | 191,411 | 95,694 |
| Provider tokens saved | — | 95,717 (50.0%) |
| Task success preserved | 100% | 100% |
| Learned route coverage | — | 100% |

The learned turns completed locally in approximately 4–5 ms in this run and
made no Codex request. The first two turns for each task still used Codex,
which is the intended cold-start behavior: the frontier actor supplies the
initial example and JBrancher learns from it.

Reproduce with:

```sh
npm run bench:live-codex -- --instances 3 --repetitions 4
```

This is a live routing and local-replay measurement using real Codex usage,
deterministic read execution, and SWE-bench-derived prompts. It is not an
official SWE-bench patch-resolution score. Provider cost is intentionally not
reported without explicit current input/output rates.
