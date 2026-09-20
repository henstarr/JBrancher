# Pi integration

JBrancher ships as a Pi package. The integration is an input-level decision
boundary:

```text
user prompt → explicit deterministic route → direct result
                       │
                       └─ no match, ambiguity, Jev failure, or route failure
                                      ↓
                             Pi frontier model
```

This means Pi remains the general-purpose agent. JBrancher is responsible for
small, repeatable actions where the project owner has supplied the matcher and
executor. It does not replace Pi's model, permissions, tools, sandbox, or
completion checks.

## Install

Install from the GitHub repository:

```sh
pi install git:github.com/henstarr/JBrancher
```

For a one-session trial:

```sh
pi -e git:github.com/henstarr/JBrancher
```

Pi packages execute extension code with the permissions of the Pi process.
Review the package and any project route configuration before installing it.

## Project routes

Create `jbrancher.config.js` in the project directory. The extension loads it
on session start and can reload it with `/jbrancher reload`.

```js
export default {
  includeBuiltins: true,
  minimumProbability: 0.7,
  minimumMargin: 0.15,
  routes: [
    {
      id: 'lint',
      match: ({ task }) => /^run lint\??$/i.test(task.trim()),
      run: async ({ exec }) => {
        const result = await exec('npm', ['run', 'lint']);
        if (result.code !== 0) throw new Error(result.stderr || 'lint failed');
        return result.stdout || 'Lint passed.';
      }
    }
  ]
};
```

A route has three required properties:

- `id`: stable identifier shown in the Pi transcript and status command.
- `match({ task, state, history, signal })`: a synchronous or async predicate.
- `run({ task, state, history, signal, exec })`: the deterministic executor.

`exec` delegates to Pi's process runner. Keep routes explicit and narrow. Do
not turn arbitrary user text into a shell command. A route may use `state.cwd`
and may throw when its postcondition is not met; JBrancher then returns control
to Pi rather than fabricating a successful result.

## Jev and fallback behavior

Jev is only called when two or more registered routes match the same prompt. It
receives the task and the bounded candidate route IDs, never an open-ended tool
space. A route is handled only when the winning score meets
`minimumProbability` and clears `minimumMargin` over the runner-up.

Set the key in the environment before starting Pi, or put it in the project's
ignored `.env` file. The extension loads a local `.env` without overwriting
values already present in the process environment:

```sh
TYPESAFE_API_KEY=your-key pi
```

Optional settings:

```sh
JBRANCHER_PI_MODE=active
JBRANCHER_PI_JEV_MODEL=jev-1.13.0
JBRANCHER_PI_JEV_TIMEOUT_MS=3000
JBRANCHER_PI_MIN_PROBABILITY=0.7
JBRANCHER_PI_MIN_MARGIN=0.15
```

If no key is present, a single matching route still executes deterministically;
multiple matches fall back to Pi. If Jev is unavailable, malformed, or
uncertain, Pi receives the original prompt unchanged. This preserves the
frontier model as the recovery path for open-ended and non-deterministic work.

## Built-in routes

The package includes conservative read-only routes for:

- `git status`
- the current Git branch
- the current directory
- the Node.js version

Set `includeBuiltins: false` in `jbrancher.config.js` to disable them. Project
routes are additive and are loaded after built-ins.

## Local learning mode

Enable the learner with either:

```sh
JBRANCHER_PI_MODE=learning pi -e .
```

or:

```sh
JBRANCHER_PI_LEARNING=1 pi -e .
```

In learning mode, prompts that fall through to Pi are observed through Pi's
tool lifecycle. JBrancher writes redacted JSONL traces, a route cache, and a
portable episode dataset to `.jbrancher/` in the current project. No remote
database is used.

The local loop is deliberately conservative:

1. Pi handles an unknown prompt normally.
2. JBrancher records the prompt, ordered tools, bounded arguments, outputs, and
   tool outcomes. This is the dataset-building path for routes that are not
   registered ahead of time.
3. `/jbrancher dataset` regenerates `.jbrancher/dataset.jsonl`; examples are
redacted, labeled with outcome and safety, and assigned stable train,
validation, or test splits. Dataset rows also retain redacted harness context
metadata, such as the initial state supplied by a generic runtime, so future
offline mining can distinguish the same task under different states.
4. `/jbrancher candidates` mines successful workflows. The first successful
   unknown episode becomes a reviewable candidate immediately; repeated
   evidence is still required before automatic promotion.
5. Repeated read-only candidates are promoted automatically; `/jbrancher promote <id>`
   is available for explicit manual promotion.
6. The active route can answer the same prompt without a frontier turn.

If an active learned route later fails, it is marked `quarantined`, removed from
the active route set, and the prompt falls back to Pi. This prevents a stale
route from becoming a repeated failure loop. Re-promoting a quarantined route
requires an explicit `force` call through the learning API after the underlying
problem has been reviewed. The frontier recovery for that same prompt is
recorded as a new local episode, so route failures add evidence instead of
silently disappearing.

