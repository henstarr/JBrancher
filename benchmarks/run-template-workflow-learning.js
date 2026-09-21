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

const actorInputTokens = Number(flag('--actor-input-tokens', '1500'));
const actorOutputTokens = Number(flag('--actor-output-tokens', '120'));
const shouldAssert = process.argv.includes('--assert');
if (!Number.isSafeInteger(actorInputTokens) || actorInputTokens < 0) throw new Error('--actor-input-tokens must be a non-negative integer');
if (!Number.isSafeInteger(actorOutputTokens) || actorOutputTokens < 0) throw new Error('--actor-output-tokens must be a non-negative integer');

const values = ['auth', 'billing', 'payments', 'reliability'];
const directory = await mkdtemp(join(tmpdir(), 'jbrancher-template-workflow-benchmark-'));
try {
  const store = createLocalLearningStore({ directory });
  let actorCalls = 0;
  const rows = [];

  for (const [index, value] of values.entries()) {
    const task = `inspect ${value} in docs`;
    const actions = [
      { tool: 'lookup', args: { query: value, scope: 'docs' } },
      { tool: 'summarize', args: { topic: value, scope: 'docs' } }
    ];
    const brancher = createJBrancher({
      rules: [({ state }) => state.step >= actions.length
        ? { action: null, reason: 'workflow complete' } : null],
      getCandidates: async ({ state }) => [actions[state.step ?? 0]],
      actor: async ({ state }) => {
        actorCalls++;
        return {
          action: actions[state.step ?? 0],
          usage: [{ inputTokens: actorInputTokens, outputTokens: actorOutputTokens }]
        };
      },
      execute: async (action, { state }) => {
        assert.deepEqual(action, actions[state.step ?? 0]);
        return `${action.tool}:${value}`;
      },
      learningStore: store,
      learningSource: 'template-workflow-benchmark',
      learningCwd: directory,
      learningPromotionMode: 'verified',
      learningMinimumObservations: 2,
      learningOutcome: ({ events }) => events.filter(event => event.decision.action !== null).length === actions.length
    });
    const result = await brancher.run({
      task,
      state: { repository: 'fixture', value, step: 0, index },
      observe: async ({ state }) => ({ ...state, step: state.step + 1 })
    });
    const learned = result.events.every(event => event.decision.source === 'learned');
    rows.push({ value, source: learned ? 'learned' : 'actor', learnedSteps: result.events.filter(event => event.decision.source === 'learned').length });
  }

  const routes = JSON.parse(await readFile(join(directory, 'routes.json'), 'utf8'));
  const workflowRoutes = routes.filter(route => route.matcher?.type === 'action-template-workflow');
  const baselineActorCalls = values.length * actionsPerTask();
  const baselineTokens = baselineActorCalls * (actorInputTokens + actorOutputTokens);
  const actualTokens = actorCalls * (actorInputTokens + actorOutputTokens);
  const learnedRows = rows.filter(row => row.source === 'learned').length;
  const report = {
    benchmark: 'open-world-action-template-workflow-learning',
    teachingWorkflows: 2,
    novelWorkflows: values.length - 2,
    stepsPerWorkflow: actionsPerTask(),
    baselineFrontierCalls: baselineActorCalls,
    actualFrontierCalls: actorCalls,
    avoidedFrontierCalls: baselineActorCalls - actorCalls,
    frontierCallReduction: Number(((baselineActorCalls - actorCalls) / baselineActorCalls).toFixed(3)),
    syntheticProviderTokens: { baseline: baselineTokens, actual: actualTokens, saved: baselineTokens - actualTokens },
    workflowRoutes: workflowRoutes.map(route => ({
      id: route.id,
      status: route.status,
      verified: route.verified,
      observations: route.observations,
      matcher: route.matcher,
      actionCount: route.action?.actions?.length || 0
    })),
    learnedWorkflows: learnedRows,
    rows
  };

  if (shouldAssert) {
    assert.equal(actorCalls, 2 * actionsPerTask());
    assert.equal(learnedRows, values.length - 2);
    assert.equal(workflowRoutes.length, 1);
    assert.equal(workflowRoutes[0].status, 'active');
    assert.equal(workflowRoutes[0].verified, true);
    assert.equal(workflowRoutes[0].observations, 2);
    assert.equal(report.workflowRoutes[0].actionCount, actionsPerTask());
    assert.ok(report.frontierCallReduction >= 0.5);
    assert.equal(actualTokens, actorCalls * (actorInputTokens + actorOutputTokens));
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}

function actionsPerTask() {
  return 2;
}
