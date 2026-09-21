#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJBrancherServer } from '../src/server.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/swebench-lite-mini.json', import.meta.url), 'utf8'));

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

function integerFlag(name, fallback, minimum) {
  const value = Number(flag(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

async function requestJson(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

function toolCalls(actions, prefix, metadata) {
  return actions.map((action, index) => ({
    toolCallId: `${prefix}-${index}`,
    toolName: action.tool,
    input: action.args,
    context: { step: index, ...metadata },
    ok: true,
    output: `fixture output for ${action.args.path}`
  }));
}

const instanceCount = integerFlag('--instances', fixture.instances.length, 1);
const actorInputTokens = integerFlag('--actor-input-tokens', 1800, 0);
const actorOutputTokens = integerFlag('--actor-output-tokens', 140, 0);
const shouldAssert = process.argv.includes('--assert');
const instances = fixture.instances.slice(0, Math.min(instanceCount, fixture.instances.length));
const directory = await mkdtemp(join(tmpdir(), 'jbrancher-adaptive-drift-'));
const service = createJBrancherServer({
  learningDirectory: directory,
  learningSource: 'adaptive-drift-benchmark'
});

try {
  const address = await service.listen({ port: 0 });
  const baseUrl = `http://${address.host}:${address.port}`;
  const rows = [];

  for (const instance of instances) {
    const task = `${instance.instance_id}: inspect the failing test and repository overview`;
    const stableActions = [
      { tool: 'read', args: { path: instance.fail_to_pass[0] } },
      { tool: 'read', args: { path: 'README.md' } }
    ];
    const driftedActions = [
      stableActions[0],
      { tool: 'read', args: { path: 'pyproject.toml' } }
    ];
    const attempts = [];

    // Two cold episodes establish the first workflow.
    for (const repetition of [1, 2]) {
      await requestJson(baseUrl, '/v1/episodes', {
        task,
        source: 'adaptive-drift-benchmark',
        routeResolution: 'unmatched',
        metadata: { instanceId: instance.instance_id, repetition, phase: 'stable' },
        toolCalls: toolCalls(stableActions, `stable-frontier-${instance.instance_id}-${repetition}`, { phase: 'stable' }),
        outcome: 'success'
      });
      attempts.push({ repetition, phase: 'stable', source: 'frontier', frontierSteps: 2, correct: true });
    }

    const stableReplay = await requestJson(baseUrl, '/v1/workflow', {
      task,
      state: { repository: instance.repo, phase: 'stable' },
      candidateSteps: stableActions.map(action => [action])
    });
    const stableCorrect = stableReplay.source === 'learned'
      && JSON.stringify(stableReplay.actions) === JSON.stringify(stableActions);
    await requestJson(baseUrl, '/v1/episodes', {
      task,
      routeId: stableReplay.routeId,
      source: 'adaptive-drift-benchmark',
      routeResolution: stableReplay.source === 'learned' ? 'learned' : 'unmatched',
      metadata: { instanceId: instance.instance_id, repetition: 3, phase: 'stable' },
      toolCalls: toolCalls(stableActions, `stable-replay-${instance.instance_id}`, { phase: 'stable' }),
      outcome: stableCorrect ? 'success' : 'failure'
    });
    attempts.push({ repetition: 3, phase: 'stable', source: stableReplay.source, frontierSteps: 0, correct: stableCorrect });

    // The host's action catalog changes. The old route must not be replayed.
    const driftOne = await requestJson(baseUrl, '/v1/workflow', {
      task,
      state: { repository: instance.repo, phase: 'drifted' },
      candidateSteps: driftedActions.map(action => [action])
    });
    const driftAbstained = driftOne.source === 'abstain' && driftOne.routeResolution === 'unmatched';
    await requestJson(baseUrl, '/v1/episodes', {
      task,
      source: 'adaptive-drift-benchmark',
      routeResolution: 'unmatched',
      metadata: { instanceId: instance.instance_id, repetition: 4, phase: 'drifted' },
      toolCalls: toolCalls(driftedActions, `drift-frontier-${instance.instance_id}-4`, { phase: 'drifted' }),
      outcome: 'success'
    });
    attempts.push({ repetition: 4, phase: 'drifted', source: 'frontier', decisionSource: driftOne.source, frontierSteps: 2, correct: driftAbstained });

    const driftTwo = await requestJson(baseUrl, '/v1/workflow', {
      task,
      state: { repository: instance.repo, phase: 'drifted' },
      candidateSteps: driftedActions.map(action => [action])
    });
    const driftAbstainedAgain = driftTwo.source === 'abstain' && driftTwo.routeResolution === 'unmatched';
    await requestJson(baseUrl, '/v1/episodes', {
      task,
      source: 'adaptive-drift-benchmark',
      routeResolution: 'unmatched',
      metadata: { instanceId: instance.instance_id, repetition: 5, phase: 'drifted' },
      toolCalls: toolCalls(driftedActions, `drift-frontier-${instance.instance_id}-5`, { phase: 'drifted' }),
      outcome: 'success'
    });
    attempts.push({ repetition: 5, phase: 'drifted', source: 'frontier', decisionSource: driftTwo.source, frontierSteps: 2, correct: driftAbstainedAgain });

    const driftReplay = await requestJson(baseUrl, '/v1/workflow', {
      task,
      state: { repository: instance.repo, phase: 'drifted' },
      candidateSteps: driftedActions.map(action => [action])
    });
    const driftCorrect = driftReplay.source === 'learned'
      && JSON.stringify(driftReplay.actions) === JSON.stringify(driftedActions);
    await requestJson(baseUrl, '/v1/episodes', {
      task,
      routeId: driftReplay.routeId,
      source: 'adaptive-drift-benchmark',
      routeResolution: driftReplay.source === 'learned' ? 'learned' : 'unmatched',
      metadata: { instanceId: instance.instance_id, repetition: 6, phase: 'drifted' },
      toolCalls: toolCalls(driftedActions, `drift-replay-${instance.instance_id}`, { phase: 'drifted' }),
      outcome: driftCorrect ? 'success' : 'failure'
    });
    attempts.push({ repetition: 6, phase: 'drifted', source: driftReplay.source, frontierSteps: 0, correct: driftCorrect });

    rows.push({
      instance_id: instance.instance_id,
      stableRouteId: stableReplay.routeId ?? null,
      driftedRouteId: driftReplay.routeId ?? null,
      actualFrontierSteps: attempts.reduce((total, attempt) => total + attempt.frontierSteps, 0),
      driftAbstentions: attempts.filter(attempt => attempt.phase === 'drifted' && attempt.decisionSource === 'abstain').length,
      replacementRouteReplayed: driftReplay.source === 'learned',
      attempts
    });
  }

  const snapshot = await fetch(`${baseUrl}/v1/learning`).then(response => response.json());
  const stats = await fetch(`${baseUrl}/stats`).then(response => response.json());
  const baselineFrontierSteps = instances.length * 6 * 2;
  const actualFrontierSteps = rows.reduce((total, row) => total + row.actualFrontierSteps, 0);
  const frontierStepsAvoided = baselineFrontierSteps - actualFrontierSteps;
  const tokensPerStep = actorInputTokens + actorOutputTokens;
  const report = {
    benchmark: 'JBrancher adaptive workflow learning under capability drift',
    source: { url: fixture.sourceUrl, instances: instances.length, repetitions: 6 },
    caveat: 'SWE-bench-derived prompts and deterministic read workflows; this tests safe adaptation, not official patch resolution.',
    baselineFrontierSteps,
    actualFrontierSteps,
    frontierStepsAvoided,
    frontierStepReduction: Number((frontierStepsAvoided / baselineFrontierSteps).toFixed(3)),
    syntheticProviderTokens: {
      baseline: baselineFrontierSteps * tokensPerStep,
      actual: actualFrontierSteps * tokensPerStep,
      saved: frontierStepsAvoided * tokensPerStep
    },
    adaptationAbstentions: rows.reduce((total, row) => total + row.driftAbstentions, 0),
    replacementRoutesReplayed: rows.filter(row => row.replacementRouteReplayed).length,
    routeCoverage: rows.every(row => row.attempts.every(attempt => attempt.correct)),
    successRate: rows.every(row => row.attempts.every(attempt => attempt.correct)) ? 1 : 0,
    recordedEpisodes: stats.episodesRecorded,
    workflowRequests: stats.workflowRequests,
    datasetExamples: snapshot.traces,
    activeRoutes: snapshot.activeRoutes,
    successfulReplays: snapshot.successfulReplays,
    replay: snapshot.replay,
    rows
  };

  if (shouldAssert) {
    assert.equal(report.recordedEpisodes, instances.length * 6);
    assert.equal(report.datasetExamples, instances.length * 6);
    assert.equal(report.workflowRequests, instances.length * 4);
    assert.equal(report.activeRoutes, instances.length * 2);
    assert.equal(report.adaptationAbstentions, instances.length * 2);
    assert.equal(report.replacementRoutesReplayed, instances.length);
    assert.equal(report.routeCoverage, true);
    assert.equal(report.successRate, 1);
    assert.equal(report.successfulReplays, instances.length * 2);
    assert.equal(report.replay.estimatedFrontierStepsAvoided, report.frontierStepsAvoided);
    assert.ok(report.frontierStepReduction >= 0.3);
    assert.ok(rows.every(row => row.stableRouteId && row.driftedRouteId && row.stableRouteId !== row.driftedRouteId));
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await service.close();
  await rm(directory, { recursive: true, force: true });
}
