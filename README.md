# JBrancher

**Fast branch decisions for AI agent harnesses.**

![JBrancher banner](assets/jbrancher-banner.png)

<p align="center">
  <a href="https://github.com/henstarr/JBrancher"><img src="https://img.shields.io/badge/View%20on-GitHub-111827?style=for-the-badge&logo=github&logoColor=white" alt="View JBrancher on GitHub"></a>
  <a href="https://github.com/henstarr/JBrancher/stargazers"><img src="https://img.shields.io/github/stars/henstarr/JBrancher?style=for-the-badge&logo=github&label=Star" alt="Star JBrancher"></a>
  <a href="https://github.com/henstarr/JBrancher/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/henstarr/JBrancher/ci.yml?style=for-the-badge&label=CI" alt="JBrancher CI status"></a>
  <a href="https://github.com/henstarr/JBrancher/issues"><img src="https://img.shields.io/badge/Issues-Open-2563eb?style=for-the-badge&logo=github" alt="JBrancher issues"></a>
</p>

<p align="center"><a href="docs/benchmarking.md">Benchmarks</a> · <a href="CONTRIBUTING.md">Contribute</a> · <a href="LICENSE">MIT license</a></p>

JBrancher lets an existing agent loop choose the next action through a small decision boundary:

```text
deterministic rule → Jev chooses from known candidates → existing actor fallback
```

The harness owns tools, permissions, execution, and completion checks. JBrancher supplies a typed routing point for decisions that are semantic but bounded. The runtime never invents an action outside the candidate set.

JBrancher is for teams that want to keep their existing agent loop while making bounded next-step decisions faster and easier to measure.

This project is an early developer release. It is designed to measure whether a decision layer actually reduces cost or latency in a particular harness. It does not claim universal savings or act as a sandbox.

## Get started in 60 seconds

### Wrap Claude Code

Install the package and launch your existing native Claude Code CLI:

```sh
npm install github:henstarr/JBrancher
# Set TYPESAFE_API_KEY in a local .env file, then:
npx jbrancher wrap claude
```

The wrapper uses **shadow mode**: it observes proposed tool calls and scores them
with Jev in the background. Claude's permissions and execution continue normally.
It does not approve, deny, rewrite, or execute tools and avoids zero Claude calls.
This release collects evidence for routing improvements; it does not accelerate Claude.

```sh
npx jbrancher wrap claude --mode shadow --max-evaluations 10 -- --resume
# Diagnose the launch without any TypeSafe requests:
npx jbrancher wrap claude --max-evaluations 0 -- --version
```

After local learning has promoted a safe repeated route, an explicit print-mode
prompt can try the local fast path first:

```sh
npx jbrancher wrap claude --mode adaptive --max-evaluations 0 -- -p "read README.md"
```

Adaptive replay is limited to active, repeated, read-only exact/path routes. A
miss launches Claude normally; writes and interactive sessions remain on the
frontier path.

Requires a native Claude Code installation supporting HTTP hooks and `--settings`.
Claude flags follow `--`. The wrapper uses a temporary settings file and an
authenticated loopback hook server; global and project settings files are never edited.
`--settings`, `--bare`, and `--safe-mode` are rejected because they conflict with
the wrapper. Managed policies or disabled hooks can prevent observation; check the
printed `observed` count after exiting. A zero count does not demonstrate integration.

To build the local workflow dataset while keeping the wrapper in shadow mode,
set `JBRANCHER_LEARNING=1`. Episodes are written to the ignored `.jbrancher/`
directory; this does not approve, deny, or replace Claude actions:

```sh
JBRANCHER_LEARNING=1 npx jbrancher wrap claude --max-evaluations 0 -- -p "Read README.md"
```

**Data and budget:** the latest user prompt (up to 16,000 characters) and proposed
tool arguments are sent to TypeSafe for at most 25 evaluations per launch by default.
Repository files and transcripts are not read. Scores have limited context and are
not permission judgments. Calls use a 3-second timeout and at most two concurrent
requests; events without a matching prompt or over budget are skipped. Resumed and
subagent events may lack prompt context and are then skipped. There are no retries.
Local JSONL files under `~/.jbrancher/sessions/` contain scores, timing, errors as
status codes, and summary counts, without prompts or tool arguments. The summary
reports `logErrors` if a score could not be saved. Normal exit removes temporary
settings; force-killing the wrapper may leave a temporary file with a stale local token.

See [Claude wrapper validation and limitations](docs/claude-wrapper.md).

### Wrap Codex (batch sessions)

```sh
# Uses your existing Codex login and a TYPESAFE_API_KEY in .env:
npx jbrancher wrap codex --prompt "Read README.md and summarize the project" --max-evaluations 10 -- --sandbox read-only --ephemeral
```

This launches `codex exec --json`, preserving its JSONL stdout and exit status.
Command events are scored in the background; permissions, hook trust, and config
files are unchanged. Only command execution is observed—not MCP calls, file changes,
or interactive/resumed sessions. This is shadow telemetry, not a speedup or tool gate.

