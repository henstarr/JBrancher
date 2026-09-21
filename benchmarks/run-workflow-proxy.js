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

const instanceCount = integerFlag('--instances', fixture.instances.length, 1);
const repetitions = integerFlag('--repetitions', 4, 3);
const actorInputTokens = integerFlag('--actor-input-tokens', 1800, 0);
const actorOutputTokens = integerFlag('--actor-output-tokens', 140, 0);
const shouldAssert = process.argv.includes('--assert');
const instances = fixture.instances.slice(0, Math.min(instanceCount, fixture.instances.length));
const directory = await mkdtemp(join(tmpdir(), 'jbrancher-workflow-proxy-'));
const service = createJBrancherServer({
  learningDirectory: directory,
  learningSource: 'workflow-proxy-benchmark'
});

try {
  const address = await service.listen({ port: 0 });
  const baseUrl = `http://${address.host}:${address.port}`;
  const rows = [];

  for (const instance of instances) {
    const task = `${instance.instance_id}: inspect the failing test and then read the repository overview`;
    const actions = [
      { tool: 'read', args: { path: instance.fail_to_pass[0] } },
      { tool: 'read', args: { path: 'README.md' } }
    ];
    const attempts = [];
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      const candidateSteps = [[actions[0]], [actions[1]]];
      if (repetition <= 2) {
        const decision = await requestJson(baseUrl, '/v1/workflow', {
          task,
          state: { repository: instance.repo, repetition },
          candidateSteps: [[], []]
        });
        assert.equal(decision.source, 'abstain');
        assert.equal(decision.routeResolution, 'unmatched');
        await requestJson(baseUrl, '/v1/episodes', {
          task,
          source: 'workflow-proxy-benchmark',
          routeResolution: 'unmatched',
          metadata: { instanceId: instance.instance_id, repetition },
          toolCalls: actions.map((action, index) => ({
            toolCallId: `frontier-${instance.instance_id}-${repetition}-${index}`,
            toolName: action.tool,
            input: action.args,
            context: { step: index, candidateCount: 0 },
            ok: true,
            output: `fixture contents for ${action.args.path}`
          })),
          outcome: 'success'
        });
        attempts.push({ repetition, source: 'frontier', actorSteps: actions.length, correct: true });
        continue;
      }

      const decision = await requestJson(baseUrl, '/v1/workflow', {
        task,
        state: { repository: instance.repo, repetition },
        candidateSteps
      });
      const correct = decision.source === 'learned'
        && JSON.stringify(decision.actions) === JSON.stringify(actions);
      const feedback = await requestJson(baseUrl, '/v1/episodes', {
        task,
        routeId: decision.routeId,
        source: 'workflow-proxy-benchmark',
        routeResolution: decision.source === 'learned' ? 'learned' : 'unmatched',
        metadata: { instanceId: instance.instance_id, repetition },
        toolCalls: actions.map((action, index) => ({
          toolCallId: `learned-${instance.instance_id}-${repetition}-${index}`,
          toolName: action.tool,
          input: action.args,
          context: { step: index, source: decision.source },
          ok: correct,
          output: `fixture contents for ${action.args.path}`
        })),
        outcome: correct ? 'success' : 'unknown'
      });
      attempts.push({
        repetition,
        source: decision.source,
        routeId: decision.routeId ?? null,
        actorSteps: 0,
        correct,
        routeSuccessRecorded: feedback.routeSuccessRecorded
      });
    }
    rows.push({
      instance_id: instance.instance_id,
      baselineActorSteps: repetitions * actions.length,
      actualActorSteps: attempts.reduce((total, attempt) => total + attempt.actorSteps, 0),
      learnedReplays: attempts.filter(attempt => attempt.source === 'learned').length,
      routeCoverage: attempts.slice(2).every(attempt => attempt.source === 'learned' && attempt.correct),
      attempts
    });
  }

  const snapshot = await fetch(`${baseUrl}/v1/learning`).then(response => response.json());
  const stats = await fetch(`${baseUrl}/stats`).then(response => response.json());
  const baselineActorSteps = instances.length * repetitions * 2;
  const actualActorSteps = rows.reduce((total, row) => total + row.actualActorSteps, 0);
  const actorStepsAvoided = baselineActorSteps - actualActorSteps;
  const baselineTokens = baselineActorSteps * (actorInputTokens + actorOutputTokens);
  const actualTokens = actualActorSteps * (actorInputTokens + actorOutputTokens);
  const report = {
    benchmark: 'JBrancher local multi-step workflow replay through HTTP proxy',
    source: { url: fixture.sourceUrl, instances: instances.length, repetitions },
    caveat: 'SWE-bench-derived prompts and deterministic read workflows; not an official SWE-bench patch-resolution result.',
    baselineActorSteps,
    actualActorSteps,
    actorStepsAvoided,
    actorStepReduction: Number((actorStepsAvoided / baselineActorSteps).toFixed(3)),
    syntheticProviderTokens: { baseline: baselineTokens, actual: actualTokens, saved: baselineTokens - actualTokens },
    learnedReplays: rows.reduce((total, row) => total + row.learnedReplays, 0),
    routeCoverage: rows.every(row => row.routeCoverage),
    recordedEpisodes: stats.episodesRecorded,
    workflowRequests: stats.workflowRequests,
    datasetExamples: snapshot.traces,
    activeRoutes: snapshot.activeRoutes,
    successfulReplays: snapshot.successfulReplays,
    successRate: rows.every(row => row.attempts.every(attempt => attempt.correct)) ? 1 : 0,
    rows
  };

  if (shouldAssert) {
    assert.equal(report.activeRoutes, instances.length);
    assert.equal(report.recordedEpisodes, instances.length * repetitions);
    assert.equal(report.datasetExamples, instances.length * repetitions);
    assert.equal(report.workflowRequests, instances.length * repetitions);
    assert.equal(report.routeCoverage, true);
    assert.equal(report.successRate, 1);
    assert.equal(report.learnedReplays, instances.length * (repetitions - 2));
    assert.equal(report.successfulReplays, report.learnedReplays);
    assert.ok(report.actorStepReduction >= 0.5);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await service.close();
  await rm(directory, { recursive: true, force: true });
}
