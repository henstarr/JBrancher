# Benchmarking JBrancher

JBrancher is a decision layer, so benchmark it at two levels:

1. **Routing benchmark:** does the layer select the right bounded action, abstain when uncertain, and reduce expensive actor calls?
2. **End-to-end benchmark:** does the complete harness solve more tasks, faster, or at lower cost when JBrancher is enabled?

Do not treat the first level as proof of the second. The offline fixture is deliberately small and synthetic; it tests wiring, fallback behavior, and regression safety without provider requests.

## Start locally

```sh
npm ci
npm run bench:offline
```

Use `--assert` for the same regression gates used by CI:

```sh
npm run bench:offline -- --assert
npm run bench:tokens -- --assert
npm run bench:learning -- --assert
```

These assertions require perfect fixture decision/holdout coverage and a
positive measured reduction in actor/frontier calls or context tokens.

To save a machine-readable report:

```sh
npm run bench:offline -- --write results/routing.json
```

## Current local snapshot

The reproducible local learning benchmark currently uses 14 real SWE-bench Lite
problem statements across seven repositories, eight repetitions per task, and
four warm-up attempts:

- Pi-style read-only replay: 112 simulated frontier calls down to 56 (50%
  fewer), handling all 56 held-out post-warm-up attempts (100% held-out route
  coverage) and saving 3,224 estimated prompt tokens.
- Generic two-step harness replay: 336 actor calls down to 84 (75% fewer),
  with 100% held-out learned-step coverage.
- Jev-selected route learning: eight simulated Jev decisions down to two (75%
  fewer) after two successful warm-up executions, with 100% learned-route
  coverage on the remaining repetitions.
- Pi ambiguity preference learning: eight simulated Pi Jev decisions down to
  two (75% fewer), with the same route remaining correct on every learned
  replay.
- Postcondition-verified write arm: the third repeated action uses the learned
  route after two actor warm-ups, avoiding 33.3% of actor calls in that
  three-attempt trial.
- Context hill climb: 3,350 estimated context tokens down to 1,950 (41.8%
  fewer) while retaining 100% fixture coverage.

These are routing-efficiency and synthetic context measurements, not official
patch-resolution scores. Re-run them locally after changing the learner; run
the official SWE-bench Docker harness separately for task success.

To measure actual Jev overhead and savings on the same learning path, configure
`TYPESAFE_API_KEY` in the ignored `.env` and run:

```sh
npm run bench:live-learning
npm run bench:live-learning -- --instances 2 --repetitions 4
```

The command is deliberately bounded, uses a temporary local learning store,
reports observed input/output tokens and evaluator calls, and removes its
temporary data afterward. It is a live usage benchmark, not an official
SWE-bench resolution result.

The latest checked-in live sample is summarized in
[docs/live-learning-2026-09-20.md](live-learning-2026-09-20.md). It reduced
12 Jev calls to 6 across three prompts while retaining 100% learned-route
coverage. Install the official evaluator wrapper separately when preparing a
Docker-backed run:

```sh
python -m pip install -r benchmarks/requirements.txt
```

For the Pi-specific route-choice path, run the similarly bounded live check:

```sh
npm run bench:live-pi-learning -- --instances 1 --repetitions 4
```

It promotes a preference only when the deterministic route verifier returns
the expected result, then reports real Jev calls, usage, and learned coverage.
The latest checked-in Pi result is summarized in
[docs/live-pi-learning-2026-09-20.md](live-pi-learning-2026-09-20.md).

The fixture compares three controls:

- `actor-only`: the existing actor chooses every step.
- `rules`: deterministic rules get first chance, then the existing actor.
- `jbrancher`: deterministic rules, bounded Jev-style scoring, then actor fallback.

The report includes decision accuracy, actor calls avoided, evaluator calls, source counts, and per-case decisions. The synthetic evaluator is intentionally not a network call.

## The fair experiment

For any real harness, run paired trials with the same task IDs, model, prompt, tool permissions, Docker image, timeout, retry policy, and randomization seed where supported. Only the routing layer should change.

Recommended arms:

| Arm | Description |
| --- | --- |
| A | Existing actor-only loop |
| B | Existing loop plus deterministic completion/routing |
| C | B plus selective JBrancher decisions |
| D | Optional shadow mode: log JBrancher decisions but never execute them |

Record these metrics per task and in aggregate:

- task success or verifier reward;
- clean termination, timeout, and max-step rates;
- actor calls, tool calls, retries, and calls avoided;
- evaluator calls, token usage, latency p50/p95, and provider errors;
- cost per task and cost per successful task;
- routing accuracy against a labeled action set;
- confidence calibration (Brier score or reliability bins);
- fallback and abstention rates;
- safety-policy violations or unauthorized actions.

Keep failed, timed-out, and unknown-cost tasks in the denominator. Report mean and bootstrap confidence intervals once the sample is large enough. Never let the evaluator see the final grader result while it is choosing an action.

## Drop-in integration

JBrancher belongs immediately before the harness's existing `nextAction` call:

```js
const brancher = createJBrancher({
  getCandidates: context => harness.allowedNextActions(context),
  evaluate: createJevEvaluator({ apiKey: process.env.TYPESAFE_API_KEY }),
  actor: context => existingActor.nextAction(context),
  execute: (action, context) => harness.execute(action, context)
});

const event = await brancher.step({ task, state, history });
```