For an explicit batch prompt, adaptive mode tries an active local read-only route
before launching Codex:

```sh
npx jbrancher wrap codex --mode adaptive --prompt "read README.md" --max-evaluations 0 -- --sandbox read-only --ephemeral
```

A local hit emits a minimal JSONL agent response with zero provider usage. A miss
falls through to Codex and is recorded for future learning.

To record Codex command episodes in the same local learning dataset, use:

```sh
JBRANCHER_LEARNING=1 npx jbrancher wrap codex --prompt "Check git status" --max-evaluations 0 -- --sandbox read-only --ephemeral
```

The initial prompt and command text are sent to TypeSafe (up to 16,000 characters
each; oversized commands are skipped). The default cap is 25 evaluations, with
two concurrent requests and a 3-second request timeout. `--max-evaluations 0`
disables TypeSafe calls. Score logs exclude raw prompts and commands; **Codex's own
stdout and session logs can contain them**. Do not publish raw event streams blindly.

See [Codex wrapper validation and limitations](docs/codex-wrapper.md).

### Drop into Pi

JBrancher is also a native Pi package. Install it from this repository:

```sh
pi install git:github.com/henstarr/JBrancher
```

Or try it for one session without changing Pi settings:

```sh
pi -e git:github.com/henstarr/JBrancher
```

The extension handles a small set of safe, read-only prompts directly (`git
status`, current branch, current directory, and Node version). Every other
prompt continues to Pi's configured frontier model. Add project-specific
deterministic routes in `jbrancher.config.js`:

```js
export default {
  routes: [
    {
      id: 'tests',
      match: ({ task }) => /^did the tests pass\??$/i.test(task.trim()),
      run: async ({ exec }) => {
        const result = await exec('npm', ['test']);
        return result.code === 0 ? 'Tests passed.' : (result.stderr || 'Tests failed.');
      }
    }
  ]
};
```

One matching route runs directly. If several routes match, JBrancher asks
Jev to choose only among those routes when `TYPESAFE_API_KEY` is available;
uncertain or failed evaluation falls back to Pi. Use `/jbrancher` for status
and `/jbrancher reload` after changing the config. Set
`JBRANCHER_PI_MODE=shadow` to measure matches without handling prompts, or
`JBRANCHER_PI_MODE=active` for deterministic-first behavior.

See [Pi integration](docs/pi.md) for configuration, limits, and the exact
fallback contract.

### Let Pi learn local workflows

Enable local learning when you want JBrancher to observe frontier work and
build a private, reviewable route cache:

```sh
JBRANCHER_PI_MODE=learning pi -e .
```

Traces and route candidates stay in the project-local, ignored `.jbrancher/`
directory. JBrancher records redacted tool observations, proposes a candidate
on the first successful fallback, and automatically promotes only exact read-only
or conservatively generalized read-only routes:

```text
frontier fallback → redacted dataset row → candidate on first success → repeated evidence → fast path
```

There is no “unknown route” error. A prompt with no registered match simply
continues to Pi's frontier model. In learning mode, that entire episode is
captured locally as a redacted JSONL example in `.jbrancher/dataset.jsonl`:
the task, ordered tool calls, bounded outputs, per-step state and routing
context, outcome, safety label, and a stable train/validation/test split. Each example also records
`routeResolution` (`unmatched`, `uncertain`, `ambiguous`, `failed`, or another explicit
resolution), so unknown work can be separated from route failures during
curation. This gives you a private, incrementally built dataset without an
external database. Use `/jbrancher dataset` to regenerate it after importing
or editing traces.

The local store is safe to share across simultaneous harness sessions. Route
promotion, quarantine, trace appends, and dataset rewrites use atomic files and
a bounded local lock, so concurrent Pi/Codex/Claude runs do not silently lose
each other's learning updates. If a process crashes, an old lock is reclaimed
automatically; no service or external database is required.

Every successful unknown episode is also mined into a `candidate` route
immediately, so the dataset and review queue grow on the first encounter.
Candidates are not executed automatically: read-only routes need repeated
successful evidence (two observations by default), and the harness's own
postcondition can veto promotion. Writes, deletes, deployments, and unknown
shell commands remain dataset evidence and fallback work until you explicitly
review and register them.

After observing two successful reads of different explicitly named project
files, JBrancher may also learn a guarded path template and handle a new safe
relative file request without a frontier turn.

For other single-step tools, JBrancher can learn a conservative action template
when the task visibly contains an argument used by the frontier action. For
example, two verified episodes for `lookup auth in docs` and `lookup billing in
docs` can produce a template for `lookup {query} in docs`; a later `lookup
payments in docs` request can be authorized by the harness and replayed without
another frontier call. Values are stored as slots rather than copied into the
template. Side-effecting or unknown tools still require explicit postcondition
verification before promotion.

The same mechanism applies to verified multi-step workflows. JBrancher fills
the learned slots, then checks every resulting action against the harness's
current candidate catalog before executing the sequence.

