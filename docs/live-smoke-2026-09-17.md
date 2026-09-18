# Live Jev smoke test — 2026-09-17

This is a transport and integration smoke test, not a product efficacy benchmark. It used three synthetic, non-sensitive states and the pinned `jev-1.13.0` model. The API key was loaded locally from an ignored environment file and is not present in this report.

All three requests succeeded. JBrancher retained the Jev scores and used the actor fallback in every case because the current `0.70` minimum score and `0.15` margin were not met.

| Case | Jev scores | Runtime source | Input tokens | Output tokens |
| --- | --- | --- | ---: | ---: |
| Written artifact needs verification | 0.77, 0.77 | Actor fallback | 476 | 40 |
| Verified artifact can finish | 0.12, 0.13 | Actor fallback | 476 | 40 |
| Failed verification needs repair | 0.46, 0.47, 0.20 | Actor fallback | 573 | 58 |

The result validates the live HTTP adapter, bounded request handling, usage capture, and fallback behavior. It does not show that Jev improves cost, latency, or task success. The next evaluation should compare stronger questions and candidate descriptions against deterministic routing over a held-out task set before changing thresholds.
