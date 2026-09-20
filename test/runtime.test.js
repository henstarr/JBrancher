import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJBrancher, withJBrancher } from '../src/index.js';
import { createLocalLearningStore } from '../src/learning.js';
import { createJBrancherServer } from '../src/server.js';

test('rules run before evaluation and actor fallback', async () => {
  const calls = [];
  const brancher = createJBrancher({
    rules: [() => ({ action: { tool: 'check', args: {} }, reason: 'known check' })],
    evaluate: async () => { calls.push('evaluate'); return { scores: [1] }; },
    actor: async () => { calls.push('actor'); return { action: null }; }
  });
  const result = await brancher.decide({ state: {} });
  assert.equal(result.source, 'rule');
  assert.deepEqual(calls, []);
});

test('Jev selects only a supplied candidate when probability and margin pass', async () => {
  const brancher = createJBrancher({
    getCandidates: async () => [{ tool: 'write', args: { value: 8 } }, { tool: 'verify', args: {} }],
    evaluate: async () => ({ scores: [0.91, 0.52] }),
    actor: async () => ({ action: null })
  });
  const result = await brancher.decide({ task: 'repair', state: {} });
  assert.equal(result.source, 'jev');
  assert.deepEqual(result.action, { tool: 'write', args: { value: 8 } });
});

test('uncertain evaluation falls back to the actor', async () => {
  const brancher = createJBrancher({
    getCandidates: async () => [{ tool: 'write', args: {} }, { tool: 'verify', args: {} }],
    evaluate: async () => ({ scores: [0.69, 0.68] }),
    actor: async () => ({ action: { tool: 'verify', args: {} } })
  });
  const result = await brancher.decide({ state: {} });
  assert.equal(result.source, 'actor');
  assert.deepEqual(result.action, { tool: 'verify', args: {} });
  assert.deepEqual(result.evaluation.scores, [0.69, 0.68]);
});

test('evaluator errors remain advisory and preserve actor fallback', async () => {
  const brancher = createJBrancher({
    getCandidates: async () => [{ tool: 'verify', args: {} }],
    evaluate: async () => { throw Object.assign(new Error('hidden provider detail'), { usage: [{ status: 'unknown' }] }); },
    actor: async () => ({ action: null })
  });
  const result = await brancher.decide({ state: {} });
  assert.equal(result.source, 'actor');
  assert.equal(result.evaluation.status, 'unavailable');
  assert.deepEqual(result.evaluation.usage, [{ status: 'unknown' }]);
});

test('run records transitions and observes updated state', async () => {
  const brancher = createJBrancher({
    getCandidates: async ({ state }) => state.done ? [null] : [{ tool: 'finish', args: {} }],
    evaluate: async ({ candidates }) => ({ scores: candidates.map(() => 0.95) }),
    execute: async () => ({ done: true }),
    maxSteps: 2
  });
  const result = await brancher.run({ state: { done: false }, task: 'finish', observe: async ({ event }) => ({ done: event.result.done }) });
  assert.equal(result.events.length, 2);
  assert.equal(result.state.done, true);
});

test('withJBrancher preserves the actor and routes nextAction through JBrancher', async () => {
  const actor = {
    label: 'existing actor',
    nextAction(input) {
      return { action: { tool: 'fallback', args: { task: input.task } } };
    }
  };
  const wrapped = withJBrancher(actor, {
    getCandidates: () => [{ tool: 'fast_path', args: {} }],
    evaluate: async () => ({ scores: [0.95] })
  });
  const result = await wrapped.nextAction({ task: 'ship it', state: {} });
  assert.equal(wrapped.label, 'existing actor');
  assert.equal(result.source, 'jev');
  assert.deepEqual(result.action, { tool: 'fast_path', args: {} });
  assert.equal(wrapped.jbrancher.metadata.ruleCount, 0);
});

test('generic brancher records unknown actor fallback episodes in a local store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-runtime-learning-'));
  try {
    const store = createLocalLearningStore({ directory });
    let actorCalls = 0;
    const brancher = createJBrancher({
      getCandidates: async () => [{ tool: 'read', args: { path: 'README.md' } }],
      actor: async () => {
        actorCalls++;
        return { action: { tool: 'read', args: { path: 'README.md' } } };
      },
      execute: async action => `contents of ${action.args.path}`,
      learningStore: store,
      learningSource: 'custom-harness',
      learningCwd: directory
    });
    const first = await brancher.step({ task: 'Read README.md' });
    const second = await brancher.step({ task: 'Read README.md' });
    assert.equal(first.decision.source, 'actor');
    assert.equal(second.decision.source, 'actor');
    assert.equal(actorCalls, 2);
    const traces = await store.readTraces();
    assert.equal(traces.length, 2);
    assert.equal(traces[0].source, 'custom-harness');
    assert.equal(traces[0].outcome, 'success');
    assert.equal(traces[0].toolCalls[0].toolName, 'read');
    assert.equal(traces[0].toolCalls[0].output, 'contents of README.md');
    const routes = await store.readRoutes();
    assert.equal(routes.length, 1);
    assert.equal(routes[0].status, 'active');
    const learned = await brancher.step({ task: 'Read README.md' });
    assert.equal(learned.decision.source, 'learned');
    assert.equal(actorCalls, 2);
    const stale = createJBrancher({
      getCandidates: async () => [{ tool: 'read', args: { path: 'README.md' } }],
      actor: async () => ({ action: { tool: 'read', args: { path: 'README.md' } } }),
      execute: async () => { throw new Error('stale route'); },
      learningStore: store,
      learningCwd: directory
    });
    await assert.rejects(stale.step({ task: 'Read README.md' }), /stale route/);
    assert.equal((await store.readRoutes())[0].status, 'quarantined');
    const afterFailure = await brancher.step({ task: 'Read README.md' });
    assert.equal(afterFailure.decision.source, 'actor');
    assert.equal(actorCalls, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('decision service exposes health, decisions, and stats without exposing credentials', async () => {
  const service = createJBrancherServer({
    evaluate: async () => ({ scores: [0.94, 0.12], usage: [{ provider: 'test', status: 'succeeded' }] })
  });
  const address = await service.listen({ port: 0 });
  try {
    const baseUrl = `http://${address.host}:${address.port}`;
    const health = await fetch(`${baseUrl}/health`).then(response => response.json());
    assert.equal(health.status, 'healthy');
    assert.equal(health.evaluatorConfigured, true);
    const decision = await fetch(`${baseUrl}/v1/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'choose',
        state: { ready: true },
        candidates: [{ tool: 'fast_path', args: {} }, { tool: 'slow_path', args: {} }]
      })
    }).then(response => response.json());
    assert.equal(decision.source, 'jev');
    assert.deepEqual(decision.action, { tool: 'fast_path', args: {} });
    const stats = await fetch(`${baseUrl}/stats`).then(response => response.json());
    assert.equal(stats.requestsTotal, 1);
    assert.equal(stats.evaluatorCalls, 1);
    assert.equal(stats.sources.jev, 1);
  } finally {
    await service.close();
  }
});
