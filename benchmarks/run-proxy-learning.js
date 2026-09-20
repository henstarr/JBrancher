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
const sourceSplits = instances.reduce((counts, instance) => {
  counts[instance.split] = (counts[instance.split] ?? 0) + 1;
  return counts;
}, {});
const directory = await mkdtemp(join(tmpdir(), 'jbrancher-proxy-learning-'));
let evaluatorCalls = 0;
const service = createJBrancherServer({
  learningDirectory: directory,
  learningSource: 'proxy-learning-benchmark',
  evaluate: async () => {
    evaluatorCalls += 1;
    return { scores: [0.95], usage: [] };
  }
});

try {
  const address = await service.listen({ port: 0 });
  const baseUrl = `http://${address.host}:${address.port}`;
  const rows = [];

  for (const instance of instances) {
    const task = `${instance.instance_id}: ${instance.problem_statement}`;
    const action = { tool: 'read', args: { path: instance.fail_to_pass[0] } };
    const attempts = [];
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      if (repetition <= 2) {
        const openWorldDecision = await requestJson(baseUrl, '/v1/decide', {
          task,
          state: { repository: instance.repo, repetition }
        });
        if (openWorldDecision.source !== 'abstain' || openWorldDecision.routeResolution !== 'unmatched') {
          throw new Error(`Expected safe open-world abstention, got ${JSON.stringify(openWorldDecision)}`);
        }
        await requestJson(baseUrl, '/v1/episodes', {
          task,
          source: 'proxy-learning-benchmark',
          routeResolution: 'unmatched',
          metadata: { instanceId: instance.instance_id, repetition },
          toolCalls: [{
            toolCallId: `call-${instance.instance_id}-${repetition}`,
            toolName: action.tool,
            input: action.args,
            context: { candidateCount: 0 },
            ok: true,
            output: `fixture contents for ${action.args.path}`
          }],
          outcome: 'success'
        });
        attempts.push({
          repetition,
          source: 'frontier',
          openWorld: true,
          decisionSource: openWorldDecision.source,
          correct: true
        });
      } else {
        const decision = await requestJson(baseUrl, '/v1/decide', {
          task,
          state: { repository: instance.repo, repetition },
          candidates: [action]
        });
        const feedback = await requestJson(baseUrl, '/v1/episodes', {
          task,
          routeId: decision.routeId,
          source: 'proxy-learning-benchmark',
          routeResolution: 'learned',
          metadata: { instanceId: instance.instance_id, repetition },
          toolCalls: [{
            toolCallId: `learned-call-${instance.instance_id}-${repetition}`,
            toolName: action.tool,
            input: action.args,
            context: { source: decision.source },
            ok: decision.source === 'learned',
            output: `fixture contents for ${action.args.path}`
          }],
          outcome: decision.source === 'learned' ? 'success' : 'unknown'
        });
        attempts.push({
          repetition,
          source: decision.source,
          routeId: decision.routeId ?? null,
          correct: JSON.stringify(decision.action) === JSON.stringify(action),
          routeSuccessRecorded: feedback.routeSuccessRecorded,
          evaluatorCalls: service.stats.evaluatorCalls
        });
      }
    }
    rows.push({
      instance_id: instance.instance_id,
      baselineFrontierCalls: repetitions,
      actualFrontierCalls: attempts.filter(attempt => attempt.source === 'frontier').length,
      learnedReplays: attempts.filter(attempt => attempt.source === 'learned').length,
      routeCoverage: attempts.slice(2).every(attempt => attempt.source === 'learned' && attempt.correct),
      attempts
    });
  }

  const snapshot = await fetch(`${baseUrl}/v1/learning`).then(response => response.json());
  const stats = await fetch(`${baseUrl}/stats`).then(response => response.json());
  const baselineFrontierCalls = instances.length * repetitions;
  const actualFrontierCalls = rows.reduce((total, row) => total + row.actualFrontierCalls, 0);
  const learnedReplays = rows.reduce((total, row) => total + row.learnedReplays, 0);
  const frontierCallsAvoided = baselineFrontierCalls - actualFrontierCalls;
  const baselineTokens = baselineFrontierCalls * (actorInputTokens + actorOutputTokens);
  const actualTokens = actualFrontierCalls * (actorInputTokens + actorOutputTokens);
  const report = {
    benchmark: 'JBrancher language-agnostic proxy open-world learning',
    source: { url: fixture.sourceUrl, instances: instances.length, repetitions, splits: sourceSplits },
    caveat: 'SWE-bench-derived prompts and deterministic read actions through the HTTP proxy; not an official SWE-bench patch-resolution result.',
    baselineFrontierCalls,
    actualFrontierCalls,
    frontierCallsAvoided,
    frontierCallReduction: Number((frontierCallsAvoided / baselineFrontierCalls).toFixed(3)),
    syntheticProviderTokens: {
      baseline: baselineTokens,
      actual: actualTokens,
      saved: baselineTokens - actualTokens
    },
    learnedReplays,
    routeCoverage: rows.every(row => row.routeCoverage),
    evaluatorCalls,
    openWorldAbstentions: rows.reduce((total, row) => total + row.attempts.filter(attempt => attempt.openWorld).length, 0),
    recordedEpisodes: stats.episodesRecorded,
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
    assert.equal(report.evaluatorCalls, 0);
    assert.equal(report.openWorldAbstentions, instances.length * 2);
    assert.equal(Object.values(sourceSplits).reduce((total, count) => total + count, 0), instances.length);
    assert.equal(report.routeCoverage, true);
    assert.equal(report.successRate, 1);
    assert.equal(report.learnedReplays, instances.length * (repetitions - 2));
    assert.equal(snapshot.successfulReplays, report.learnedReplays);
    assert.ok(report.frontierCallReduction >= 1 / 3);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await service.close();
  await rm(directory, { recursive: true, force: true });
}
