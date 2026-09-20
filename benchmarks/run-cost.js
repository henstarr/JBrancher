import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createJBrancher } from '../src/index.js';

// The same actor, task fixture, and completion oracle are used for every arm.
// Token counts are synthetic controls; pass provider rates to estimate dollars.
const cases = [
  {
    id: 'verify-written-artifact',
    task: 'Confirm the generated artifact passes its checks.',
    state: { written: true, verified: false },
    candidates: [{ tool: 'verify', args: {} }, { tool: 'repair', args: {} }, null],
    scores: [0.96, 0.21, 0.04],
    expected: { tool: 'verify', args: {} },
    rule: false,
    actorInputTokens: 1240,
    actorOutputTokens: 96,
    jevInputTokens: 218,
    jevOutputTokens: 18
  },
  {
    id: 'repair-failed-check',
    task: 'Repair the artifact after the check failed.',
    state: { written: true, verified: false, checkFailed: true },
    candidates: [{ tool: 'verify', args: {} }, { tool: 'repair', args: {} }, null],
    scores: [0.19, 0.94, 0.03],
    expected: { tool: 'repair', args: {} },
    rule: false,
    actorInputTokens: 1280,
    actorOutputTokens: 104,
    jevInputTokens: 224,
    jevOutputTokens: 18
  },
  {
    id: 'finish-verified-artifact',
    task: 'Finish because the artifact is already verified.',
    state: { written: true, verified: true },
    candidates: [{ tool: 'verify', args: {} }, null],
    scores: [0.08, 0.97],
    expected: null,
    rule: true,
    actorInputTokens: 930,
    actorOutputTokens: 62,
    jevInputTokens: 190,
    jevOutputTokens: 16
  },
  {
    id: 'inspect-before-edit',
    task: 'Inspect the target before making a change.',
    state: { inspected: false },
    candidates: [{ tool: 'inspect', args: {} }, { tool: 'edit', args: {} }, null],
    scores: [0.89, 0.54, 0.08],
    expected: { tool: 'inspect', args: {} },
    rule: false,
    actorInputTokens: 1180,
    actorOutputTokens: 92,
    jevInputTokens: 216,
    jevOutputTokens: 18
  },
  {
    id: 'uncertain-edit-or-verify',
    task: 'Decide whether to edit or verify when the state is ambiguous.',
    state: { inspected: true, ambiguous: true },
    candidates: [{ tool: 'edit', args: {} }, { tool: 'verify', args: {} }, null],
    scores: [0.68, 0.66, 0.05],
    expected: { tool: 'verify', args: {} },
    rule: false,
    actorInputTokens: 1320,
    actorOutputTokens: 108,
    jevInputTokens: 236,
    jevOutputTokens: 18
  },
  {
    id: 'finish-empty-work',
    task: 'Finish when no work remains.',
    state: { remaining: false },
    candidates: [{ tool: 'inspect', args: {} }, null],
    scores: [0.04, 0.95],
    expected: null,
    rule: true,
    actorInputTokens: 900,
    actorOutputTokens: 58,
    jevInputTokens: 184,
    jevOutputTokens: 16
  },
  {
    id: 'run-tests-after-edit',
    task: 'Run tests after the edit completes.',
    state: { edited: true, testsRun: false },
    candidates: [{ tool: 'run_tests', args: {} }, { tool: 'edit', args: {} }, null],
    scores: [0.93, 0.17, 0.05],
    expected: { tool: 'run_tests', args: {} },
    rule: false,
    actorInputTokens: 1210,
    actorOutputTokens: 94,
    jevInputTokens: 214,
    jevOutputTokens: 18
  },
  {
    id: 'repair-then-verify',
    task: 'Repair the failing output before verifying it.',
    state: { checkFailed: true, repaired: false },
    candidates: [{ tool: 'repair', args: {} }, { tool: 'verify', args: {} }, null],
    scores: [0.92, 0.26, 0.03],
    expected: { tool: 'repair', args: {} },
    rule: false,
    actorInputTokens: 1260,
    actorOutputTokens: 101,
    jevInputTokens: 222,
    jevOutputTokens: 18
  }
];

const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function usageTotal(usage, field) {
  return (usage || []).reduce((total, item) => total + (Number.isSafeInteger(item?.[field]) ? item[field] : 0), 0);
}

function numberFlag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}

function summarize(mode, rows, elapsedMs) {
  const successfulTasks = rows.filter(row => row.success).length;
  const actorCalls = rows.reduce((total, row) => total + row.actorCalls, 0);
  const evaluatorCalls = rows.reduce((total, row) => total + row.evaluatorCalls, 0);
  const actorInputTokens = rows.reduce((total, row) => total + row.actorInputTokens, 0);
  const actorOutputTokens = rows.reduce((total, row) => total + row.actorOutputTokens, 0);
  const evaluatorInputTokens = rows.reduce((total, row) => total + row.evaluatorInputTokens, 0);
  const evaluatorOutputTokens = rows.reduce((total, row) => total + row.evaluatorOutputTokens, 0);
  return {
    mode,
    tasks: rows.length,
    successfulTasks,
    taskSuccessRate: Number((successfulTasks / rows.length).toFixed(3)),
    actorCalls,
    evaluatorCalls,
    actorInputTokens,
    actorOutputTokens,
    evaluatorInputTokens,
    evaluatorOutputTokens,
    providerInputTokens: actorInputTokens + evaluatorInputTokens,
    providerOutputTokens: actorOutputTokens + evaluatorOutputTokens,
    providerTokens: actorInputTokens + actorOutputTokens + evaluatorInputTokens + evaluatorOutputTokens,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    rows
  };
}

