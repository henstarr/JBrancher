# JevBrancher: product and launch plan

Prepared 2026-09-17. Planning deliverable; no package, remote repository, release, or paid evaluation was created by this review.

## 1. Recommendation

Build an installable decision runtime that removes unnecessary actor calls: **rules first, Jev for bounded semantic choices, the existing actor for everything else**. Pair it with a local comparison report that lets users measure whether it helps their own harness.

Suggested positioning: **“Skip unnecessary agent model calls. Keep your existing harness.”** Supporting line: “Rules, Jev routing, and actor fallback—with replayable traces and measured cost per successful task.” Treat savings as something the runtime measures, not a universal promise.

Target developers who own a JavaScript/TypeScript agent loop and pay for repeated tool-selection or recovery decisions. Start with a generic loop adapter and one complete reference application. General command generation and closed harness integrations come later.

Use JevBrancher as the independent product identity. Build a clean repository informed by the reviewed experiments, with its own implementation, history, documentation, and release process.

## 2. What the inspected repository establishes

Reviewed source revision: `c18b0a8d4abf3952a11a095ec14cfb7b7bdf1357` of [MNWinn/agent-switchboard](https://github.com/MNWinn/agent-switchboard).

The following are **repository-reported live results**, not independently rerun provider experiments:

| Experiment | Observed outcome | Product implication |
| --- | --- | --- |
| Initial blocking pilot | Baseline 4/4 passes; treatment 0/4. Nine valid actions blocked; combined tokens increased 43.66%. | A semantic score must not silently become an authorization gate. Untuned thresholds can make an otherwise capable agent fail. |
| Always-on symbolic steering | Both arms 4/4 passes; actor tokens fell about 37%, but combined tokens rose to 3.07 times baseline. | Actor token reduction alone is an inadequate success metric. |
| Selective symbolic steering | Both arms 4/4 passes; fewer actions, but combined tokens about 46% above baseline. | Selectivity reduces overhead; it does not establish net value by itself. |
| Simple Astra runs | No Jev calls in the clean task; ten calls and zero decision changes in the sequence task. Estimated costs increased roughly 1.15% and 2.55%, respectively. | Unneeded evaluator calls add overhead even when they return valid decisions. |
| Harbor post-execution pilot | Both tasks passed final graders, but both treatment runs hit the 30-turn limit. Git completion was deferred 24 times. | Preserve durable evidence and measure clean termination separately from artifact correctness. |
| Local file-repair cascade | Six repetitions per arm on one tiny task. Jev-first averaged about 86% lower estimated cost and 59% lower wall time than actor plus deterministic completion. | Putting selection before actor inference can remove calls. This task also admits a fully deterministic solution, so this is mechanism evidence. |
| Native regex stress batch | Fifteen attempts, five conditions, all passed. Jev cost $0.029197 versus $0.036477 for automatic completion; full deterministic routing cost $0.027453. | Jev saved about 20% against the partial rules control; stronger rules were cheapest. |
| Compact regex routing | Evaluator tokens fell, but every decision fell back; average cost rose to $0.038248. Question/context and threshold both changed. | Optimize the entire cascade and isolate variables; smaller prompts can erase savings. |

Source documents: [first pilot](https://github.com/MNWinn/agent-switchboard/blob/main/docs/first-live-pilot.md), [steering](https://github.com/MNWinn/agent-switchboard/blob/main/docs/steering.md), [Astra pilots](https://github.com/MNWinn/agent-switchboard/blob/main/docs/astra-pilot.md), [Harbor results](https://github.com/MNWinn/agent-switchboard/blob/main/benchmarks/post-execution-pilot-results.md), [local cascade](https://github.com/MNWinn/agent-switchboard/blob/main/docs/local-efficiency-results.md), [regex stress batch](https://github.com/MNWinn/agent-switchboard/blob/main/docs/native-stress-results.md).

Independent checks in this review: `node --test` discovered 93 tests: **92 passed, zero failed, one skipped**. The skipped test needs the macOS native sandbox and downloaded benchmark dataset. Python/Harbor integration and paid providers were not executed. Source inspection confirms a private npm package, no LICENSE file in the checkout, Linux-only JavaScript CI, and experiment-specific runtime code. Linked `results/` reports are absent from the public checkout. Existing summaries are useful, but their raw provenance cannot currently be audited by a new visitor.

## 3. Precisely define “drop-in”

Offer three compatibility levels, each with an explicit badge:

1. **Observe:** capture events and compare shadow decisions. Does not claim savings from skipped calls because none are skipped.
2. **Advise:** suggest next actions or evaluate proposals. Helpful for diagnostics; the actor call may already have happened.
3. **Accelerate:** intercept before actor inference, execute an eligible bounded action, and synchronize the result back into harness state. This is the savings path.

An MCP tool alone does not provide level 3: the actor normally needs to decide to call it. A model API proxy sees model traffic, but may lack tool state, executor access, and lifecycle hooks. Neither should be marketed as universally accelerating arbitrary harnesses. Every adapter must declare its actual capabilities and tested versions.

Proposed integration shape, **not an existing API**:

```ts
const board = createSwitchboard({
  mode: 'shadow',
  rules,
  evaluator: jev({ model: configuredModel }),
  candidates: harness.getBoundedCandidates,
  actor: harness.nextAction,
  executor: harness.executeAuthorized,
  evidence: harness.getEvidence,
  record: traceStore.append,
});

const transition = await board.step(harness.snapshot());
await harness.applyTransition(transition);
```

The integration contract must require the same authorized execution path for actor- and Jev-selected actions. A skipped actor turn must still add the executed action, tool result, state revision, and remaining budget to subsequent actor context. Adapters must map synthetic events into valid provider message sequences rather than fabricating unmatched tool-call IDs.

## 4. Runtime architecture and invariants

The decision sequence:

1. Snapshot current task, observed facts, relevant tool results, state revision, and evidence references.
2. Enforce deterministic preconditions and recognize registered completion conditions.
3. Apply rules that settle known mechanical next steps.
4. Generate valid, fully bound candidates without invoking the expensive actor.
5. If there are no useful candidates or insufficient context, invoke the actor directly.
6. Ask Jev the narrow questions needed to choose among candidates, including abstention.
7. Apply versioned routing thresholds and per-run evaluation budgets.
8. Recheck state freshness and deterministic permissions; execute through the harness.
9. Record the transition, invalidate affected evidence, update actor history, and repeat.

If candidate generation invokes the frontier model on every step, the claimed skipped call may simply move elsewhere. Account for all candidate-generation costs. Candidate sources should be registered recipes, existing plans, parsed tool outputs, or known checks; arbitrary novel commands return to the actor.

Separate these responsibilities in the public contract:

| Component | Responsibility |
| --- | --- |
| State projector | Bounded relevant context with provenance; distinguish observations from model claims. |
| Candidate provider | Return fully specified allowed actions and a fallback option. |
| Rules | Deterministic routing and execution permissions. |
| Evaluator | Semantic selection; Noul probability, Choice distribution, and Score values retain their different meanings. |
| Router | Select rule, Jev, actor, or existing human workflow without expanding permissions. |
| Evidence store | Bind checks to artifact/dependency revision, command, environment, and policy version. |
| Executor | Existing harness tools, cancellation semantics, and isolation. |
| Ledger | All inference attempts, usage, unknown costs, fallback reasons, and execution outcome. |

Key behavior:

- A Jev timeout, malformed answer, or abstention returns control to the normal actor. It does not bypass a permission denial.
- Confirmed completion requires the application's declared completion contract; a passing development probe does not automatically prove the whole user task is done.
- Preserve useful verification beyond rolling context windows. Invalidate on relevant dependency or environment changes, not just output text changes.
- Never let repeated low semantic completion scores create unbounded finish deferrals.
- Bound evaluator calls, repeated actions, fallback cycles, and total workflow steps. Reserve budget before dispatch; retain unknown billed usage after cancellation.
- Do not replay a side effect after an ambiguous timeout. Return an indeterminate execution state for reconciliation.
- Start with one serialized decision per run. Separate runs can execute concurrently; distributed coordination is outside v0.1.
- Keep raw traces local by default, with explicit export/redaction and configurable retention. Pass only necessary state to providers.

## 5. Initial release scope

Ship v0.1 as a usable developer beta with a clearly supported configuration:

- Installable npm library with TypeScript declarations, stable entry points, and one CLI.
- JavaScript/TypeScript custom-loop adapter; Jev evaluator; existing actor callback preserved.
- Rules-only, shadow, and accelerate modes, with side-by-side explanations of their effects.
- Three reusable recipes: run a known check after a relevant artifact change; recognize verified completion; choose among registered recovery actions after a failure.
- A reference repair workflow containing distinct error categories and genuine abstention cases. Explicitly label synthetic cases.
- A no-key offline walkthrough, optional bounded live example, and local HTML/JSON comparison report.
- Durable per-run traces, price provenance, budget caps, cancellation, and public evidence bundles.
- Existing Harbor adapter retained as experimental until completion-loop fixes and integration tests pass.

Defer a hosted dashboard, a universal shell planner, automatic policy training, distributed executors, a broad Python SDK, and claims of compatibility with every coding assistant. Add a second framework adapter only after observing demand and validating its pre-inference hook.

## 6. First-use experience

Target: a developer understands the mechanism in one minute, completes an offline demo in five minutes, and integrates a supported custom loop in thirty minutes. These are usability targets to test, not current promises.

Proposed commands, subject to package-name availability:

```sh
npx jevbrancher demo
npx jevbrancher doctor
npx jevbrancher init
npx jevbrancher compare --config jevbrancher.config.ts
```

`demo` uses deterministic fixtures, requires no credentials, makes no inference savings claim, and prints the result location. `doctor` checks Node, environment variable presence without values, provider configuration, adapter capabilities, and writable output location. `init` creates a minimal configuration with shadow mode. `compare` defaults to offline replay; live mode requires an explicit flag and displayed bounded budget.

The live example should show three lanes: actor baseline, strong deterministic routing, and rules plus Jev. Each displays outcome, clean finish, actor calls, evaluator calls, elapsed time, and complete or unknown estimated cost. Replay must be marked replay; live must be marked live.

Observe where five outside developers get stuck. Ship only after at least four complete the quickstart without maintainer intervention. Document network-dependent provider access separately from installation success.

## 7. Evidence and benchmark plan

Preserve every existing positive and negative experiment in an experiment registry. Recover original raw reports from their owner, redact and inspect them, then publish immutable bundles with checksums. If unavailable, label the result “summary only” and do not imply independent reproduction.

Use four controls for the next frozen experiment:

1. Existing actor loop.
2. Actor with automatic completion.
3. Actor with strong deterministic routing and completion.
4. Identical rules plus selective Jev before actor inference.

The primary comparison is 4 versus 3. Later compare a low-cost alternative evaluator under the same interface to establish whether the result is Jev-specific. Keep the main initial experiment small enough to interpret.

Development pilot: 12 distinct tasks across repair, failure recovery, tool-result interpretation, and ambiguous next steps; three repetitions per arm. This is 144 attempts, not 144 independent tasks. Include easy rules-solved cases, cases where semantic judgment helps, missing-candidate cases, and cases requiring novel actor work. Freeze tasks, policies, context, thresholds, providers, budgets, ordering, and graders before execution. Estimate paid cost with a small bounded smoke run before allocating a confirmation budget.

Confirmation: use a separate collection of previously unused tasks. Set sample size from pilot variability and a declared success tolerance; a suggested starting success non-inferiority margin is two percentage points, but a small pilot cannot establish it. Do not promote a wide confidence interval into a claim of equal reliability. Task-level pairing and clustered intervals should avoid treating repetitions as independent tasks.

Report:

- Independent task success, clean termination, false completion, turn-cap hits, and execution-policy violations.
- Cost per successful task = all attempt costs, including failed tasks, divided by successes; unknown attempts make the total incomplete.
- Actor/evaluator calls, cached and uncached usage, retries, provider failures, p50/p95 latency, and time spent in candidate generation.
- Jev coverage, abstention rate, actor calls actually avoided, mistaken selections, and context-construction overhead.
- Performance per task family and aggregate, with every arm and failure retained.

Suggested promotional evidence gate: a prespecified held-out comparison shows at least 15% lower estimated cost per successful task against strong rules, while meeting the declared success tolerance and latency requirement. This is a proposed goal, not a predicted result. If unmet, release the useful runtime and negative result without a savings headline.

Break-even intuition: savings depend on the fraction of actor calls truly avoided times actor-call cost, minus evaluator, candidate generation, and extra recovery costs. Measure this using real trajectories; shadow disagreement alone cannot prove counterfactual savings.

## 8. Repository, documentation, and release engineering

Keep one package initially, with clear internal separation:

```text
src/                  runtime, rules, evidence, providers, adapters, tracing
cli/                  demo, doctor, init, compare, replay
examples/             offline, live repair, custom loop, recovery
docs/                 quickstart, concepts, integration, API, troubleshooting
benchmarks/           frozen configs, independent graders, summaries
evidence/             experiment registry and small sanitized fixtures
test/                 contract, lifecycle, accounting, adapter tests
.github/              CI, release workflow, issue templates
```

README order: value proposition; 30–45-second demo; working install command; minimal integration; what routing does; compact honest evidence table; supported adapters; limitations; contribution links; one star request. Put the failed pilots in linked evidence documentation, not out of sight.

Required documentation: installation; offline and live quickstarts; migration from current source imports; state and candidate contract; evidence invalidation; shadow-to-accelerate rollout; permissions versus routing; timeout/cancellation behavior; provider data handling; accounting and pricing; reproducible comparisons; supported adapter matrix; troubleshooting; API reference; architecture; versioning and changelog.

Concrete repository gaps to resolve:

- Add an owner-approved license before encouraging reuse; public source access is not a reuse license.
- Change `private: true` only for the release-ready package; add license/repository metadata, files allowlist, CLI bin, types, and exports.
- Remove stale `decision-gate/steering` documentation naming.
- Update outdated limitations claiming no actor adapter even though one exists.
- Replace machine-specific Python paths and sandbox assumptions with explicit platform support or portable adapters.
- Replace local `results/` dead links with published evidence or clear unavailable labels.
- Move historical development notes out of the supported setup path.
- Add CONTRIBUTING, SECURITY, support policy, issue/PR templates, CHANGELOG, and release notes.

CI must run Node 22/24 on Linux, macOS, and Windows for supported core paths; Python tests for the advertised Harbor bridge; TypeScript consumer compilation; formatting/static checks; documentation link checks; and a clean-install test against `npm pack`. Smoke-test every README command against the tarball, not repository-relative imports. Keep paid provider checks opt-in and separate from deterministic CI.

Release gate: fresh-machine demo passes; package imports and types work; cancellation/fallback/unknown-cost paths tested; no stale verification or repeated completion loops; evidence links resolve; supported integrations tested at declared versions; secrets excluded from package and evidence; tagged release matches published artifact. Use package provenance where supported by the chosen registry workflow.

## 9. Milestones and issue backlog

Planning estimate: 15 working days with two engineers and part-time evaluation/documentation support; external testing and confirmation budget can extend it. Sequence by acceptance gates rather than promising a calendar launch regardless of results.

| Milestone | Work | Owner | Exit condition |
| --- | --- | --- | --- |
| Days 1–2: foundation | Resolve ownership/license, freeze source/evidence inventory, finalize API and adapter contract. | Maintainer + runtime engineer | Reuse terms and supported scope explicit; baseline results indexed. |
| Days 3–5: runtime | Extract general pre-actor cascade; implement state synchronization, evidence invalidation, abstention, bounded fallback, accounting. | Runtime engineer | Offline lifecycle and regressions pass; no task-specific constants in core. |
| Days 4–7: experience | Package/CLI/types; cross-platform offline demo; custom-loop example; doctor. | Integration engineer | Tarball install and supported adapter work on fresh environments. |
| Days 6–10: evidence | Recovery task set; strong rules; pilot; failure review; freeze confirmation. | Evaluation lead | Auditable paired reports and tested grader separation. |
| Days 8–12: docs/beta | API/docs, demo recording, outside user trials, issue cleanup. | Maintainer + integration engineer | At least 4/5 independent users finish quickstart unassisted. |
| Days 11–15: launch | Confirmation if funded; evidence audit; release candidate; launch kit and support coverage. | Maintainer | Release checklist passes; claims match available evidence. |

Create issues with these acceptance criteria, not just titles: general step API; candidate contract; actor-history synchronization; evidence lifecycle; fallback/budget ledger; npm/CLI/types; offline demo; live example; artifact replay; evidence publication; strong deterministic controls; held-out evaluation; docs and link audit; OS matrix; beta onboarding; release and launch assets. Keep the first five runtime issues on the critical path.

## 10. Growth plan: make the evidence easy to see and the product easy to try

The strongest launch story is the engineering lesson: **“We put a fast decision model inside an agent loop. Some placements made it worse. Here is the runtime and evidence for the placements that can skip expensive calls.”** This differentiates the project without overclaiming broad speedups.

Suggested launch title: **“JevBrancher: rules-first routing for AI agents, with Jev fallback decisions and reproducible cost comparisons.”** If confirmation supports a stronger quantified headline, attach the task set, comparator, sample size, and date directly to it. Do not lead with “86% cheaper coding agents” from a single arithmetic microtask.

Before launch:

- Recruit 5–10 design partners who already own agent loops; prioritize successful integrations and permission to publish their findings.
- Produce a short terminal demo and static result image showing baseline, rules, Jev, and an uncertain case falling back.
- Prepare a technical article, README, release notes, sample result, and channel-specific short posts with one canonical repo link.
- Add a concise repository description, accurate topics, social preview, Discussions, and approachable documentation/example issues.

Launch day:

- Publish the tagged package and repository release together, with the offline demo already working.
- Share a technical writeup and demo on the team's existing developer channels and appropriate community launch threads, following their posting rules.
- Prepare a Show HN submission centered on a working artifact and inspectable results; request feedback on the actual approach.
- Invite TypeSafe and relevant harness maintainers to inspect or reproduce it. Seek genuine technical amplification, not guaranteed endorsement.
- Staff setup issues and questions during the initial response window. Fix broken quickstarts before expanding promotion.

Days 2–7: publish a failure-analysis article about completion loops; show an external integration; answer implementation questions; make one release based on real onboarding friction. Days 8–30: add the most-requested feasible adapter, publish confirmation or negative results, and feature community recipes with attribution.

One direct star request is appropriate: “Star the repo to follow new adapters and benchmark results.” Avoid bought stars, reciprocal-star groups, misleading benchmark badges, and repetitive cross-posting. The fastest defensible path is useful exposure followed by a successful first run.

Measure the funnel daily in launch week: repository visitors → demo starts where observable → successful quickstarts → real integrations → stars/contributors. GitHub traffic and package download counts have attribution limits; do not silently collect user code or traces. Optional feedback and design-partner interviews can establish activation without default telemetry.

Use planning scenarios, not promises: 5,000 qualified visitors at 5% visitor-to-star conversion yields 250 stars; 10,000 at 10% yields 1,000. These are arithmetic scenarios, not established conversion rates. Review 24-hour, 72-hour, and seven-day traffic and onboarding signals. Low traffic suggests distribution work; high traffic with poor adoption suggests README/demo friction; good activation with few returning users suggests limited practical value.

## 11. Decisions and boundaries

Recommended defaults: evolve the existing brand, npm-first, TypeScript-friendly JavaScript core, custom-loop adapter first, local reports, no mandatory hosted account, rules plus optional Jev, developer-beta designation, and measured savings claims only.

Before implementation/release, resolve repository ownership, intended GitHub organization, license, npm publisher/name, and paid evaluation budget. These do not prevent planning or offline development. No public posting, package publication, paid run, or changes to the reviewed upstream were performed for this plan.

The immediate next milestone is a package-installable general cascade with a no-key demo and complete evidence accounting. The public launch can then offer a concrete artifact people can run while the benchmark program establishes where Jev adds value beyond rules.