Use `/jbrancher candidates` to inspect candidates and `/jbrancher promote <id>`
for explicit promotion. Unknown or side-effecting actions remain fallback-only
until explicitly configured. If a learned route later fails during execution,
JBrancher quarantines it locally and returns control to the frontier path rather
than retrying the stale route forever. Run the local SWE-bench Lite replay
benchmark with:

```sh
npm run bench:learning
npm run bench:workflow -- --assert
```

The benchmark uses real SWE-bench problem statements to measure routing reuse;
it is not an official SWE-bench patch-resolution result.

For a harness-neutral adapter that can collect any unknown route, use
`jbrancher/discovery`. It accepts episode lifecycle events from the existing
frontier actor and handles local redaction, dataset append, candidate mining,
and safe promotion. See [open-world route discovery](docs/open-world-learning.md).
If the harness already has the completed frontier trajectory, call
`learner.recordEpisode({ task, toolCalls, outcome, metadata })` to ingest it in
one step; no external database or manual route registration is required.
The cold-to-warm loop can be checked without a provider key:

```sh
npm run bench:discovery -- --assert
```

To measure argument-template generalization across unseen values, run:

```sh
npm run bench:template-learning -- --assert
```

The template benchmark teaches on two frontier episodes, then replays four
unseen argument values. It is a local efficiency benchmark, not an official
task-success benchmark.

For multi-step parameterized replay, run:

```sh
npm run bench:template-workflow-learning -- --assert
```

This teaches two verified two-step workflows, then replays two new values with
50% fewer frontier action calls.

To measure portable dataset curation against the checked-in SWE-bench-derived
fixture, run:

```sh
npm run bench:dataset -- --assert
```

This keeps every raw observation for learning evidence while collapsing
repeated task/action trajectories into one export row with aggregate outcome
and source counts.

When several learned routes match the same task, JBrancher uses a conservative
evidence-aware selector: more specific matchers win, equally specific routes
need a 2× evidence advantage, and ties return to the frontier actor. Run the
regression benchmark with:

```sh
npm run bench:selection -- --assert
```

The benchmark uses a real SWE-bench Lite problem statement and local redacted
traces. It measures routing reuse, not official patch resolution.

To prove that the improvement survives harness restarts, run the local
persistence benchmark:

```sh
npm run bench:persistence -- --assert
```

It runs three separate processes against one temporary `.jbrancher` directory,
does not enumerate candidates, and verifies the progression
`frontier → frontier → learned` through dynamic authorization with zero
external-database dependency.

To exercise verified side effects against a real temporary project:

```sh
npm run bench:verified-patch -- --assert
```

This writes a small bug fix, runs its focused test, and then replays the
verified multi-step workflow in fresh workspaces. Writes are only reused after
the postcondition verifier passes twice.

For a real SWE-bench test boundary, prepare the checked-in SQLFluff
reproduction at its recorded base commit, then run:

```sh
npm run bench:swebench-real -- \
  --workspace PATH_TO_SQLFLUFF_CHECKOUT \
  --python PATH_TO_VENV_PYTHON \
  --learning-dir .jbrancher/swebench/sqlfluff-1625 \
  --assert
```

This fetches and applies the official `test_patch` and published gold patch in
disposable worktrees, runs the real `FAIL_TO_PASS` test, and teaches/replays the
verified two-step route using the dynamic authorization path. It validates real
test execution and replay wiring; it does not claim autonomous patch generation
or an official SWE-bench score. See [docs/benchmarking.md](docs/benchmarking.md)
for the environment contract.

For a generic harness or offline inspection, export the same local dataset
without changing route status:

```sh
npx jbrancher dataset --dir .jbrancher
# Omit rejected/unknown episodes when needed:
npx jbrancher dataset --dir .jbrancher --success-only
# Keep one representative per repeated task/action trajectory while retaining
# aggregate evidence counts:
npx jbrancher dataset --dir .jbrancher --dedupe
```

The deduplicated export is written to `.jbrancher/dataset-curated.jsonl` so
new frontier episodes can continue appending safely to `.jbrancher/dataset.jsonl`.

### Wrap your own harness

Install JBrancher directly from GitHub:

```sh
npm install github:henstarr/JBrancher
```

Node.js 20 or newer is required. Then wrap the actor your harness already uses:

```js
import { withJBrancher } from 'jbrancher';
import { createJevEvaluator } from 'jbrancher/jev';

const agent = withJBrancher(existingActor, {
  getCandidates: context => harness.allowedNextActions(context),
  evaluate: createJevEvaluator({ apiKey: process.env.TYPESAFE_API_KEY })
});

const decision = await agent.nextAction({ task, state, history });
await harness.execute(decision.action, { task, state, history });
```

Your actor remains the fallback. JBrancher only selects from the candidates returned by your harness.

### Let a custom harness learn unknown fallback work

Pass the local learning store to `createJBrancher` when you want an unknown
actor decision to become a reusable example. JBrancher records only actions
that the actor fallback actually selected and that your `execute` function
completed. After repeated successful examples, safe single-step routes are
loaded back into the same decision boundary automatically. `run()` can also
replay a proven multi-step read-only workflow:

