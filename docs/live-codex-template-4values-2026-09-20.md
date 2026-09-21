# Live Codex argument-template benchmark — four values

This run used the installed Codex CLI as the frontier actor for four lookup
tasks. JBrancher learned from two verified teaching episodes and served two
unseen query values through a local parameterized action template.

## Result

| Metric | Actor-only baseline | JBrancher learned arm |
|---|---:|---:|
| Query values | 4 | 4 |
| Codex actor calls | 4 | 2 |
| Actor-call reduction | — | 50% |
| Provider input tokens | 63,396 | 31,698 |
| Provider output tokens | 357 | 96 |
| Provider tokens saved | — | 31,959 |
| Task success rate | 75% | 100% |
| Verified teaching episodes | — | 2 |
| Novel frontier calls | — | 0 |
| Learned-route coverage on novel values | — | 100% |

The learned route was:

```text
lookup {{jbrancher.slot.key-query}} in docs
```

The two teaching episodes were postcondition-verified before promotion. The
`payments` and `reliability` requests then executed locally in approximately
5 ms each, with no Codex actor call.

The benchmark also treats a syntactically valid but semantically wrong frontier
action as a failed teaching postcondition. It retries teaching up to three
times and never promotes the bad observation. This keeps model mistakes in the
dataset as negative evidence instead of hiding them with an assertion failure.

This is a real Codex usage measurement with a deterministic lookup executor,
not an official SWE-bench patch-resolution result. The actor-only arm is
independently sampled and is reported as observed behavior, not as a model
quality estimate.

## Reproduction

```sh
npm run bench:live-codex-template -- --values 4 --assert
```

The benchmark uses the existing local Codex login, does not print credentials,
and removes its temporary learning directory after the run. It is intentionally
not part of CI because it consumes provider quota.
