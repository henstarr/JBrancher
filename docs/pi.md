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
   validation, or test splits.
4. `/jbrancher candidates` mines repeated successful workflows with the same
   normalized task and action sequence.
5. Repeated read-only candidates are promoted automatically; `/jbrancher promote <id>`
   is available for explicit manual promotion.
6. The active route can answer the same prompt without a frontier turn.

Learned routes currently support exact normalized prompts and conservative
token-similarity matches for one or more repeated `read` actions, plus a small
allowlist of read-only `bash` commands. Similarity generalization requires
repeated evidence for each observed phrasing and defaults to a similarity score
of 0.8; tune it with `minimumSimilarity` when configuring a project. Other
actions remain in the dataset but are candidate or fallback-only; this
prevents learning from silently replaying writes, deletes, deployments, or
arbitrary shell commands. The trace store is local and ignored by Git, so users
can delete `.jbrancher/` to reset learning. Set
`autoPromoteReadOnly: false` in `jbrancher.config.js` if you want every
candidate to require manual promotion.

When two successful traces read different explicitly named project files,
JBrancher can also promote a guarded path template. A later request such as
`inspect src/index.js` can read that new relative path without a frontier turn;
the template rejects write/delete language, traversal, absolute paths, and
common secret/key files.

Run the local replay benchmark:

```sh
npm run bench:learning
```

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
