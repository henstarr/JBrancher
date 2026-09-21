# Open-world route discovery

JBrancher does not require every workflow to be registered in advance. An
unknown request is still handled by the harness's frontier actor. The actor is
the teacher; JBrancher observes the completed episode and builds a private,
local dataset that can become a reusable route later.

```text
unknown request → frontier actor → redacted episode → candidate → verification
                                                     ↓
                                             local fast path
```

## Use the adapter in any harness

The `jbrancher/discovery` export provides a small lifecycle boundary for
harnesses that do not use the Pi extension:

```js
import { createOpenWorldLearner } from 'jbrancher/discovery';

const learner = createOpenWorldLearner({
  directory: '.jbrancher',
  source: 'my-harness'
});

const episode = learner.begin({
  task,
  routeResolution: 'unmatched',
  metadata: { initialState: safeState }
});

try {
  // The harness sends the unknown task to its existing frontier actor.
  // Forward its real tool lifecycle into this episode.
  episode.recordToolCall({ toolCallId, toolName, input });
  episode.recordToolResult({ toolCallId, isError, content });

  await episode.finish({
    outcome: harness.isComplete() ? 'success' : 'unknown'
  });
} catch (error) {
  await episode.finish({ outcome: 'failure', metadata: { error: error.message } });
  throw error;
}
```

If the harness already has a completed trajectory, it can use the one-call
adapter instead:

```js
await learner.recordEpisode({
  task,
  routeResolution: 'unmatched',
  metadata: { candidateCount: 0 },
  toolCalls: completedFrontierToolCalls,
  outcome: harness.isComplete() ? 'success' : 'unknown'
});
```

`recordEpisode` performs the same redaction, durable append, dataset export,
candidate mining, and optional promotion as the lower-level lifecycle API.

The append-only trace file intentionally keeps every observation because
repetition is evidence for promotion. For a portable training or evaluation
export, curate repeated trajectories instead:

```sh
npx jbrancher dataset --dir .jbrancher --dedupe
```

Curated rows keep one representative per stable task/action fingerprint and
add aggregate evidence counts for outcomes, route resolutions, and sources.
This prevents a frequently repeated local workflow from overweighting a shared
dataset while preserving the original traces for future route mining. The
curated export is written to `.jbrancher/dataset-curated.jsonl`; the live
append-only `.jbrancher/dataset.jsonl` remains safe for new episodes. The
curated export is still local and redacted; sharing it with a central dataset
is an explicit, opt-in step outside JBrancher's runtime.

To combine exports from multiple local workspaces, copy the redacted JSONL files
to one machine and merge them explicitly:

```sh
npx jbrancher dataset \
  --input machine-a/.jbrancher/dataset.jsonl \
  --input machine-b/.jbrancher/dataset.jsonl \
  --dedupe \
  --output shared-dataset.jsonl
```

The command validates each row, redacts again at the merge boundary, collapses
duplicate fingerprints, and preserves aggregate evidence. It writes only the
requested dataset file: imported examples do not mutate local routes or become
executable without a separate, reviewed learning step. This gives teams a
portable dataset-building path without requiring a hosted database.

To explicitly review and use a shared export on another machine, import it into
that machine's local evidence store:

```sh
npx jbrancher learn \
  --dir .jbrancher \
  --import shared-dataset.jsonl \
  --approve-import
```

Import recomputes every fingerprint from the task and actions, re-redacts the
row, caps unusually large aggregate counts, and keeps imported verification
claims out of the trusted metadata. The normal promotion policy then applies:
read-only routes may activate after the configured evidence threshold, while
writes and other side effects remain inactive unless newly verified by the
target harness. Imports are idempotent: stable observation IDs are skipped on a
repeat import, so restarting a worker or rerunning a reviewed export does not
artificially inflate route evidence.

The adapter writes to `.jbrancher/` locally and supports multiple concurrent
episodes. Inputs, outputs, per-step state, and candidate metadata are redacted
by the learning store. Generic runtime decisions also retain bounded usage
metadata (such as numeric input/output token counts) inside the step context,
so a local benchmark can measure the cost of the frontier or Jev decision that
created a route. Secret fields remain redacted.
There is no external database requirement.

Preference learning is context-scoped. When the Pi adapter learns that Jev
usually selects a route, it stores a one-way fingerprint of the redacted
`{ cwd, mode }` context rather than the context itself. A preference is replayed
only in the same context; a task that arrives from a different project or mode
returns to the normal Jev/frontier path until it earns its own evidence.