```js
import { createJBrancher } from 'jbrancher';
import { createLocalLearningStore } from 'jbrancher/learning';

const store = createLocalLearningStore({ directory: '.jbrancher' });
const brancher = createJBrancher({
  getCandidates: ({ state }) => harness.allowedNextActions(state),
  actor: context => existingActor.nextAction(context),
  execute: (action, context) => harness.execute(action, context),
  learningStore: store,
  learningSource: 'my-harness',
  learningCwd: process.cwd(),
  learningOutcome: ({ state, events }) => harness.isComplete(state, events)
});
```

If you also want successful Jev-selected actions to become local fast paths,
set `learningOnlyFallback: false`. JBrancher records actor, Jev, and rule
decisions that execute successfully, promotes only safe or postcondition-verified
routes, and bypasses Jev on later authorized repeats. Already-learned replays
are not recorded again, so the local dataset does not grow from its own cache
hits.

The harness still authorizes every action: a learned action is used only when
it matches the current task and is present in the candidate set returned by
`getCandidates`. Otherwise the normal Jev/actor path runs. Learning is local,
redacted, and advisory. The first successful fallback creates a candidate;
set `learningCandidateMinimumObservations` to require more examples before
mining candidates, or set `learningAutoPromote: false` if candidates should
always require manual promotion. `learningMinimumObservations` controls
repeated evidence required for automatic promotion. Multi-step replay applies the same check at
every step and abandons the learned workflow before execution if any step is
no longer legal. `learningOutcome` is optional; when supplied, it is the
harness-owned postcondition that decides whether an episode is eligible for
promotion.

Active routes retain local replay telemetry (`successfulReplays` and
`lastReplayAt`) so repeated reuse can be measured without a hosted service.
`learner.snapshot()` also exposes `replay.successRate`, replay failures,
quarantine state, and estimated frontier steps avoided for the whole store and
for each route.

If a learned step executes but the postcondition rejects it, JBrancher
quarantines the route and gives the frontier actor a recovery turn in the same
task. The recovery episode is retained locally, so stale shortcuts add failure
evidence instead of becoming a dead end.

The frontier actor is open-world: it may handle a task with no registered route
or candidate. Replay is intentionally narrower. By default, a learned action
must appear in the current `getCandidates` capability set. If enumerating a
large or dynamic tool catalog is impractical, provide `authorize` instead (or
in addition); JBrancher asks the harness whether each learned action is legal
right now:

```js
const brancher = createJBrancher({
  getCandidates: ({ state }) => harness.authorizedActions(state), // optional
  authorize: ({ action, state, task }) => harness.canExecute(action, { state, task }),
  actor: context => frontier.nextAction(context),
  execute: (action, context) => harness.execute(action, context),
  learningStore: store
});
```

With `authorize`, an action learned from an unregistered frontier episode can
be replayed even when the harness cannot enumerate it. The callback is the
execution authorization boundary: a truthy result is required for every
single-step or workflow action, and an exception or false result falls back to
the frontier actor. A dynamic capability catalog remains useful when the
harness can provide one, but no hand-written route registration is required.

By default, an actor fallback is recorded even when it selects no tool (for
example, a direct answer or an intentional no-op). That still becomes a
redacted dataset example, but it is not a replayable route until the harness
provides an executable action and successful evidence. Set
`learningRecordEmptyEpisodes: false` if a harness wants to omit those rows.

The default promotion mode is `safe`: only read-only routes can become active.
If your harness has a strong verifier and wants to learn writes or other
side-effecting actions, opt in explicitly with
`learningPromotionMode: 'verified'`. JBrancher then requires a successful
`learningOutcome` result for every observation and still executes the learned
action only when the current `getCandidates` result or `authorize` callback
authorizes it:

```js
const brancher = createJBrancher({
  // ...getCandidates, actor, execute, learningStore...
  learningPromotionMode: 'verified',
  learningOutcome: ({ state, events }) => harness.isComplete(state, events)
});
```

### Reduce context tokens before a model call

For large prompts, let Jev rank optional context while code enforces a hard token budget:

```js
import { optimizeContext } from 'jbrancher/context';
import { createJevContextEvaluator } from 'jbrancher/jev';

const compact = await optimizeContext({
  task,
  state: { repository: 'checkout-service' },
  items: [
    { id: 'task', text: task, tokens: 80, required: true },
    { id: 'failing-test', text: testOutput, tokens: 420 },
    { id: 'source', text: sourceFile, tokens: 900 },
    { id: 'old-changelog', text: changelog, tokens: 700 }
  ],
  maxTokens: 1400,
  minimumScore: 0.6,
  evaluate: createJevContextEvaluator({
    apiKey: process.env.TYPESAFE_API_KEY,
    maxItemChars: 512
  })
});

const prompt = compact.items.map(item => item.text).join('\n\n');
```

