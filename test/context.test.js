import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, optimizeContext } from '../src/context.js';

test('context optimizer preserves required items and spends budget by relevance density', async () => {
  const items = [
    { id: 'required', text: 'must keep', tokens: 3, required: true },
    { id: 'small-relevant', text: 'useful', tokens: 4 },
    { id: 'large-relevant', text: 'also useful', tokens: 10 },
    { id: 'irrelevant', text: 'noise', tokens: 5 }
  ];
  const result = await optimizeContext({ items, maxTokens: 12, minimumScore: 0.6,
    evaluate: async ({ items: candidates }) => ({ scores: candidates.map(item => ({
      'small-relevant': 0.9, 'large-relevant': 0.95, irrelevant: 0.2
    }[item.id])), usage: [{ inputTokens: 20 }] }) });
  assert.deepEqual(result.items.map(item => item.id), ['required', 'small-relevant']);
  assert.deepEqual(result.dropped.map(item => item.id), ['large-relevant', 'irrelevant']);
  assert.equal(result.estimatedTokens, 7);
  assert.equal(result.savedTokens, 15);
  assert.equal(result.evaluation.status, 'succeeded');
  assert.equal(result.usage[0].inputTokens, 20);
  assert.equal(items[1].required, undefined);
});

test('context optimizer falls back to local priorities when evaluation is unavailable', async () => {
  const result = await optimizeContext({ maxTokens: 5, minimumScore: 0.4, items: [
    { id: 'high', text: 'high', tokens: 2, priority: 0.9 },
    { id: 'low', text: 'low', tokens: 2, priority: 0.1 },
    { id: 'required', text: 'required', tokens: 3, required: true }
  ], evaluate: async () => {
    const error = new Error('provider unavailable');
    error.usage = [{ inputTokens: 12, outputTokens: 3 }];
    throw error;
  } });
  assert.deepEqual(result.items.map(item => item.id), ['required', 'high']);
  assert.equal(result.evaluation.status, 'unavailable');
  assert.deepEqual(result.usage, [{ inputTokens: 12, outputTokens: 3 }]);
  assert.equal(result.overBudget, false);
});

test('token estimation and input validation are bounded', async () => {
  assert.equal(estimateTokens('12345'), 2);
  assert.equal(estimateTokens('', 4), 1);
  assert.throws(() => estimateTokens('x', 0));
  await assert.rejects(optimizeContext({ items: [{ id: 'x', text: 'x', tokens: 0 }] }));
  await assert.rejects(optimizeContext({ items: [], maxTokens: 0 }));
});
