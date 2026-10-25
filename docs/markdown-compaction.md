# Guarded Markdown compaction and CI verification

`jbrancher compact` creates a smaller candidate skill/Markdown tree or verifies a
tree rewritten by another tool. It is useful before publishing a skill catalog,
or when upgrading Markdown collateral for a selected model. The existing agent
router remains independent.

The local candidate generator shortens a small set of verbose prose phrases and
adjacent repeated explanatory sentences. It does not use a generative model,
execute Markdown instructions, overwrite its source, or promise a fixed reduction.
Savings are counted with `js-tiktoken`, using `cl100k_base` by default; select
`--encoding o200k_base` when appropriate for the target consumer. An embedding
model screens semantic similarity **after** candidate generation; embeddings do
not generate the shorter text.

## Create a candidate

```sh
npm install github:henstarr/JBrancher
# Supply OPENAI_API_KEY through the environment or a local ignored .env file.
npx jbrancher compact \
  --input ./skill-catalog \
  --output ../skill-catalog-candidate \
  --tests ./compaction-tests.json \
  --report ./compaction-report.json \
  --min-similarity 0.98
```

The output must be new. Source and output/candidate directories must be disjoint.
The report must be outside both trees. A generated tree is a review candidate,
including when verification fails; it is never automatically installed or published.

For a provider-free candidate and token-count inspection, use `--offline`. Changed
text then has a **blocked** semantic layer and cannot receive an accepted CI result.
Without a configured test suite the behavioral layer is explicitly **skipped**.
Byte-identical files require no embedding request and are labeled `byte-identical`
in the per-file report, separately from `embeddingCheckedFiles` in the summary.

## The three verification layers

1. **Structural preservation.** The file set, file permissions, and every non-Markdown
   file must match. Scripts and supporting files are preserved byte-for-byte. Within
   Markdown, protected snapshots retain YAML/TOML frontmatter, fenced blocks (backticks,
   tildes, and unclosed fences), indented code, inline-code/link/path paragraphs,
   headings, recognized directives/constraint paragraphs, HTML comments, and sections
   under safety/permissions/requirements headings (ATX and Setext). Ambiguous HTML
   preserves the remainder of its document. This is conservative recognized-content
   protection, **not a universal parser or proof that every possible guardrail was found**.
2. **Semantic screening.** Changed, structurally valid documents are checked with
   OpenAI `text-embedding-3-small` by default, configurable with `--embedding-model`.
   Token-weighted mean embeddings of chunks no larger than 2,000 `cl100k_base` tokens
   are compared by cosine similarity. The default threshold is 0.98. Missing keys,
   failed requests, malformed vectors, and provider timeouts block verification.
   Similarity is a heuristic, particularly for long documents; it does not establish
   behavioral equivalence, factual correctness, or instruction adherence.
3. **Behavioral regression checks.** Explicitly configured commands run against
   fresh baseline and candidate copies. Each command has its own pair of copies.
   Previously passing tests must remain passing; missing/skipped previous passes
   and newly failing test IDs fail the gate. Tooling errors, timeouts, oversized
   output, malformed results, and unaccepted baseline failures block verification.

The file walker ignores `.git`, `node_modules`, `.jbrancher`, `results`, `coverage`,
and private `.env` files. `.env.example` is retained. Symlinks and non-regular files
are rejected. Limits are 10,000 files, 256 MiB total, and 2 MiB per Markdown file.
Only `.md` and `.markdown` are prose candidates; other files must stay identical.

**Data boundary:** live semantic verification transmits the complete original and
candidate Markdown, including protected code and guardrails, to OpenAI's embeddings
API. It uses batches of at most 16 chunks, a 30-second request timeout, and no retries.
Provider error bodies and raw document text are excluded from reports. Reports
include relative paths, hashes, token counts, gate statuses, and named test outcomes.
Use only documents authorized for that API. `--offline` makes no embedding requests.

