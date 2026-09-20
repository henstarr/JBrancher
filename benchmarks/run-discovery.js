#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJBrancher } from '../src/index.js';
import { createOpenWorldLearner } from '../src/discovery.js';

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

const repetitions = Number(flag('--repetitions', '3'));
const actorInputTokens = Number(flag('--actor-input-tokens', '1800'));
const actorOutputTokens = Number(flag('--actor-output-tokens', '140'));
const shouldAssert = process.argv.includes('--assert');
if (!Number.isSafeInteger(repetitions) || repetitions < 3) throw new Error('--repetitions must be an integer >= 3');
if (!Number.isSafeInteger(actorInputTokens) || actorInputTokens < 0) throw new Error('--actor-input-tokens must be a non-negative integer');
if (!Number.isSafeInteger(actorOutputTokens) || actorOutputTokens < 0) throw new Error('--actor-output-tokens must be a non-negative integer');

const tasks = [
  { id: 'package', task: 'inspect package.json', action: { tool: 'read', args: { path: 'package.json' } } },
  { id: 'readme', task: 'inspect README.md', action: { tool: 'read', args: { path: 'README.md' } } },
  { id: 'source', task: 'inspect src/index.js', action: { tool: 'read', args: { path: 'src/index.js' } } }
];

const directory = await mkdtemp(join(tmpdir(), 'jbrancher-discovery-benchmark-'));
try {
  const learner = createOpenWorldLearner({ directory, source: 'discovery-benchmark' });
  let frontierCalls = 0;
  const rows = [];

  for (const item of tasks) {
    const brancher = createJBrancher({
      // The first frontier encounters are genuinely open-world: no route is
      // registered and the harness exposes no candidate. Once the harness's
      // capability catalog recognizes this action, learned replay is allowed.
      getCandidates: async ({ state }) => state.capabilitiesReady ? [item.action] : [],
      actor: async () => {
        frontierCalls++;
        return { action: item.action, usage: [{ inputTokens: actorInputTokens, outputTokens: actorOutputTokens }] };
      },
      execute: async () => `read ${item.id}`,
      learningStore: learner.store,
      learningSource: 'discovery-benchmark',
      learningCwd: directory,
      learningMinimumObservations: 2
    });

    for (let repetition = 1; repetition <= repetitions; repetition++) {
      const event = await brancher.step({
        task: item.task,
        state: { repository: 'fixture', repetition, capabilitiesReady: repetition >= 3 }
      });
      rows.push({ id: item.id, repetition, source: event.decision.source });
    }
  }

  const snapshot = await learner.snapshot();
  const routes = JSON.parse(await readFile(join(directory, 'routes.json'), 'utf8'));
  const baselineCalls = tasks.length * repetitions;
  const avoidedCalls = baselineCalls - frontierCalls;
  const baselineTokens = baselineCalls * (actorInputTokens + actorOutputTokens);
  const actualTokens = frontierCalls * (actorInputTokens + actorOutputTokens);
  const learnedRows = rows.filter(row => row.source === 'learned').length;
  const report = {
    benchmark: 'open-world-discovery',
    tasks: tasks.length,
    repetitions,
    baselineFrontierCalls: baselineCalls,
    actualFrontierCalls: frontierCalls,
    avoidedFrontierCalls: avoidedCalls,
    frontierCallReduction: baselineCalls ? avoidedCalls / baselineCalls : 0,
    syntheticProviderTokens: { baseline: baselineTokens, actual: actualTokens, saved: baselineTokens - actualTokens },
    learnedReplays: learnedRows,
    activeRoutes: routes.filter(route => route.status === 'active').length,
    datasetExamples: snapshot.traces,
    resolutions: snapshot.resolutions,
    outcomes: snapshot.outcomes,
    rows
  };

  if (shouldAssert) {
    assert.ok(report.activeRoutes >= tasks.length);
    assert.ok(report.learnedReplays >= tasks.length * (repetitions - 2));
    assert.equal(report.outcomes.success, report.actualFrontierCalls);
    assert.ok(report.frontierCallReduction >= 1 / 3);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