Required items are retained, optional items are ranked by relevance per estimated token,
and unavailable Jev requests fall back to local priorities. The selector reports its
estimated savings and TypeSafe usage so net savings can be measured. Token estimates are
inputs supplied by the harness or a rough four-characters-per-token estimate; measure
actual frontier usage in the target model. Run the local hill-climb benchmark with:

```sh
npm run bench:tokens
```

The offline demo makes no network requests and needs no API key:

```sh
npx jbrancher demo
```

### CLI

```sh
npx jbrancher doctor
npx jbrancher demo
npx jbrancher learn --dir .jbrancher
# Optional: require three examples before automatic promotion
npx jbrancher learn --dir .jbrancher --min-observations 3
```

`jbrancher learn` is offline: it mines the local redacted traces, rewrites the
portable `dataset.jsonl`, exposes first-observation candidates, and promotes
only safe read-only candidates after the configured repeated evidence. It never
needs the TypeSafe key or an external database.

To build a portable dataset from multiple local harnesses, merge explicitly
exported redacted JSONL files. This does not change route status:

```sh
npx jbrancher dataset \
  --input machine-a/.jbrancher/dataset.jsonl \
  --input machine-b/.jbrancher/dataset.jsonl \
  --dedupe \
  --output shared-dataset.jsonl
```

The merge validates and re-redacts each row, keeps one representative per
trajectory fingerprint, and preserves aggregate observations. Imported rows are
data only; review or relearn them separately before enabling execution.

After reviewing a shared export, use it as local evidence with the explicit
approval flag:

```sh
npx jbrancher learn \
  --dir .jbrancher \
  --import shared-dataset.jsonl \
  --approve-import
```

JBrancher recomputes fingerprints, caps aggregate evidence, and does not trust
verification claims from the imported file. Safe read-only routes still need the
normal observation threshold; writes remain inactive until the destination
harness verifies their postconditions. Imports are idempotent, so repeating the
same reviewed export does not inflate evidence or route confidence.

For a bounded live Jev smoke test, copy `.env.example` to `.env`, set `TYPESAFE_API_KEY`, and run:

```sh
npm run live:smoke
```

The command makes three synthetic requests and prints only decisions, scores, and usage metadata. It never prints the key.

### Language-agnostic decision proxy

For Python, Go, Rust, or another harness, run the local decision service:

```sh
TYPESAFE_API_KEY=your-key npx jbrancher proxy --port 8787 --learning-dir .jbrancher
```

Submit a bounded candidate set:

```sh
curl http://127.0.0.1:8787/v1/decide \
  -H 'content-type: application/json' \
  -d '{
    "task": "Repair and verify the artifact",
    "state": {"path": "output.json", "verified": false},
    "history": [],
    "candidates": [
      {"tool": "verify", "args": {}},
      {"tool": "repair", "args": {}},
      null
    ]
  }'
```

The proxy exposes `GET /health`, `GET /stats`, and (when `--learning-dir` is supplied) `GET /v1/learning`. It is a decision proxy, not a transparent OpenAI/Anthropic replacement: the caller must supply the actions that are legal in the current harness state. This is what keeps JBrancher bounded and prevents it from inventing executable work.

For a previously learned multi-step workflow, use `POST /v1/workflow` with a
per-step capability catalog. The service returns a workflow only when every
learned action is still authorized by the host:

```json
{
  "task": "Inspect package.json and then read README.md",
  "state": {"phase": 0},
  "candidateSteps": [
    [{"tool": "read", "args": {"path": "package.json"}}],
    [{"tool": "read", "args": {"path": "README.md"}}]
  ]
}
```

An unmatched or unauthorized workflow returns `source: "abstain"`; the
harness should use its frontier actor and submit the complete trajectory to
`/v1/episodes`.

For genuinely open-world work, omit `candidates` or send an empty array. The
proxy returns `source: "abstain"` and `routeResolution: "unmatched"`; the
harness should then call its frontier actor, execute and verify the result, and
send the completed trajectory to `/v1/episodes`. This makes dataset collection
work for routes that were never registered ahead of time without allowing the
proxy to invent an executable action.

### Recording unknown routes for future reuse

Open-world harnesses can send completed frontier trajectories to the same local
service without pre-registering the route. JBrancher redacts sensitive values,
writes the trace to `.jbrancher/traces.jsonl`, exports a dataset row, and can
mine repeated successful behavior into a candidate route:

```sh
curl http://127.0.0.1:8787/v1/episodes \
  -H 'content-type: application/json' \
  -d '{
    "task": "Inspect the repository and run its tests",
    "source": "my-harness",
    "routeResolution": "unmatched",
    "toolCalls": [{
      "toolName": "bash",
      "input": {"command": "npm test"},
      "context": {"candidateCount": 0},
      "ok": true,
      "output": "tests passed"
    }],
    "outcome": "success"
  }'
```

The episode endpoint is the bridge for Python, Go, Rust, Pi, and Harbor
adapters: the harness still executes the frontier action, while JBrancher owns
redaction, durable local traces, dataset construction, and conservative route
promotion. The storage is local JSONL/JSON by design; bind the proxy to
localhost unless you add your own authentication and network boundary.

