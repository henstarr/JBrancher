#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJBrancher } from '../src/index.js';
import { createLocalLearningStore } from '../src/learning.js';

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

const actorInputTokens = Number(flag('--actor-input-tokens', '1600'));
const actorOutputTokens = Number(flag('--actor-output-tokens', '120'));
const shouldAssert = process.argv.includes('--assert');
if (!Number.isSafeInteger(actorInputTokens) || actorInputTokens < 0) {
  throw new Error('--actor-input-tokens must be a non-negative integer');
}
if (!Number.isSafeInteger(actorOutputTokens) || actorOutputTokens < 0) {
  throw new Error('--actor-output-tokens must be a non-negative integer');
}

const values = ['auth', 'billing', 'payments', 'reliability', 'security', 'performance'];
const directory = await mkdtemp(join(tmpdir(), 'jbrancher-template-benchmark-'));
try {
  const store = createLocalLearningStore({ directory });
  let frontierCalls = 0;
  const rows = [];

  for (const [index, value] of values.entries()) {
    const task = `lookup ${value} in docs`;
    const expected = { tool: 'lookup', args: { query: value, scope: 'docs' } };
    const brancher = createJBrancher({
      // The harness exposes the current action as legal. The action value is
      // intentionally new after the two teaching episodes.
      getCandidates: async () => [expected],
      actor: async () => {
        frontierCalls++;
        return { action: expected, usage: [{ inputTokens: actorInputTokens, outputTokens: actorOutputTokens }] };
      },
      execute: async action => {
        assert.deepEqual(action, expected);
        return `results for ${value}`;
      },
      learningStore: store,
      learningSource: 'template-benchmark',
      learningCwd: directory,
      learningPromotionMode: 'verified',
      learningMinimumObservations: 2,
      learningOutcome: () => true
    });
    const event = await brancher.step({ task, state: { scope: 'docs', index } });
    rows.push({ value, source: event.decision.source });
  }

  const routes = await store.readRoutes();
  const templateRoutes = routes.filter(route => route.matcher?.type === 'action-template');
  const learnedRows = rows.filter(row => row.source === 'learned').length;
  const baselineCalls = values.length;
  const baselineTokens = baselineCalls * (actorInputTokens + actorOutputTokens);
  const actualTokens = frontierCalls * (actorInputTokens + actorOutputTokens);
  const report = {
    benchmark: 'open-world-action-template-learning',
    teachingEpisodes: 2,
    novelEpisodes: values.length - 2,
    baselineFrontierCalls: baselineCalls,
    actualFrontierCalls: frontierCalls,
    avoidedFrontierCalls: baselineCalls - frontierCalls,
    frontierCallReduction: (baselineCalls - frontierCalls) / baselineCalls,
    syntheticProviderTokens: {
      baseline: baselineTokens,
      actual: actualTokens,
      saved: baselineTokens - actualTokens
    },
    templateRoutes: templateRoutes.map(route => ({
      id: route.id,
      status: route.status,
      verified: route.verified,
      observations: route.observations,
      matcher: route.matcher
    })),
    learnedReplays: learnedRows,
    rows
  };

  if (shouldAssert) {
    assert.equal(frontierCalls, 2);
    assert.equal(learnedRows, values.length - 2);
    assert.equal(templateRoutes.length, 1);
    assert.equal(templateRoutes[0].status, 'active');
    assert.equal(templateRoutes[0].verified, true);
    assert.equal(templateRoutes[0].observations, 2);
    assert.ok(report.frontierCallReduction >= 2 / 3);
    assert.equal(actualTokens, 2 * (actorInputTokens + actorOutputTokens));
    assert.ok(!JSON.stringify(await readFile(join(directory, 'routes.json'), 'utf8')).includes('payments'));
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}