async function runMode(mode) {
  const started = performance.now();
  const rows = [];
  for (const item of cases) {
    let actorCalls = 0;
    let evaluatorCalls = 0;
    const actor = async () => {
      actorCalls += 1;
      return {
        action: item.expected,
        usage: [{ provider: 'synthetic-actor', status: 'succeeded',
          inputTokens: item.actorInputTokens, outputTokens: item.actorOutputTokens }]
      };
    };
    const evaluate = async () => {
      evaluatorCalls += 1;
      return {
        scores: item.scores,
        usage: [{ provider: 'synthetic-jev', status: 'succeeded',
          inputTokens: item.jevInputTokens, outputTokens: item.jevOutputTokens }]
      };
    };

    let event;
    if (mode === 'actor-only') {
      const decision = await actor();
      event = { decision: { source: 'actor', ...decision } };
    } else {
      const brancher = createJBrancher({
        rules: mode === 'rules' || mode === 'jbrancher'
          ? [() => item.rule ? { action: item.expected, reason: 'synthetic completion rule' } : null]
          : [],
        getCandidates: () => item.candidates,
        evaluate: mode === 'jbrancher' ? evaluate : undefined,
        actor,
        execute: async () => ({ ok: true })
      });
      event = await brancher.step({ task: item.task, state: item.state });
    }

    const decision = event.decision;
    const selected = decision.action ?? null;
    const success = equal(selected, item.expected);
    const actorUsage = decision.source === 'actor' ? decision.usage : [];
    const evaluatorUsage = decision.evaluation?.usage ?? [];
    rows.push({
      id: item.id,
      source: decision.source,
      expected: item.expected,
      selected,
      success,
      actorCalls,
      evaluatorCalls,
      actorInputTokens: usageTotal(actorUsage, 'inputTokens'),
      actorOutputTokens: usageTotal(actorUsage, 'outputTokens'),
      evaluatorInputTokens: usageTotal(evaluatorUsage, 'inputTokens'),
      evaluatorOutputTokens: usageTotal(evaluatorUsage, 'outputTokens')
    });
  }
  return summarize(mode, rows, performance.now() - started);
}

function estimateCost(summary, rates) {
  if (!rates || Object.values(rates).some(value => value === null)) return null;
  const cost = (summary.actorInputTokens * rates.actorInput
    + summary.actorOutputTokens * rates.actorOutput
    + summary.evaluatorInputTokens * rates.jevInput
    + summary.evaluatorOutputTokens * rates.jevOutput) / 1_000_000;
  return Number(cost.toFixed(8));
}

const rates = {
  actorInput: numberFlag('--actor-input-rate'),
  actorOutput: numberFlag('--actor-output-rate'),
  jevInput: numberFlag('--jev-input-rate'),
  jevOutput: numberFlag('--jev-output-rate')
};
const actorOnly = await runMode('actor-only');
const rules = await runMode('rules');
const jbrancher = await runMode('jbrancher');
const controls = [actorOnly, rules, jbrancher].map(summary => ({
  ...summary,
  estimatedCost: estimateCost(summary, rates)
}));
const baseline = controls[0];
const optimized = controls[2];
const report = {
  benchmark: 'JBrancher paired end-to-end cost and efficiency fixture',
  generatedAt: new Date().toISOString(),
  caveat: 'Synthetic actor, completion oracle, and token usage; use live paired harness trials for task-quality and provider-cost claims.',
  ratesPerMillionTokens: rates,
  comparison: {
    taskSuccessRatePreserved: optimized.taskSuccessRate >= baseline.taskSuccessRate,
    actorCallsAvoided: baseline.actorCalls - optimized.actorCalls,
    actorCallReduction: Number(((baseline.actorCalls - optimized.actorCalls) / baseline.actorCalls).toFixed(3)),
    providerTokensSaved: baseline.providerTokens - optimized.providerTokens,
    providerTokenReduction: Number(((baseline.providerTokens - optimized.providerTokens) / baseline.providerTokens).toFixed(3)),
    estimatedCostSaved: baseline.estimatedCost === null || optimized.estimatedCost === null
      ? null : Number((baseline.estimatedCost - optimized.estimatedCost).toFixed(8)),
    costPerSuccessfulTask: optimized.estimatedCost === null || optimized.successfulTasks === 0
      ? null : Number((optimized.estimatedCost / optimized.successfulTasks).toFixed(8))
  },
  controls
};

if (process.argv.includes('--assert')) {
  const failures = [];
  if (controls.some(control => control.taskSuccessRate !== 1)) failures.push('task success regressed');
  if (optimized.actorCalls >= baseline.actorCalls) failures.push('JBrancher did not avoid actor calls');
  if (optimized.providerTokens >= baseline.providerTokens) failures.push('JBrancher did not reduce provider tokens');
  if (optimized.evaluatorCalls < 1) failures.push('JBrancher evaluator was not exercised');
  if (failures.length) throw new Error(`Cost benchmark assertions failed: ${failures.join('; ')}`);
}

const writeIndex = process.argv.indexOf('--write');
if (writeIndex !== -1 && process.argv[writeIndex + 1]) {
  const path = process.argv[writeIndex + 1];
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
