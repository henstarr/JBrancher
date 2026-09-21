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
npm run bench:cost -- --assert
npm run bench:tokens -- --assert
npm run bench:learning -- --assert
npm run bench:proxy -- --assert
npm run bench:workflow -- --assert
npm run bench:harbor -- --assert
npm run bench:adaptation -- --assert
npm run bench:dataset -- --assert
npm run bench:persistence -- --assert
npm run bench:verified-patch -- --assert
npm run bench:template-learning -- --assert
npm run bench:template-workflow-learning -- --assert
npm run bench:package -- --assert
```

`bench:package` packs the repository, installs that tarball into a clean
temporary prefix, imports the public package entry point, and runs the installed
CLI demo. It is the fastest check that a user can install JBrancher without
depending on the repository checkout.

`bench:persistence` runs three separate Node processes against one temporary
local learning directory. It verifies that two successful frontier episodes
survive process boundaries and that the third process replays the learned route
without calling the frontier actor or an external database.

`bench:verified-patch` exercises side effects against a real temporary project:
the frontier fixture writes a bug fix and runs a focused test, then JBrancher
replays the multi-step workflow in fresh workspaces only after the verifier has
approved two successful observations. It measures verified write-workflow
reuse; it is not an official SWE-bench patch-resolution score.

Before invoking the official evaluator, validate a generated prediction file
without any external service:

```sh
npm run bench:swebench-validate -- \
  --predictions predictions/jbrancher.jsonl \
  --instance-ids <instance-id>
```

The validator checks JSONL shape, required fields, duplicate instance IDs, and
requested-instance coverage. It does not judge patch correctness. The official
runner performs the same validation before attempting Docker or Modal.

These assertions require perfect fixture decision/holdout coverage and a
positive measured reduction in actor/frontier calls or context tokens.

The dataset curation benchmark measures a separate property: repeated local
episodes remain available as evidence, while the portable export collapses
duplicate task/action fingerprints and preserves aggregate outcome metadata.
It uses the checked-in SWE-bench-derived fixture and does not claim patch
resolution. It also splits the export into two simulated machine-local shards,
merges them in memory, and verifies that aggregate evidence is preserved; this
is the same operation exposed by `jbrancher dataset --input ...` and does not
use an external database. The benchmark then imports that portable export into a
fresh local store, applies the normal read-only promotion threshold, and verifies
that all 14 SWE-bench-derived workflows become local active routes without
importing verification claims. A second import is also run and must skip all 56
existing observations, proving the local import is idempotent.

The paired cost fixture uses the same task set, actor, and completion oracle for
actor-only, rules-only, and JBrancher arms. It reports task success, actor and
Jev calls, input/output tokens, token reduction, and latency:

```sh
npm run bench:cost -- --assert
```

To calculate an optional provider-cost estimate, pass rates in dollars per
million tokens. Do not treat the synthetic rates or oracle as a claim about a
frontier model:

```sh
npm run bench:cost -- --actor-input-rate 3 --actor-output-rate 15 \
  --jev-input-rate 0.5 --jev-output-rate 2
