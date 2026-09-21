#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJBrancher } from '../src/index.js';
import { createLocalLearningStore } from '../src/learning.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/swebench-lite-mini.json', import.meta.url), 'utf8'));

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

function integerFlag(name, fallback, minimum = 0) {
  const value = Number(flag(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

const repetitions = integerFlag('--repetitions', 4, 3);
const instanceCount = Math.min(integerFlag('--instances', fixture.instances.length, 1), fixture.instances.length);
const actorInputTokens = integerFlag('--actor-input-tokens', 1500);
const actorOutputTokens = integerFlag('--actor-output-tokens', 180);
const shouldAssert = process.argv.includes('--assert');
const instances = fixture.instances.slice(0, instanceCount);
const revokedInstance = instances.length > 1 ? instances.at(-1)?.instance_id : null;
const tokenCost = actorInputTokens + actorOutputTokens;

function expectedAction(instance) {
  return { tool: 'inspect', args: { instanceId: instance.instance_id } };
}

function sameAction(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createActor({ instance, calls }) {
  const action = expectedAction(instance);
  return async () => {
    calls.count++;
    return {
      action,
      usage: [{ provider: 'synthetic-frontier', inputTokens: actorInputTokens, outputTokens: actorOutputTokens }]
    };
  };
}

async function runBaseline() {
  const calls = { count: 0 };
  const rows = [];
  for (const instance of instances) {
    const brancher = createJBrancher({
      actor: createActor({ instance, calls }),
      execute: async action => ({ ok: sameAction(action, expectedAction(instance)), instanceId: instance.instance_id })
    });
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      const event = await brancher.step({ task: `${instance.instance_id}: inspect the failing test` });
      rows.push({ instance_id: instance.instance_id, repetition, source: event.decision.source,
        correct: sameAction(event.decision.action, expectedAction(instance)) && event.result?.ok === true });
    }
  }
  return { calls: calls.count, rows };
}

async function runLearning() {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-dynamic-authorization-'));
  try {
    const store = createLocalLearningStore({ directory });
    const calls = { count: 0 };
    const rows = [];
    let authorizationCalls = 0;
    for (const instance of instances) {
      const expected = expectedAction(instance);
      const brancher = createJBrancher({
        // Deliberately omit getCandidates: this is the capability under test.
        authorize: async ({ action, task }) => {
          authorizationCalls++;
          const permitted = instance.instance_id !== revokedInstance || !task.includes('revoke');
          return permitted && sameAction(action, expected);
        },
        actor: createActor({ instance, calls }),
        execute: async action => ({ ok: sameAction(action, expected), instanceId: instance.instance_id }),
        learningStore: store,
        learningSource: 'dynamic-authorization-benchmark',
        learningCwd: directory,
        learningPromotionMode: 'verified',
        learningOutcome: ({ events }) => events.every(event => event.result?.ok === true)
      });

      for (let repetition = 1; repetition <= repetitions; repetition++) {
        const task = `${instance.instance_id}: inspect the failing test${
          instance.instance_id === revokedInstance && repetition === repetitions ? ' and revoke' : ''}`;
        const event = await brancher.step({ task });
        rows.push({ instance_id: instance.instance_id, repetition, source: event.decision.source,
          correct: sameAction(event.decision.action, expected) && event.result?.ok === true,
          authorizationDenied: instance.instance_id === revokedInstance && repetition === repetitions
            && event.decision.source === 'actor' });
      }
    }
    const snapshot = await store.readTraces();
    const routes = await store.readRoutes();
    const usage = snapshot.flatMap(trace => trace.toolCalls || [])
      .flatMap(call => Array.isArray(call.context?.selection?.usage) ? call.context.selection.usage : [])
      .reduce((total, row) => total + (row.inputTokens || 0) + (row.outputTokens || 0), 0);
    const learnedRows = rows.filter(row => row.source === 'learned').length;
    return {
      calls: calls.count,
      rows,
      authorizationCalls,
      learnedRows,
      traces: snapshot.length,
      activeRoutes: routes.filter(route => route.status === 'active').length,
      recordedProviderTokens: usage
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const baseline = await runBaseline();
const learning = await runLearning();
const baselineCalls = instances.length * repetitions;
const avoidedCalls = baselineCalls - learning.calls;
const report = {
  benchmark: 'JBrancher dynamic authorization on SWE-bench-derived tasks',
  source: { url: fixture.sourceUrl, instances: instances.length, repetitions },
  caveat: 'Uses SWE-bench-derived task identities and a synthetic inspect action/oracle; measures local route learning, not official patch resolution.',
  baselineFrontierCalls: baselineCalls,
  actualFrontierCalls: learning.calls,
  avoidedFrontierCalls: avoidedCalls,
  frontierCallReduction: Number((avoidedCalls / baselineCalls).toFixed(3)),
  syntheticProviderTokens: {
    baseline: baselineCalls * tokenCost,
    actual: learning.calls * tokenCost,
    saved: avoidedCalls * tokenCost
  },
  learnedReplays: learning.learnedRows,
  activeRoutes: learning.activeRoutes,
  recordedEpisodes: learning.traces,
  recordedProviderTokens: learning.recordedProviderTokens,
  authorizationChecks: learning.authorizationCalls,
  revocation: {
    instanceId: revokedInstance,
    fallbacks: learning.rows.filter(row => row.authorizationDenied).length
  },
  routeCoverage: baseline.rows.every(row => row.correct) && learning.rows.every(row => row.correct),
  sourceCounts: {
    baseline: baseline.rows.reduce((counts, row) => ({ ...counts, [row.source]: (counts[row.source] || 0) + 1 }), {}),
    learning: learning.rows.reduce((counts, row) => ({ ...counts, [row.source]: (counts[row.source] || 0) + 1 }), {})
  }
};

if (shouldAssert) {
  assert.equal(report.baselineFrontierCalls, baselineCalls);
  // The template learner may generalize the instance-id slot across tasks, so
  // do not assume one route or two warm-ups per instance. Require a substantial
  // measured cold-to-warm improvement instead.
  assert.ok(report.learnedReplays >= Math.floor(baselineCalls / 2));
  assert.ok(report.activeRoutes >= 1);
  assert.equal(report.recordedEpisodes, report.actualFrontierCalls);
  assert.equal(report.revocation.fallbacks, revokedInstance ? 1 : 0);
  assert.equal(report.routeCoverage, true);
  assert.ok(report.frontierCallReduction >= 0.5);
  assert.equal(report.syntheticProviderTokens.saved, report.learnedReplays * tokenCost);
  assert.equal(report.recordedProviderTokens, report.syntheticProviderTokens.actual);
}

console.log(JSON.stringify(report, null, 2));
