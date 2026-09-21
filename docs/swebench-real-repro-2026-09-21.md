# Real SWE-bench instance reproduction — 2026-09-21

This run validates one real SWE-bench Lite instance outside the official Docker
grader. It is a provenance and environment check; it is not an official
resolution score and it does not claim that JBrancher generated the patch.

| Field | Value |
| --- | --- |
| Dataset | `princeton-nlp/SWE-bench_Lite` |
| Instance | `sqlfluff__sqlfluff-1625` |
| Repository | `sqlfluff/sqlfluff` |
| Base commit | `14e1a23a3166b9a645a16de96f694c77a5d4abb7` |
| FAIL_TO_PASS | `test/cli/commands_test.py::test__cli__command_directed` |
| Python | 3.12.4 |
| Package under test | sqlfluff 0.7.0a8 editable checkout |

## Observed result

The repository was cloned at the recorded base commit, installed in an
isolated virtual environment, and the dataset's `test_patch` was applied. The
target test then failed with the reported L031 output mismatch: the base code
emitted “Avoid using aliases in join condition” where the regression expected
the existing “Avoid aliases in from clauses and join conditions” wording.

After applying the dataset's published gold `patch` in the disposable checkout,
the same target test passed:

```text
1 passed, 1 warning
```

The warning was the historical package's `pkg_resources` deprecation warning;
it did not affect the test result. The isolated environment required
`setuptools<81` and `click<8.1` because this historical repository predates the
current dependency APIs.

## JBrancher replay run

The real test-boundary benchmark was then run with four disposable git
worktrees and a persistent local learning directory:

```text
baseline frontier calls: 8
actual frontier calls:   4
learned replays:         2
verified active routes:  1
pytest passes:            4/4
frontier-call reduction: 50%
```

The first two episodes applied the published fix and ran the official test via
the actor path. After two verified observations, the final two episodes used
the dynamic `authorize` path to replay the same two-step workflow. The test
still passed in every fresh worktree. A persistent run stores raw traces,
curated dataset rows, and active routes under the supplied `--learning-dir`.
The deterministic benchmark actor reports provider usage as unmeasured; a live
frontier actor must be substituted for token and cost measurements.

## Why this matters for JBrancher

This confirms that the checked-in SWE-bench-derived instance refers to a real
reproducible bug and that the official `FAIL_TO_PASS` boundary can be exercised
on this machine. The replay benchmark now runs the actor and JBrancher-wrapped
loops against disposable worktrees using the same test command as the
postcondition. Its route-learning result reports provider usage separately from
test success.

The official SWE-bench evaluator was not run because this Windows host has no
Docker daemon, WSL, or Modal client. The official evaluator remains the source
of truth for patch-resolution rates.