```

To save a machine-readable report:

```sh
npm run bench:offline -- --write results/routing.json
```

## Current local snapshot

The reproducible local learning benchmark currently uses 14 SWE-bench Lite
instance IDs across seven repositories (11 from the current `dev` split and 3
from `test`), eight repetitions per task, and four warm-up attempts. The
checked-in problem statements are compact summaries; the `FAIL_TO_PASS` values
and split provenance are recorded in the fixture:
`benchmarks/fixtures/swebench-lite-mini.json`.

Validate the fixture against the live Hugging Face rows when refreshing the
benchmark source:

```sh
npm run bench:provenance
```

This command is benchmark tooling only. JBrancher itself does not fetch the
dataset, use a hosted database, or require network access at runtime.

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
- Action-template generalization: two verified frontier teaching episodes learn
  a parameterized lookup route, then four unseen query values replay locally;
  frontier calls fall from 6 to 2 (66.7% fewer) with 100% replay success.
- Multi-step action-template generalization: two verified two-step teaching
  workflows replay two unseen values, reducing frontier action calls from 8 to 4
  (50% fewer) with every step reauthorized by the harness.
- Context hill climb: 3,350 estimated context tokens down to 1,950 (41.8%
  fewer) while retaining 100% fixture coverage.

These are routing-efficiency and synthetic context measurements, not official
patch-resolution scores. Re-run them locally after changing the learner; run
the official SWE-bench Docker harness separately for task success.

The language-agnostic proxy benchmark exercises the actual HTTP capture and
replay boundary using the same SWE-bench-derived prompts:

```sh
npm run bench:proxy -- --assert
```

It records two successful unmatched episodes per task, then sends later
authorized decisions through `/v1/decide`. The assertion requires 100% learned
route coverage, zero evaluator calls on replay, and a positive frontier-call
reduction. The first two attempts now call `/v1/decide` without candidates and
assert `abstain/unmatched` before recording the frontier trajectory. It is a local transport/learning benchmark—not an official
SWE-bench patch-resolution result.

The multi-step workflow benchmark exercises the complete trajectory boundary
and the `/v1/workflow` replay endpoint:

```sh
npm run bench:workflow -- --assert
```

The latest run promoted 14 two-step workflows, replayed 28 of 56 total
attempts, and reduced synthetic actor steps from 112 to 56 with 100% route
coverage. See [docs/workflow-proxy-2026-09-21.md](workflow-proxy-2026-09-21.md).

The Python Harbor-style bridge benchmark exercises the shipped
`JBrancherHarborLoop` through the same local HTTP service that a Harbor agent
would use:

```sh
npm run bench:harbor -- --assert
```

The current fixture run uses 14 SWE-bench-derived tasks and four repetitions.
The first two repetitions intentionally send no registered actions, so the
frontier callback handles the complete two-step trajectory. The final two
repetitions expose the host's current per-step capability catalog, allowing
the learned workflow to replay only when every action is still authorized.
The latest local run records 56 episodes, promotes 14 routes, replays 28
workflows, and reduces frontier steps from 112 to 56 with 100% success and
route coverage. It is a deterministic bridge/regression benchmark, not an
official Harbor or Terminal-Bench score; run the real Harbor agent against
Terminal-Bench after the adapter is connected to its environment and oracle.

To test continuous improvement under capability drift, run:

```sh
npm run bench:adaptation -- --assert
```

This benchmark learns a two-step read workflow, changes the host's available
action catalog, verifies that the old workflow abstains instead of executing,
records two frontier recoveries, and then verifies that the replacement route
replays. The current 14-task run records 84 episodes, performs 28 safe drift
abstentions, maintains 100% success, and reduces frontier steps from 168 to
112 (33.3%) while learning 28 active routes. It is still a deterministic
adaptation benchmark, not an official patch-resolution score.

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

For a continuously running harness, read `GET /v1/learning` or
`learner.snapshot()` and use its `economics` object. It reports recorded
frontier/Jev tokens, estimated tokens avoided by successful replays, and a
paired-equivalent token reduction. Keep the estimate separate from provider
billing because it is derived from local trajectory observations; use a paired
harness trial when evaluator overhead needs to be isolated.

For a paired actor-cost comparison, provide the actor's measured average token
usage and current rates explicitly. The command then reports baseline versus
actual provider tokens and cost-per-run; without these flags it reports only
real Jev usage and leaves actor cost unknown:

```sh
npm run bench:live-learning -- --instances 2 --repetitions 4 \
  --actor-input-tokens 1800 --actor-output-tokens 140 \
  --actor-input-rate 3 --actor-output-rate 15 \
  --jev-input-rate 0.5 --jev-output-rate 2
