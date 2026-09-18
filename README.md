# JBrancher

**Fast branch decisions for AI agent harnesses.**

![JBrancher banner](assets/jbrancher-banner.png)

JBrancher lets an existing agent loop choose the next action through a small decision boundary:

```text
deterministic rule → Jev chooses from known candidates → existing actor fallback
```

The harness owns tools, permissions, execution, and completion checks. JBrancher supplies a typed routing point for decisions that are semantic but bounded. The runtime never invents an action outside the candidate set.

JBrancher is for teams that want to keep their existing agent loop while making bounded next-step decisions faster and easier to measure.

This project is an early developer release. It is designed to measure whether a decision layer actually reduces cost or latency in a particular harness. It does not claim universal savings or act as a sandbox.

## Install

The package is currently used directly from source:

```sh
git clone https://github.com/henstarr/JBrancher.git
cd JBrancher
npm test
npm run demo
```

Node.js 22 or newer is required. The demo makes no network requests and needs no API key.

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

## Project plan

See [PRODUCTIZATION_PLAN.md](PRODUCTIZATION_PLAN.md) for the product, evaluation, documentation, release, and launch plan.

## Attribution

JBrancher was developed as an independent implementation informed by experiments in the AI agent decision-routing space, including the public `MNWinn/agent-switchboard` project. The runtime, package identity, repository history, and product plan here are maintained independently.

## License

MIT. See [LICENSE](LICENSE).
