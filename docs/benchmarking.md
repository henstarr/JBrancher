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

To save a machine-readable report:

```sh
npm run bench:offline -- --write results/routing.json
```

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

The prediction-generation loop should log routing telemetry separately from the patch. The official harness remains the source of truth for resolution rate.

## What would count as a win?

A credible result is not “Jev scored highly.” It is a paired result such as: the same task set has no statistically meaningful drop in success, while actor calls and cost per successful task decrease, or latency improves at the same success rate. If success drops, keep the mode behind a threshold or use JBrancher only for low-risk transitions.