Learned routes currently support exact normalized prompts and conservative
token-similarity matches for one or more repeated `read` actions, plus a
bounded allowlist of read-only inspection commands such as `rg`, `grep`,
`cat`, `head`, `tail`, and `sed`. Shell control operators, traversal,
absolute paths, in-place flags, and common secret files are rejected.
Similarity generalization requires
repeated evidence for each observed phrasing and defaults to a similarity score
of 0.8; tune it with `minimumSimilarity` when configuring a project. Other
actions remain in the dataset but are candidate or fallback-only; this
prevents learning from silently replaying writes, deletes, deployments, or
arbitrary shell commands. The trace store is local and ignored by Git, so users
can delete `.jbrancher/` to reset learning. Set
`autoPromoteReadOnly: false` in `jbrancher.config.js` if you want every
candidate to require manual promotion.

For workflows where successful tool calls are not enough to prove completion,
provide the same postcondition used by the project harness:

```js
export default {
  candidateMinimumObservations: 1,
  minimumObservations: 2,
  learningOutcome: ({ toolCalls }) =>
    toolCalls.length > 0 && toolCalls.every(call => call.ok === true)
};
```

The hook may return `true`/`false` or `success`/`unknown`/`failure`. Only a
`success` result is eligible for automatic promotion; the trace is still
retained locally when the hook rejects it.

`candidateMinimumObservations` defaults to `1`, which makes the first
successful unknown episode visible for review. `minimumObservations` defaults
to `2`, which keeps automatic promotion conservative. Increase either value
for a noisier project, or set `autoPromoteReadOnly: false` to make promotion
fully manual.

The generic runtime also supports an explicit
`learningPromotionMode: 'verified'` for harnesses that own a reliable
postcondition verifier. Pi's native extension remains read-only by default;
use project routes for deliberate side effects.

When two successful traces read different explicitly named project files,
JBrancher can also promote a guarded path template. A later request such as
`inspect src/index.js` can read that new relative path without a frontier turn;
the template rejects write/delete language, traversal, absolute paths, and
common secret/key files.

The trace layer is harness-neutral. An adapter for another local harness can
use the same store without importing the Pi extension:

```js
import { createEpisodeRecorder, createLocalLearningStore } from 'jbrancher/learning';

const store = createLocalLearningStore({ directory: '.jbrancher' });
const episode = createEpisodeRecorder({ store, task, source: 'my-harness' });
episode.recordToolCall({ toolCallId, toolName, input });
episode.recordToolResult({ toolCallId, isError, content });
await episode.finish();
```

The adapter only supplies lifecycle events; JBrancher owns redaction, local
dataset append, candidate mining, and promotion policy.

For a harness that uses the generic runtime instead of Pi, pass the same store
as `learningStore` to `createJBrancher`. `step()` records one fallback action;
`run()` records the whole fallback workflow as one episode and can replay a
proven multi-step read-only workflow, automatically refreshing safe local routes:

```js
const brancher = createJBrancher({
  getCandidates: context => harness.allowedNextActions(context),
  actor: context => actor.nextAction(context),
  execute: (action, context) => harness.execute(action, context),
  learningStore: createLocalLearningStore({ directory: '.jbrancher' })
});
```

Generic fallback episodes with no tool call are retained as `unknown` dataset
rows by default. They are useful for measuring demand and later labeling, but
cannot become executable routes until the harness supplies an action. Set
`learningRecordEmptyEpisodes: false` to omit those rows.

Learned actions never bypass `getCandidates`; the harness remains the source
of truth for what is legal in the current state.

Run the local replay benchmark:

```sh
npm run bench:learning
```

The same local store can be mined outside a running Pi session:

```sh
npx jbrancher learn --dir .jbrancher
```

This command needs no API key. It rewrites the redacted dataset, exposes
first-observation candidates, and promotes only safe read-only candidates; use
`--min-observations` and
`--min-similarity` to make promotion more conservative.

It uses three real SWE-bench Lite bug statements and deterministic read traces
to measure warm-up versus reuse. It reports frontier-call and estimated prompt
token savings, but does not claim official SWE-bench patch success because it
does not run the SWE-bench Docker harness.

## Shadow mode and measurement

Use shadow mode to measure deterministic opportunities without changing the
agent's behavior:

```sh
JBRANCHER_PI_MODE=shadow pi
```

The extension reports matches through Pi's UI and leaves every prompt for the
frontier model. Compare shadow and active runs on the same task set using:

- deterministic prompts handled without a frontier turn;
- fallback rate and route failures;
- Jev requests, latency, and usage when ambiguous routes match;
- successful task completion and total frontier input/output tokens.

The package-level router is also available to other adapters:

```js
import { createPiRouter } from 'jbrancher/pi';
```

Pi-specific loading and UI live in `extensions/jbrancher.js`; the router is
dependency-free and can be tested without installing Pi.
