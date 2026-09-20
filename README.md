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
the task, ordered tool calls, bounded outputs, outcome, safety label, and a
stable train/validation/test split. This gives you a private, incrementally
built dataset without an external database. Use `/jbrancher dataset` to
regenerate it after importing or editing traces.

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

Use `/jbrancher candidates` to inspect candidates and `/jbrancher promote <id>`
for explicit promotion. Unknown or side-effecting actions remain fallback-only
until explicitly configured. If a learned route later fails during execution,
JBrancher quarantines it locally and returns control to the frontier path rather
than retrying the stale route forever. Run the local SWE-bench Lite replay
benchmark with:

```sh
npm run bench:learning
```

The benchmark uses real SWE-bench problem statements to measure routing reuse;
it is not an official SWE-bench patch-resolution result.

For a generic harness or offline inspection, export the same local dataset
without changing route status:

```sh
npx jbrancher dataset --dir .jbrancher
# Omit rejected/unknown episodes when needed:
npx jbrancher dataset --dir .jbrancher --success-only
```

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
action only when the current `getCandidates` result authorizes it:

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

For a bounded live Jev smoke test, copy `.env.example` to `.env`, set `TYPESAFE_API_KEY`, and run:

```sh
npm run live:smoke
```

The command makes three synthetic requests and prints only decisions, scores, and usage metadata. It never prints the key.

### Language-agnostic decision proxy

For Python, Go, Rust, or another harness, run the local decision service:

```sh
TYPESAFE_API_KEY=your-key npx jbrancher proxy --port 8787
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

The proxy exposes `GET /health` and `GET /stats`. It is a decision proxy, not a transparent OpenAI/Anthropic replacement: the caller must supply the actions that are legal in the current harness state. This is what keeps JBrancher bounded and prevents it from inventing executable work.

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

Rules are evaluated first. Jev can select only among candidates supplied by the harness. If the evaluator is uncertain or unavailable, the actor receives the step. Deterministic execution permissions remain in the harness.

## Jev connection

```js
import { createJevEvaluator } from 'jbrancher/jev';

const evaluate = createJevEvaluator({
  apiKey: process.env.TYPESAFE_API_KEY,
  model: 'jev-1.13.0'
});
```

The adapter uses TypeSafe’s System One HTTP endpoint and a pinned model identifier. Set the API key locally; do not place it in traces, candidate metadata, or commits. The network adapter is opt-in through construction and should be used with explicit timeouts and bounded evaluation budgets.

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
```

It compares actor-only, rules-plus-actor, and rules-plus-Jev-plus-actor on a fixed fixture. This measures decision accuracy, actor calls avoided, fallback coverage, and evaluator calls without making paid requests. It is a wiring and regression benchmark, not evidence that Jev improves every task.

For end-to-end evidence, use the same agent, model, task set, Docker image, timeout, and retry budget in paired runs. The recommended progression is:

1. A 10–25 task harness-native smoke set.
2. A larger Terminal-Bench/Harbor run with a custom Harbor agent adapter.
3. SWE-bench Lite or Verified after the agent can emit valid prediction patches.

See [docs/benchmarking.md](docs/benchmarking.md) for the controls, metrics, and commands.
When you have a real prediction file, run the official evaluator through the
included wrapper:

```sh
npm run bench:swebench -- --predictions predictions/jbrancher.jsonl --dry-run
```

## Project plan

See [docs/benchmarking.md](docs/benchmarking.md) for the evaluation and integration guide.

## Attribution

JBrancher was developed as an independent implementation informed by experiments in the AI agent decision-routing space, including the public `MNWinn/agent-switchboard` project. The runtime, package identity, repository history, and product plan here are maintained independently.

## License

MIT. See [LICENSE](LICENSE).