The harness remains responsible for authorization, sandboxing, idempotency, observation, and completion checks. Start with shadow logging, then enable execution only for actions that pass domain-specific validation.

For a learning run, provide a project-local store:

```js
const store = createLocalLearningStore({ directory: '.jbrancher' });
const brancher = createJBrancher({
  getCandidates: context => harness.allowedNextActions(context),
  actor: context => existingActor.nextAction(context),
  execute: (action, context) => harness.execute(action, context),
  learningStore: store,
  learningSource: 'benchmark-harness',
  learningOutcome: ({ state, events }) => harness.isComplete(state, events)
});
```

This creates a closed-loop experiment: actor fallbacks produce redacted
episodes, repeated successful read-only episodes are promoted locally, and a
later run can use a learned action only when it is still present in the
harness-provided candidate set. Keep learning enabled for both paired arms
only when you are measuring dataset growth; for a clean cost comparison,
freeze or copy the learned `.jbrancher/routes.json` between trials so the
controls do not receive different experience. Prefer supplying
`learningOutcome` from the same verifier/postcondition used by the harness so
tool success is not confused with task success.

Keep `learningPromotionMode: 'safe'` for general-purpose agents. A harness
may use `learningPromotionMode: 'verified'` to learn side-effecting actions,
but only when its postcondition verifier returns success and its current
candidate set still authorizes the replay. Treat this as a harness policy
decision, not as a Jev confidence decision.

When the goal is to reduce Jev requests as well as actor requests, opt into
recording successful Jev decisions with `learningOnlyFallback: false`. The
local store still requires repeated evidence and the same candidate authorization
before replay. Keep the default `true` when you want learning to observe only
frontier/actor fallbacks.

Learned multi-step replays are sent through the same postcondition on every
run. If it rejects a replay, JBrancher quarantines the route so the next
attempt returns to the actor. In Pi, a route failure starts a fresh recorder
for the frontier recovery, preserving the recovery trajectory in the local
dataset.

## Terminal-Bench / Harbor

Harbor is the current harness for running Terminal-Bench 2.0. The right integration is a custom Harbor agent that owns the normal terminal loop and invokes JBrancher at the next-action boundary. Keep the benchmark task and verifier unchanged.

The initial run should be small and paired:

```sh
harbor run --dataset terminal-bench@2.0 \
  --agent path.to.jbrancher_agent:JBrancherAgent \
  --model <same-model-as-control> \
  --n-concurrent 4
```

First validate the adapter with the Harbor oracle, then run 10–25 tasks with the actor-only agent and the JBrancher agent. Scale only after the trajectory schema, environment variables, tool calls, and reward files are identical between arms.

The custom agent should export per-trial JSON such as:

```json
{
  "source": "jev",
  "action": "run_tests",
  "candidate_count": 3,
  "score": 0.91,
  "fallback": false,
  "evaluator_latency_ms": 41,
  "actor_call_avoided": true
}
```

Do not put API keys into trajectories.

## SWE-bench

SWE-bench evaluates generated patches in reproducible Docker environments. JBrancher does not replace the coding actor or the official grader; it changes how the agent chooses intermediate actions while it investigates and edits a repository.

Use this order:

1. Add a JBrancher-aware agent loop that still emits the normal SWE-bench prediction JSONL: `instance_id`, `model_name_or_path`, and `model_patch`.
2. Run a tiny fixed set and confirm actor-only and JBrancher modes produce valid patches.
3. Run the official evaluator on exactly the same prediction format and instance IDs.
4. Move to SWE-bench Lite, then Verified, only after the adapter is stable.

Example evaluation command:

```sh
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --predictions_path predictions/jbrancher.jsonl \
  --instance_ids <fixed-instance-1> <fixed-instance-2> \
  --max_workers 2 \
  --run_id jbrancher-smoke
```

JBrancher includes a thin command wrapper for the same official evaluator:

```sh
npm run bench:swebench -- \
  --predictions predictions/jbrancher.jsonl \
  --dataset princeton-nlp/SWE-bench_Lite \
  --instance-ids astropy__astropy-14539 \
  --max-workers 2 \
  --run-id jbrancher-smoke
```

Use `--dry-run` to inspect the exact Python command without starting Docker.
Use `--modal` when running the official cloud evaluation path. The wrapper does
not generate patches or alter predictions; it only standardizes invocation and
keeps JBrancher telemetry separate from the evaluator input.

The prediction-generation loop should log routing telemetry separately from the patch. The official harness remains the source of truth for resolution rate.

## What would count as a win?

A credible result is not “Jev scored highly.” It is a paired result such as: the same task set has no statistically meaningful drop in success, while actor calls and cost per successful task decrease, or latency improves at the same success rate. If success drops, keep the mode behind a threshold or use JBrancher only for low-risk transitions.

## Token optimization hill climb

The context optimizer has a local, synthetic regression benchmark:

```sh
npm run bench:tokens
```

It searches relevance thresholds and context budgets, accepting only configurations
that preserve the fixture's required context and improve estimated frontier tokens.
The benchmark is deliberately not a frontier-quality claim. For a real run, include
the Jev request's `inputTokens` and `outputTokens` in the total. A selector that saves
frontier tokens but costs more in Jev tokens is not an optimization.
