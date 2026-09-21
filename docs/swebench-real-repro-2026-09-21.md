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

## Why this matters for JBrancher

This confirms that the checked-in SWE-bench-derived instance refers to a real
reproducible bug and that the official `FAIL_TO_PASS` boundary can be exercised
on this machine. The next agent benchmark should run an actor-only and a
JBrancher-wrapped action loop against this same disposable checkout, using the
same test command as the postcondition. The route-learning result must report
provider usage separately from test success.

The official SWE-bench evaluator was not run because this Windows host has no
Docker daemon, WSL, or Modal client. The official evaluator remains the source
of truth for patch-resolution rates.
