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

The initial prompt and command text are sent to TypeSafe (up to 16,000 characters
each; oversized commands are skipped). The default cap is 25 evaluations, with
two concurrent requests and a 3-second request timeout. `--max-evaluations 0`
disables TypeSafe calls. Score logs exclude raw prompts and commands; **Codex's own
stdout and session logs can contain them**. Do not publish raw event streams blindly.

See [Codex wrapper validation and limitations](docs/codex-wrapper.md).

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

The offline demo makes no network requests and needs no API key:

```sh
npx jbrancher demo
```

### CLI

```sh
npx jbrancher doctor
npx jbrancher demo
```

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

It compares actor-only, rules-plus-actor, and rules-plus-Jev-plus-actor on a fixed fixture. This measures decision accuracy, actor calls avoided, fallback coverage, and evaluator calls without making paid requests. It is a wiring and regression benchmark, not evidence that Jev improves every task.

For end-to-end evidence, use the same agent, model, task set, Docker image, timeout, and retry budget in paired runs. The recommended progression is:

1. A 10–25 task harness-native smoke set.
2. A larger Terminal-Bench/Harbor run with a custom Harbor agent adapter.
3. SWE-bench Lite or Verified after the agent can emit valid prediction patches.

See [docs/benchmarking.md](docs/benchmarking.md) for the controls, metrics, and commands.

## Project plan

See [docs/benchmarking.md](docs/benchmarking.md) for the evaluation and integration guide.

## Attribution

JBrancher was developed as an independent implementation informed by experiments in the AI agent decision-routing space, including the public `MNWinn/agent-switchboard` project. The runtime, package identity, repository history, and product plan here are maintained independently.

## License

MIT. See [LICENSE](LICENSE).