```

The latest checked-in live sample is summarized in
[docs/live-learning-2026-09-20.md](live-learning-2026-09-20.md). It reduced
12 Jev calls to 6 across three prompts while retaining 100% learned-route
coverage. Install the official evaluator wrapper separately when preparing a
Docker-backed run:

The newest two-task live sample is summarized in
[docs/live-learning-2026-09-21.md](live-learning-2026-09-21.md). It reduced
Jev calls from 8 to 4 and preserved 100% fixture success. With explicitly
supplied actor-token and provider-rate assumptions, modeled provider cost fell
from $0.060000 to $0.001301; the assumed actor usage is not provider telemetry.

The latest paired sample, which combines observed Jev usage with explicitly
supplied actor assumptions, is summarized in
[docs/live-paired-2026-09-20.md](live-paired-2026-09-20.md). It reduced both
Jev and actor calls on a three-repetition fixture while preserving the fixture
verifier result; the actor tokens remain assumptions, not provider telemetry.

For a real frontier-actor learning run, use the installed Codex CLI in a
temporary read-only workspace:

```sh
npm run bench:live-codex -- --instances 1 --repetitions 3
```

This runs the same SWE-bench-derived decision prompt against Codex for the
actor-only arm and for JBrancher warm-up attempts. Later attempts use the
project-local learned route. Codex usage is observed from its JSON event stream;
pass `--actor-input-rate` and `--actor-output-rate` to add a cost estimate.
Add `--assert` to fail the run if success, learned-route coverage, or token
savings regress.
The benchmark never grants write access to the repository and removes its
temporary learning store after the run.
The one-task pilot is in [docs/live-codex-2026-09-20.md](live-codex-2026-09-20.md),
and the larger three-task sample is in
[docs/live-codex-3tasks-2026-09-20.md](live-codex-3tasks-2026-09-20.md).
The latest one-task run with the current learner is in
[docs/live-codex-2026-09-21.md](live-codex-2026-09-21.md); it preserved 100%
fixture success while saving 15,977 observed Codex provider tokens.

To measure live frontier usage for the parameterized action-template learner:

```sh
npm run bench:live-codex-template -- --values 3 --assert
```

This is an experimental opt-in run. It requires the local Codex CLI and is not
part of CI because it consumes provider quota.

The latest three-task run is in
[docs/live-codex-3tasks-2026-09-21.md](live-codex-3tasks-2026-09-21.md); it
reduced Codex actor calls by 50% and saved 95,717 observed provider tokens
while preserving 100% task success and route coverage.
The latest seven-task run is in
[docs/live-codex-7tasks-2026-09-21.md](live-codex-7tasks-2026-09-21.md); it
reduced Codex actor calls from 28 to 14 and saved 223,413 observed provider
tokens while preserving 100% task success and learned-route coverage.
The experimental live argument-template pilot is in
[docs/live-codex-template-2026-09-21.md](live-codex-template-2026-09-21.md);
it reduced actor calls from 3 to 2, saved 15,923 observed provider tokens, and
replayed an unseen query after two verified teaching episodes. Its independently
sampled actor-only arm was not a perfect oracle in that small run, so it is
evidence of replay/cost behavior, not a model-quality estimate.
The latest four-value run is in
[docs/live-codex-template-4values-2026-09-20.md](live-codex-template-4values-2026-09-20.md);
it reduced actor calls from 4 to 2, saved 31,959 observed provider tokens,
and served both novel values locally with 100% learned-route coverage. The
benchmark now records semantically wrong frontier actions as failed teaching
postconditions and retries bounded teaching episodes instead of crashing.
The current-model compatibility run is in
[docs/live-jev-latest-2026-09-21.md](live-jev-latest-2026-09-21.md); it used
`jev-latest`, observed the concrete serving revision, and preserved 100% route
coverage and task success.

To exercise the same learning path through the language-agnostic HTTP proxy,
run:

```sh
npm run bench:live-codex-proxy -- --instances 1 --repetitions 3 \
  --actor-input-rate 3 --actor-output-rate 15
```

This keeps Codex as the frontier fallback, sends every route decision through
the local proxy, and records real Codex usage plus learned-route completion
feedback. It is opt-in and requires the local Codex CLI; it is not part of CI.
The checked-in one-task result is in
[docs/live-codex-proxy-2026-09-20.md](live-codex-proxy-2026-09-20.md).

```sh
python -m pip install -r benchmarks/requirements.txt
```

For the Pi-specific route-choice path, run the similarly bounded live check:

```sh
npm run bench:live-pi-learning -- --instances 1 --repetitions 4
```

It promotes a preference only when the deterministic route verifier returns
the expected result, then reports real Jev calls, usage, and learned coverage.
The evaluator uses a Choice distribution with a no-match option. To reproduce
the full checked-in calibration run with assertions:

```sh
npm run bench:live-pi-learning -- --instances 14 --repetitions 4 \
  --min-probability 0.45 --min-margin 0.05 --assert