When `/v1/decide` returns `source: "learned"`, send the returned `routeId` back
with the completed episode. A successful episode increments that route's local
replay telemetry; a failed episode remains evidence for the harness to inspect
and, when sent with `outcome: "failure"` or `routeResolution: "failed"`,
quarantines the route before the frontier recovery path.

The default proxy only promotes read-only routes. For a harness that supplies a
real postcondition, opt into verified promotion with
`--learning-allow-verified` and send `finishMetadata.postconditionValidated:
true` only after the harness verifier passes.

### Python / Harbor bridge

The repository includes a dependency-free Python client at
`integrations/python/jbrancher_proxy.py`:

```python
from integrations.python import JBrancherProxy

proxy = JBrancherProxy()
decision = proxy.decide(
    task="Inspect package.json",
    state={"repository": "fixture"},
    candidates=[{"tool": "read", "args": {"path": "package.json"}}],
)

if decision["source"] == "learned":
    action = decision["action"]
else:
    action = frontier_actor(decision)  # the harness owns this call

result = execute(action)  # the harness owns execution and verification
proxy.record_episode(
    "Inspect package.json",
    [{"tool_name": action["tool"], "input": action["args"], "ok": result.ok}],
    outcome="success" if result.ok else "failure",
    route_id=decision.get("routeId"),
    route_resolution="learned" if decision["source"] == "learned" else "unmatched",
)
```

The client uses only Python's standard library. It does not execute actions,
choose a frontier model, or create an external database, which makes it usable
inside a Harbor/Pi/custom harness adapter.

For an async Harbor-style loop, use the included orchestration helper. It keeps
the frontier callback and environment executor in your agent while handling
JBrancher decisions, verification feedback, local episode recording, and
learned-route recovery:

```python
from integrations.python import JBrancherHarborLoop, JBrancherProxy

loop = JBrancherHarborLoop(JBrancherProxy(), source="my-harbor-agent")
step = await loop.step(
    instruction,
    state,
    candidates=legal_actions_or_none,
    frontier=frontier_actor,
    execute=execute_in_environment,
    verify=verify_postcondition,
)
```

The helper is Harbor-compatible but does not import Harbor, so it remains
usable in any Python harness and is straightforward to call from Harbor's
`BaseAgent.run()` method.

For a direct Harbor custom-agent base class, import
`JBrancherHarborAgent`. Harbor is optional at import time; when installed, the
class implements the current `BaseAgent` boundary and reports a compact
JBrancher summary through `AgentContext.metadata`:

```python
from integrations.python import JBrancherHarborAgent

class MyAgent(JBrancherHarborAgent):
    async def frontier_action(self, instruction, state, decision, environment, context):
        # Call the existing frontier model here and return one action mapping.
        return await my_frontier_model(instruction, state, decision)

    async def candidate_actions(self, instruction, state, history, environment, context):
        # Return only actions currently authorized by the environment/policy.
        return await authorized_actions(environment, state)
```

Start the local learning proxy and point Harbor at it with
`JBRANCHER_PROXY_URL` (the default is `http://127.0.0.1:8787`), then run the
custom class with Harbor's normal `--agent module:Class` option. The adapter
does not replace the frontier model or verifier; it inserts local replay and
episode capture at the `BaseAgent.run()` boundary.

For multi-step workflows, `JBrancherHarborLoop.run()` records the entire
frontier trajectory as one dataset example and can replay an authorized local
workflow:

```python
result = await loop.run(
    instruction,
    state,
    candidate_steps=legal_candidates_by_step,
    frontier=frontier_actor,
    execute=execute_in_environment,
    observe=observe_state,
    verify=verify_postcondition,
)
```

Each recorded tool call includes the current state and compact routing metadata
(`source`, `routeResolution`, candidate count, and route ID when present), so
the local dataset preserves the reason a workflow was learned or replayed.

## Use in a harness

```js
import { createJBrancher } from 'jbrancher';

const brancher = createJBrancher({
  getCandidates: ({ state }) => [
    { tool: 'run_check', args: { path: state.path } },
    { tool: 'repair', args: { path: state.path } },
    null
  ],
  evaluate: async ({ state, task, history, candidates, signal }) => {
    // Connect createJevEvaluator from `jbrancher/jev` here.
    return { scores: [0.88, 0.61, 0.12], usage: [] };
  },
  actor: ({ state, task, history }) => existingActor.nextAction({ state, task, history }),
  execute: (action, context) => existingHarness.execute(action, context)
});

const event = await brancher.step({
  task: 'Repair and verify the artifact',
  state: { path: 'output.json' },
  history: []
});
```

That is the drop-in boundary: your harness provides candidates and execution; JBrancher decides whether a bounded candidate is safe to try, and your existing actor remains the fallback. In an existing loop, wrap the call that currently chooses the next tool. Keep the harness's authorization, sandbox, observation, retry, and completion checks unchanged.

