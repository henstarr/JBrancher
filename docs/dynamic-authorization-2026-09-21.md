# Dynamic authorization benchmark — 2026-09-21

Command:

```sh
npm run bench:authorization -- --assert
```

This benchmark uses the 14 checked-in SWE-bench Lite-derived instance
identities, with four repeated attempts per instance. The learning arm omits
`getCandidates` entirely and uses only the harness `authorize` callback. The
frontier action is a synthetic `inspect(instanceId)` action with a deterministic
success oracle; the benchmark therefore measures the local learning boundary,
not autonomous patch generation or the official SWE-bench score.

Observed result:

| Measure | Result |
| --- | ---: |
| Baseline frontier calls | 56 |
| Learning-arm frontier calls | 4 |
| Learned local replays | 52 |
| Frontier-call reduction | 92.9% |
| Modeled provider tokens | 94,080 → 6,720 |
| Modeled tokens saved | 87,360 |
| Active generalized routes | 2 |
| Route coverage | 100% |
| Authorization revocation fallbacks | 1 |

The two active routes are an intentional result: the learner generalized the
`instanceId` argument across the SWE-bench-derived tasks instead of storing one
exact route per instance. The revoked final attempt was denied by the harness
and correctly returned to the frontier actor.

These token figures use explicit synthetic actor usage (`1,500` input and
`180` output tokens per frontier call). They are useful for comparing the
control and learning arms, not as provider billing telemetry. The next step is
to run the same benchmark around a real Pi, Codex, Claude, or Harbor event
stream while retaining the benchmark's unchanged task verifier.