```

The threshold values are measured for this fixture and should be recalibrated
against a harness-native validation set before being used for side effects.
The latest three-task sample is summarized in
[docs/live-pi-3tasks-2026-09-20.md](live-pi-3tasks-2026-09-20.md), and the full
14-task result is in
[docs/live-pi-14tasks-2026-09-20.md](live-pi-14tasks-2026-09-20.md).

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

Harbor's current custom-agent boundary is a `BaseAgent` with `name()`,
`version()`, async `setup(environment)`, and async
`run(instruction, environment, context)` methods. A Python adapter can call
JBrancher's local `POST /v1/decide` endpoint when it has a bounded candidate
set, execute the selected action in Harbor's environment, and post the
completed open-world trajectory to `POST /v1/episodes`. That makes unknown
routes learnable without making the benchmark harness depend on a JavaScript
runtime. JBrancher ships a dependency-free Python proxy client, an async
`JBrancherHarborLoop`, and an optional `JBrancherHarborAgent` base class. When
Harbor is installed, the latter implements the current `BaseAgent` boundary;
when Harbor is absent, the module remains importable for local adapter tests.
The class accepts the frontier callback, environment executor, and optional
postcondition verifier through overridable hooks. This bridge is not an
assertion that Harbor has already been run in this repository.

The CI `harbor-compat` job installs the pinned current Harbor package
(`harbor==0.23.0`) and verifies that `JBrancherHarborAgent` is a real
`BaseAgent` subclass. This checks the Python integration boundary without
requiring Docker. A full Terminal-Bench run still requires a local Docker
daemon and a real frontier agent.

When a task has no registered candidate set, the adapter may omit `candidates`
or send `[]`. The proxy returns a safe `abstain/unmatched` decision; the
frontier actor remains owned by the harness, and its completed tool trajectory
becomes the next local dataset example.

For workflows with multiple actions, send the host's per-step capability
catalog to `POST /v1/workflow`. It returns a learned workflow only when every
step remains authorized. Otherwise it abstains and the harness should execute
the frontier path, then submit the complete trajectory to `/v1/episodes`.

Minimal loop shape inside a Harbor agent:

```python
from integrations.python import JBrancherHarborLoop, JBrancherProxy

loop = JBrancherHarborLoop(JBrancherProxy(), source="harbor-jbrancher")
result = await loop.step(
    instruction,
    state,
    candidates=legal_actions_or_none,
    frontier=frontier_actor,
    execute=environment_executor,
    verify=postcondition_verifier,
)
```

Minimal direct `BaseAgent` shape:

```python
from integrations.python import JBrancherHarborAgent

class MyAgent(JBrancherHarborAgent):
    async def frontier_action(self, instruction, state, decision, environment, context):
        return await frontier_model(instruction, state, decision)

    async def candidate_actions(self, instruction, state, history, environment, context):
        return await authorized_actions(environment, state)
```

Run the local proxy in the same reachable environment first:

```sh
npx jbrancher proxy --learning-dir .jbrancher
```

Then pass `JBRANCHER_PROXY_URL` if Harbor runs the agent in a separate
container. The adapter records each completed frontier workflow locally and
replays a route only when the current action catalog authorizes it.

Use `loop.run(...)` when the harness wants one complete multi-step episode in
the local dataset; pass `candidate_steps` for workflow replay and `observe` to
return the post-action state for each step.

For learned decisions, include the returned `routeId` in the completion
episode. A successful completion increments the local route's replay counter;
the same feedback path lets a harness preserve failed-route evidence and fall
back to its frontier recovery policy. Mark the episode as `outcome: "failure"`
or `routeResolution: "failed"` when the learned route's postcondition fails;
the proxy quarantines that route before the next decision.

Keep the proxy in its default read-only promotion mode for general workloads.
Use `--learning-allow-verified` only when the harness supplies
`finishMetadata.postconditionValidated: true` after its own verifier passes.

The initial run should be small and paired:

```sh
harbor run -d "terminal-bench/terminal-bench-2" \
  --agent path.to.jbrancher_agent:JBrancherAgent \
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