Enable local continuous learning without constructing a store manually:

```js
const brancher = createJBrancher({
  learningDirectory: '.jbrancher',
  getCandidates,
  actor,
  execute
});
```

For an open-world harness that cannot enumerate tools, omit `getCandidates` and
provide `authorize({ action, state, task, history })`. The first successful
frontier episodes are recorded locally, and repeated verified routes can be
replayed after process restarts. `learningStore` remains available when a
harness needs a custom local store or explicit lifecycle control.

Rules are evaluated first. Jev can select only among candidates supplied by the harness. If the evaluator is uncertain or unavailable, the actor receives the step. Deterministic execution permissions remain in the harness.

## Jev connection

```js
import { createJevEvaluator } from 'jbrancher/jev';

const evaluate = createJevEvaluator({
  apiKey: process.env.TYPESAFE_API_KEY,
  model: 'jev-latest'
});
```

The adapter uses TypeSafe’s System One HTTP endpoint. The default model is
`jev-latest`; you can pin a concrete revision such as `jev-1.13.0` for
reproducible experiments. Route selection uses a Choice question with a
no-match branch by default; pass `questionType: 'noul'` only for compatibility
with older integrations. Set the API key locally; do not place it in traces, candidate
metadata, or commits. The network adapter is opt-in through construction and
should be used with explicit timeouts and bounded evaluation budgets.
Choice catalogs are capped at 254 executable candidates because JBrancher adds
`no_match` as the 255th provider option; larger catalogs fail closed to the
frontier path.

## Why this placement matters

Calling Jev after an expensive actor turn can reduce the actor’s next action but still increase total cost. JBrancher is built around the earlier decision point: derive a bounded candidate set from current harness state, ask Jev to rank it, and call the actor only when rules or the evaluator cannot settle the step.

That placement is an optimization hypothesis, not a guarantee. Compare at least these controls in your own task set:

1. Existing actor loop.
2. Actor plus deterministic completion/routing.
3. Actor plus deterministic routing and selective Jev.

Measure successful tasks, clean termination, actor calls actually avoided, evaluator overhead, latency, retries, and cost per successful task. Keep unknown provider usage visible.

## Safety and limits

- Candidate ranking is not permission. Your harness must enforce authorization before execution.
- The package is not a shell sandbox or transaction system.
- Tool execution may be non-transactional; ambiguous side-effect timeouts need reconciliation.
- A semantic completion score is not proof that a task is complete. Use executable checks and state revisions.
- Jev scores require validation in the target domain; the default thresholds are routing placeholders.
- The current release has a generic JavaScript runtime and an HTTP Jev adapter. Framework integrations and a hosted dashboard are planned.

## Benchmarking

Start with the reproducible offline routing benchmark:

```sh
npm run bench:offline
```

CI uses `--assert` with the offline, token, and local-learning benchmarks so a
regression in accuracy, held-out coverage, or measured savings fails loudly:

```sh
npm run bench:offline -- --assert
npm run bench:tokens -- --assert
npm run bench:learning -- --assert
npm run bench:proxy -- --assert
npm run bench:persistence -- --assert
npm run bench:verified-patch -- --assert
```

It compares actor-only, rules-plus-actor, and rules-plus-Jev-plus-actor on a fixed fixture. This measures decision accuracy, actor calls avoided, fallback coverage, and evaluator calls without making paid requests. It is a wiring and regression benchmark, not evidence that Jev improves every task.

With `TYPESAFE_API_KEY` in the ignored `.env`, measure real provider usage on a
small repeated SWE-bench prompt:

```sh
npm run bench:live-learning
# Bound the run explicitly when experimenting:
npm run bench:live-learning -- --instances 2 --repetitions 4
```

This makes a bounded live request only for the warm-up decisions, then reports
actual Jev input/output usage and the authorized local-route coverage. It does
not run the official SWE-bench grader or print credentials.

The latest one-task live verification is recorded in
[docs/live-learning-1task-2026-09-20.md](docs/live-learning-1task-2026-09-20.md).
The latest real-Codex actor-learning run is recorded in
[docs/live-codex-2026-09-21.md](docs/live-codex-2026-09-21.md).
The experimental live Codex argument-template pilot is recorded in
[docs/live-codex-template-2026-09-21.md](docs/live-codex-template-2026-09-21.md).
The latest four-value live template run is recorded in
[docs/live-codex-template-4values-2026-09-20.md](docs/live-codex-template-4values-2026-09-20.md).
The latest live Codex authorization-only run is recorded in
[docs/live-codex-authorization-2026-09-21.md](docs/live-codex-authorization-2026-09-21.md).
The latest cross-process live Codex persistence run is recorded in
[docs/live-codex-persistence-2026-09-21.md](docs/live-codex-persistence-2026-09-21.md).
The latest three-task live-Codex run is recorded in
[docs/live-codex-3tasks-2026-09-21.md](docs/live-codex-3tasks-2026-09-21.md).
The latest seven-task live-Codex run is recorded in
[docs/live-codex-7tasks-2026-09-21.md](docs/live-codex-7tasks-2026-09-21.md).
The current `jev-latest` compatibility run is recorded in
[docs/live-jev-latest-2026-09-21.md](docs/live-jev-latest-2026-09-21.md).
The latest three-task paired live Jev run is recorded in
[docs/live-jev-3tasks-2026-09-21.md](docs/live-jev-3tasks-2026-09-21.md).
The latest three-task Pi preference-learning run is recorded in
[docs/live-pi-3tasks-2026-09-20.md](docs/live-pi-3tasks-2026-09-20.md).
The full 14-task Choice-evaluator run is recorded in
[docs/live-pi-14tasks-2026-09-20.md](docs/live-pi-14tasks-2026-09-20.md).

