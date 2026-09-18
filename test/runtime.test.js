import test from 'node:test';
import assert from 'node:assert/strict';
import { createJBrancher } from '../src/index.js';

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
