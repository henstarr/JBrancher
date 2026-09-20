import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createJBrancher } from '../src/index.js';

const cases = [
  {
    id: 'verify-written-artifact',
    task: 'Confirm the generated artifact passes its checks.',
    state: { written: true, verified: false },
    candidates: [{ tool: 'verify', args: {} }, { tool: 'repair', args: {} }, null],
    scores: [0.96, 0.21, 0.04],
    expected: { tool: 'verify', args: {} }
  },
  {
    id: 'repair-failed-check',
    task: 'Repair the artifact after the check failed.',
    state: { written: true, verified: false, checkFailed: true },
    candidates: [{ tool: 'verify', args: {} }, { tool: 'repair', args: {} }, null],
    scores: [0.19, 0.94, 0.03],
    expected: { tool: 'repair', args: {} }
  },
  {
    id: 'finish-verified-artifact',
    task: 'Finish because the artifact is already verified.',
    state: { written: true, verified: true },
    candidates: [{ tool: 'verify', args: {} }, null],
    scores: [0.08, 0.97],
    expected: null,
    rule: true
  },
  {
    id: 'inspect-before-edit',
    task: 'Inspect the target before making a change.',
    state: { inspected: false },
    candidates: [{ tool: 'inspect', args: {} }, { tool: 'edit', args: {} }, null],
    scores: [0.89, 0.54, 0.08],
    expected: { tool: 'inspect', args: {} }
  },
  {
    id: 'uncertain-edit-or-verify',
    task: 'Decide whether to edit or verify when the state is ambiguous.',
    state: { inspected: true, ambiguous: true },
    candidates: [{ tool: 'edit', args: {} }, { tool: 'verify', args: {} }, null],
    scores: [0.68, 0.66, 0.05],
    expected: { tool: 'verify', args: {} }
  },
  {
    id: 'finish-empty-work',
    task: 'Finish when no work remains.',
    state: { remaining: false },
    candidates: [{ tool: 'inspect', args: {} }, null],
    scores: [0.04, 0.95],
    expected: null,
    rule: true
  },
  {
    id: 'run-tests-after-edit',
    task: 'Run tests after the edit completes.',
    state: { edited: true, testsRun: false },
    candidates: [{ tool: 'run_tests', args: {} }, { tool: 'edit', args: {} }, null],
    scores: [0.93, 0.17, 0.05],
    expected: { tool: 'run_tests', args: {} }
  },
  {
    id: 'repair-then-verify',
    task: 'Repair the failing output before verifying it.',
    state: { checkFailed: true, repaired: false },
    candidates: [{ tool: 'repair', args: {} }, { tool: 'verify', args: {} }, null],
    scores: [0.92, 0.26, 0.03],
    expected: { tool: 'repair', args: {} }
  }
];

const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function summarize(mode, rows, elapsedMs) {
  const correct = rows.filter(row => row.correct).length;
  const actorCalls = rows.reduce((total, row) => total + row.actorCalls, 0);
  const evaluatorCalls = rows.reduce((total, row) => total + row.evaluatorCalls, 0);
  const sourceCounts = {};
  for (const row of rows) sourceCounts[row.source] = (sourceCounts[row.source] ?? 0) + 1;
  return {
    mode,
    tasks: rows.length,
    correctDecisions: correct,
    decisionAccuracy: Number((correct / rows.length).toFixed(3)),
    actorCalls,
    actorCallsAvoidedVsActorOnly: rows.length - actorCalls,
    evaluatorCalls,
    sourceCounts,
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
      return { action: item.expected, usage: [{ provider: 'synthetic-actor', status: 'succeeded' }] };
    };
    let result;
    if (mode === 'actor-only') {
      result = { source: 'actor', ...(await actor()) };
    } else {
      const brancher = createJBrancher({
        rules: mode === 'rules' || mode === 'jbrancher' ? [() => item.rule
          ? { action: item.expected, reason: 'synthetic completion rule' }
          : null] : [],
        getCandidates: () => item.candidates,
        evaluate: mode === 'jbrancher' ? async () => {
          evaluatorCalls += 1;
          return { scores: item.scores, usage: [{ provider: 'synthetic-jev', status: 'succeeded' }] };
        } : undefined,
        actor
      });
      result = await brancher.decide({ task: item.task, state: item.state });
    }
    rows.push({
      id: item.id,
      expected: item.expected,
      selected: result.action ?? null,
      source: result.source,
      correct: equal(result.action ?? null, item.expected),
      actorCalls,
      evaluatorCalls
    });
  }
  return summarize(mode, rows, performance.now() - started);
}

const report = {
  benchmark: 'JBrancher offline routing fixture',
  generatedAt: new Date().toISOString(),
  caveat: 'Synthetic control benchmark; no provider requests and no end-to-end task completion claims.',
  controls: [
    await runMode('actor-only'),
    await runMode('rules'),
    await runMode('jbrancher')
  ]
};

if (process.argv.includes('--assert')) {
  const [actorOnly, rules, jbrancher] = report.controls;
  const failures = [];
  if (report.controls.some(control => control.decisionAccuracy !== 1)) failures.push('decision accuracy regressed');
  if (rules.actorCalls >= actorOnly.actorCalls) failures.push('rules did not avoid an actor call');
  if (jbrancher.actorCalls >= actorOnly.actorCalls) failures.push('JBrancher did not avoid an actor call');
  if (jbrancher.evaluatorCalls < 1) failures.push('JBrancher evaluator was not exercised');
  if (failures.length) throw new Error(`Offline benchmark assertions failed: ${failures.join('; ')}`);
}

const writeIndex = process.argv.indexOf('--write');
if (writeIndex !== -1 && process.argv[writeIndex + 1]) {
  const path = process.argv[writeIndex + 1];
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