To benchmark the language-agnostic open-world bridge, run:

```sh
npm run bench:proxy -- --assert
```

This sends SWE-bench-derived tasks through the local HTTP proxy, records two
frontier episodes per task, then verifies that later authorized decisions are
served by learned local routes without evaluator calls. It requires no API key
and uses a temporary local store.

To exercise the dependency-free Python bridge used by a Harbor-style agent,
run:

```sh
npm run bench:harbor -- --assert
```

This starts a temporary local proxy, runs the shipped
`JBrancherHarborLoop`, sends unknown two-step tasks to its frontier callback,
records the completed trajectories, and then replays authorized workflows.
The current 14-task fixture records 56 episodes, learns 14 routes, replays 28
workflows, and cuts frontier steps from 112 to 56 with 100% success and route
coverage. It is a bridge benchmark rather than an official Terminal-Bench
score; the same loop can be placed inside a real Harbor `BaseAgent` once its
environment executor and verifier are supplied.

To verify that learning adapts when the harness's capabilities change, run:

```sh
npm run bench:adaptation -- --assert
```

The drift benchmark changes a task's available action catalog after the first
workflow is learned. JBrancher abstains safely, lets the frontier model handle
the replacement workflow, records the new evidence, and replays the new route
after it earns enough observations. The current 14-task run preserves 100%
success while reducing frontier steps by 33.3%.

To benchmark open-world learning when the harness cannot enumerate its tools,
run:

```sh
npm run bench:authorization -- --assert
```

This uses the SWE-bench-derived fixture, omits `getCandidates`, and authorizes
learned actions through a dynamic callback. The latest 14-instance run reduced
frontier calls from 56 to 4 (92.9%), replayed 52 actions locally with 100%
route coverage, and correctly fell back once when authorization was revoked.
The result uses synthetic actor-token assumptions and is not an official
SWE-bench patch-resolution score; see
[docs/dynamic-authorization-2026-09-21.md](docs/dynamic-authorization-2026-09-21.md).

For the same boundary with real Codex usage, run:

```sh
npm run bench:live-codex-template -- --values 4 --authorization-only --assert
```

To verify live learning across a harness restart, persist the local directory
and run teaching and replay as separate processes:

```sh
npm run bench:live-codex-template -- \
  --values 4 --authorization-only --phase teach \
  --learning-dir .jbrancher/live-codex-template --assert
npm run bench:live-codex-template -- \
  --values 4 --authorization-only --phase replay \
  --learning-dir .jbrancher/live-codex-template --assert
```

This omits `getCandidates`, uses the harness authorization callback, and
reports observed Codex tokens. The latest four-value run saved 31,842 observed
tokens and served both novel values locally; see
[docs/live-codex-authorization-2026-09-21.md](docs/live-codex-authorization-2026-09-21.md).

For the live Pi route-choice benchmark, calibrate thresholds explicitly and
keep assertions enabled:

```sh
npm run bench:live-pi-learning -- --instances 14 --repetitions 4 \
  --min-probability 0.45 --min-margin 0.05 --assert
```

For end-to-end evidence, use the same agent, model, task set, Docker image, timeout, and retry budget in paired runs. The recommended progression is:

1. A 10–25 task harness-native smoke set.
2. A larger Terminal-Bench/Harbor run with a custom Harbor agent adapter.
3. SWE-bench Lite or Verified after the agent can emit valid prediction patches.

See [docs/benchmarking.md](docs/benchmarking.md) for the controls, metrics, and commands.
When you have a real prediction file, run the official evaluator through the
included wrapper:

```sh
npm run bench:swebench-validate -- --predictions predictions/jbrancher.jsonl
npm run bench:swebench -- --predictions predictions/jbrancher.jsonl --dry-run
```

The validator checks the official JSONL shape and requested-instance coverage
before Docker or Modal is invoked; patch correctness remains the evaluator's
responsibility.

## Project plan

See [docs/benchmarking.md](docs/benchmarking.md) for the evaluation and integration guide.

## Attribution

JBrancher was developed as an independent implementation informed by experiments in the AI agent decision-routing space, including the public `MNWinn/agent-switchboard` project. The runtime, package identity, repository history, and product plan here are maintained independently.

## License

MIT. See [LICENSE](LICENSE).