## Bring your own tests

Configuration commands are trusted executable argument arrays; no shell is used.
No commands are extracted from Markdown. For example, if `scripts/verify-skill.mjs`
exists inside the catalog and tests the local copy:

```json
{
  "commands": [
    {
      "name": "skill-behavior",
      "command": ["node", "scripts/verify-skill.mjs"],
      "format": "json",
      "timeoutMs": 60000
    }
  ]
}
```

Each JSON-format command writes exactly one JSON object to stdout:

```json
{"tests":[{"id":"approval-before-deployment","status":"passed"},{"id":"correct-tool-selection","status":"passed"}]}
```

Valid statuses are `passed`, `failed`, and `skipped`; IDs must be unique and stable
between baseline and candidate. Exit zero exactly when there are no failed test
rows. Commands may log to stderr, but command output is bounded to 1 MiB and is
not retained in the report. `format: "exit-code"` is also supported: the command
name becomes one coarse test ID, and its baseline must pass.

Known baseline failures require JSON per-test results **and** explicit
`"allowBaselineFailures": true` at the top level of the configuration. They remain
listed in the report. Matching nonzero process exits alone do not establish zero
new regressions. Each command still needs at least one passing baseline test.
An inconclusive run reports `newRegressions: null`, not zero.

Commands run in temporary copies with `JBRANCHER_MARKDOWN_ROOT` set to that copy
and optional `JBRANCHER_TARGET_MODEL` set from the CLI. Source `node_modules`, when
present, is linked into both copies for normal dependency resolution. **These are
not sandboxes:** trusted test commands inherit the environment, can use the network,
and can access files outside their working directory. An executable provided by the
caller can still behave maliciously. Only run reviewed test configurations.

## Marketplace and model-upgrade CI gates

For collateral rewritten by another tool, keep original and upgraded trees:

```sh
npx jbrancher compact \
  --input ./original-skills \
  --candidate ./upgraded-skills \
  --tests ./compaction-tests.json \
  --target-model "$TARGET_MODEL_ID" \
  --min-reduction 0.10 \
  --report ./compaction-report.json
```

Exit codes: **0** means all three layers and the optional aggregate token-reduction
budget passed; **1** means a preservation, similarity, regression, or budget check
failed; **2** means incomplete verification or configuration/tooling failure. These
codes can directly gate a CI job. The JSON report distinguishes each cause.

`--target-model` records the caller-selected generation model and passes it to
the BYO harness. It does **not** discover the latest model, retune prompts, call
that model by itself, or certify a migration. The caller's behavioral tests must
exercise the selected model, its tools, and important outcomes. Use representative
golden tasks and assertions for workflows, permissions, and preserved scripts.

## JavaScript interfaces

```js
import { compactMarkdown, createOpenAIEmbeddingVerifier, verifyMarkdown } from 'jbrancher/markdown';
import { verifyMarkdownTree } from 'jbrancher/markdown-gate';

const candidate = compactMarkdown(original);
const screened = await verifyMarkdown({ original, candidate,
  embed: createOpenAIEmbeddingVerifier(), minimumSimilarity: 0.98 });
// screened contains only the structural/semantic layers; it is not a three-layer CI acceptance.

const report = await verifyMarkdownTree({ input: 'original-skills', candidate: 'upgraded-skills',
  embed: createOpenAIEmbeddingVerifier(), tests: reviewedTestConfig });
if (!report.accepted) process.exitCode = report.status === 'failed' ? 1 : 2;
```

## Evidence boundaries

The unit/integration tests use mocked embedding responses to validate request
handling and fail-closed behavior without provider calls. They do not measure live
semantic quality. A successful gate establishes no new regressions **in the named
test workload**, not universal behavior preservation. This change does not add or
reproduce a 745-file benchmark or a 40% corpus-wide savings claim. Publish a real
corpus/model/test report before attributing those figures to this implementation.
