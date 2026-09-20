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

The adapter writes to `.jbrancher/` locally and supports multiple concurrent
episodes. Inputs, outputs, and metadata are redacted by the learning store.
There is no external database requirement.

## Promotion policy

The first successful unknown episode becomes a candidate. Repeated successful
read-only episodes can be promoted automatically. Writes, deletes, deployments,
and other side effects remain evidence only unless the harness supplies a
postcondition verifier and explicitly enables verified promotion.

Use `await learner.learn()` after importing or editing traces, and
`await learner.snapshot()` to expose dataset demand, outcome, route-resolution,
candidate, active-route, and quarantine counts in a UI or benchmark report.

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

## Measure the cold-to-warm loop

Run the local discovery benchmark:

```sh
npm run bench:discovery -- --assert
```

It simulates three unregistered read requests across repeated frontier turns,
then measures how many later turns use the learned local route. The provider
token numbers are explicitly synthetic assumptions; use the live Codex/Pi
benchmarks for real provider usage.