## Promotion policy

The first successful unknown episode becomes a candidate. Repeated successful
read-only episodes can be promoted automatically. Writes, deletes, deployments,
and other side effects remain evidence only unless the harness supplies a
postcondition verifier and explicitly enables verified promotion.

Candidate refresh is cumulative: later traces update observations, examples,
and verification evidence for an existing route without resetting its active
or quarantined status. A quarantined route therefore remains quarantined until
an operator explicitly re-promotes it, even if new traces arrive.

Use `await learner.learn()` after importing or editing traces, and
`await learner.snapshot()` to expose dataset demand, outcome, route-resolution,
candidate, active-route, quarantine, and successful-replay counts in a UI or
benchmark report. The snapshot also includes a compact `replay` summary and
per-route `replayTelemetry`: replay attempts, success rate, failures,
quarantine state, and estimated frontier steps avoided. This lets a local
harness measure whether a promoted shortcut is actually earning reuse rather
than merely accumulating observations. When the harness supplies numeric
decision usage, the snapshot also reports observed input, output, and total
tokens for the recorded frontier/Jev decisions, plus estimated provider tokens
avoided by successful replays. Its `economics` summary subtracts the recorded
teaching/fallback usage from a paired-equivalent baseline: recorded work plus
estimated replay work approximates what the same workload would have cost
without learning. It reports paired-equivalent tokens saved and reduction.
These are local estimates, not billing statements; use a paired harness trial
when evaluator overhead or provider pricing must be isolated.

No Jev request is required to capture an unknown episode. Jev can remain a
bounded evaluator for registered candidates; the frontier actor handles the
open-world portion until the local dataset contains enough verified evidence.

The frontier path and replay path have different trust boundaries. The actor may
choose a new action on an unmatched request, but a learned action is replayed
only when the harness exposes the same action through its current capability
catalog. In a generic integration, make `getCandidates` derive from current
state, permissions, and tool availability rather than from a static list of
registered prompts:

```js
const brancher = createJBrancher({
  getCandidates: ({ state }) => harness.authorizedActions(state),
  actor: context => frontier.nextAction(context),
  execute: (action, context) => harness.execute(action, context),
  learningStore: learner.store,
  learningSource: 'my-harness',
  learningOutcome: context => harness.isComplete(context.state, context.events)
});
```

If `authorizedActions` returns an empty array, the actor still handles the
request and the episode is recorded as `routeResolution: "unmatched"`. When a
later state exposes the action as legal, the same local evidence can become a
fast path without adding a hand-written route.

## Generalizing safe argument slots

The generic runtime also mines a conservative `action-template` route for a
single-step frontier action when the task visibly contains one of the action's
string arguments. Two successful examples such as:

```text
lookup auth in docs    → lookup(query="auth", scope="docs")
lookup billing in docs → lookup(query="billing", scope="docs")
```

can produce a stored template equivalent to:

```text
lookup {{jbrancher.slot.key-query}} in docs
```

The slot is extracted from a later task and filled into the action only after
the harness exposes the resulting action in its current authorized candidate
set. Constant arguments remain fixed. The learner only creates this template
after seeing different values, and it stores the placeholder rather than the
observed argument value. This is a generic-harness feature; Pi's built-in
executor continues to use its stricter read and inspection route adapters.

Unknown or side-effecting tools are still classified conservatively. To promote
one, construct the runtime with `learningPromotionMode: 'verified'` and provide
`learningOutcome`; the harness must confirm the postcondition for every
teaching episode. A template is not permission to execute a new tool.

The same slot mechanism supports multi-step workflows. A successful trajectory
with two or more actions can become an `action-template-workflow` route when
the task-visible argument changes across repeated examples. At replay time,
JBrancher fills the argument in every step and asks the harness for the current
authorized candidate set before each execution. This keeps workflow reuse
compatible with capability drift; a missing or changed step causes the runtime
to abandon the shortcut and return to the frontier actor.

## Measure the cold-to-warm loop

Run the local discovery benchmark:

```sh
npm run bench:discovery -- --assert
```

Run the unseen-argument template benchmark:

```sh
npm run bench:template-learning -- --assert
```

Run the multi-step template benchmark:

```sh
npm run bench:template-workflow-learning -- --assert
```

It simulates three unregistered read requests across repeated frontier turns,
then measures how many later turns use the learned local route. The provider
token numbers are explicitly synthetic assumptions; use the live Codex/Pi
benchmarks for real provider usage.
