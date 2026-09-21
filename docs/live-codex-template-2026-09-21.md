# Live Codex action-template benchmark — 2026-09-21

This bounded pilot used the installed Codex CLI as the frontier actor for three
lookup tasks. The JBrancher arm learned from two verified teaching episodes and
replayed the third unseen query locally through a parameterized action template.

This is a real frontier-actor usage measurement with a deterministic lookup
executor. It is not an official SWE-bench patch-resolution result, and the
actor-only arm is independently sampled, so its accuracy is reported rather
than treated as a perfect oracle.

## Result

| Metric | Actor-only baseline | JBrancher learned arm |
| --- | ---: | ---: |
| Query values | 3 | 3 |
| Codex actor calls | 3 | 2 |
| Actor-call reduction | — | 33.3% |
| Provider input tokens | 47,541 | 31,694 |
| Provider output tokens | 171 | 95 |
| Provider tokens saved | — | 15,923 |
| Task success rate | 0/3 in this sample | 3/3 |
| Learned-route coverage after warm-up | — | 100% |

The two teaching actions were verified by the harness. The third `payments`
request was served by:

```text
lookup {{jbrancher.slot.key-query}} in docs
```

and completed locally in 4.7 ms in the observed run.

The actor-only accuracy result is not a general Codex capability claim: the
frontier output is stochastic, and this pilot is too small to estimate model
quality. The useful result is that once two correct verified examples exist,
JBrancher can avoid another frontier call and preserve the correct typed action.

## Reproduction

```sh
npm run bench:live-codex-template -- --values 3 --assert
```

The benchmark uses the existing local Codex login, does not print credentials,
and removes its temporary learning directory after the run. It is intentionally
not part of CI because it requires a configured Codex CLI and consumes provider
quota.
