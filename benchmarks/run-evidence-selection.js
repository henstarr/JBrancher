#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJBrancher } from '../src/index.js';
import { createLocalLearningStore, refreshAndPromoteReadOnly } from '../src/learning.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/swebench-lite-mini.json', import.meta.url), 'utf8'));
const instance = fixture.instances[0];
const task = `${instance.instance_id}: ${instance.problem_statement}`;
const expectedPath = instance.fail_to_pass[0];

function successfulTrace(id, path) {
  return {
    id,
    task,
    cwd: '/swebench-fixture',
    source: 'evidence-selection-benchmark',
    outcome: 'success',
    routeResolution: 'unmatched',
    toolCalls: [{
      toolCallId: id,
      toolName: 'read',
      input: { path },
      ok: true,
      output: `inspected ${path}`,
      context: { selection: { usage: [{ provider: 'fixture-frontier', inputTokens: 2400, outputTokens: 120 }] } }
    }]
  };
}

async function seed(directory, strongObservations, weakObservations) {
  const store = createLocalLearningStore({ directory });
  const traces = [
    ...Array.from({ length: strongObservations }, (_, index) => successfulTrace(`strong-${index}`, expectedPath)),
    ...Array.from({ length: weakObservations }, (_, index) => successfulTrace(`weak-${index}`, 'README.md'))
  ];
  await store.appendTracesIfNew(traces);
  await refreshAndPromoteReadOnly(store, { minimumObservations: 1 });
  return store;
}

async function runLearned(store, repetitions) {
  let actorCalls = 0;
  let wrongActions = 0;
  const brancher = createJBrancher({
    learningStore: store,
    learningAutoPromote: false,
    authorize: async ({ action }) => action?.tool === 'read',
    actor: async () => {
      actorCalls++;
      return { action: { tool: 'read', args: { path: expectedPath } } };
    },
    execute: async action => {
      if (action.args.path !== expectedPath) wrongActions++;
      return { ok: action.args.path === expectedPath };
    }
  });
  const sources = [];
  for (let index = 0; index < repetitions; index++) {
    const result = await brancher.step({ task });
    sources.push(result.decision.source);
  }
  return { actorCalls, wrongActions, sources };
}

async function runTiedFallback(directory) {
  const store = await seed(directory, 2, 2);
  let actorCalls = 0;
  const brancher = createJBrancher({
    learningStore: store,
    learningAutoPromote: false,
    authorize: async ({ action }) => action?.tool === 'read',
    actor: async () => {
      actorCalls++;
      return { action: { tool: 'read', args: { path: expectedPath } } };
    },
    execute: async () => ({ ok: true })
  });
  const result = await brancher.step({ task });
  return { actorCalls, source: result.decision.source };
}

const root = await mkdtemp(join(tmpdir(), 'jbrancher-evidence-selection-'));
try {
  const store = await seed(join(root, 'strong'), 4, 1);
  const learned = await runLearned(store, 6);
  const tied = await runTiedFallback(join(root, 'tied'));
  const baselineActorCalls = 6;
  const report = {
    benchmark: 'JBrancher evidence-aware learned-route selection',
    source: { dataset: fixture.source, instance: instance.instance_id },
    policy: 'specificity first; equal-specificity routes require 2x evidence; ties abstain',
    baselineActorCalls,
    learnedActorCalls: learned.actorCalls,
    actorCallsAvoided: baselineActorCalls - learned.actorCalls,
    actorCallReduction: Number(((baselineActorCalls - learned.actorCalls) / baselineActorCalls).toFixed(3)),
    learnedRouteHits: learned.sources.filter(source => source === 'learned').length,
    taskSuccessPreserved: learned.wrongActions === 0,
    tiedRouteFallback: tied.source === 'actor' && tied.actorCalls === 1,
    caveat: 'Uses a real SWE-bench Lite problem statement and local redacted traces; it measures routing reuse, not official patch resolution.'
  };
  if (process.argv.includes('--assert')) {
    assert.equal(report.taskSuccessPreserved, true);
    assert.equal(report.learnedRouteHits, 6);
    assert.equal(report.learnedActorCalls, 0);
    assert.equal(report.tiedRouteFallback, true);
    assert.equal(report.actorCallsAvoided, 6);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
