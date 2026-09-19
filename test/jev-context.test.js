import test from 'node:test';
import assert from 'node:assert/strict';
import { createJevContextEvaluator } from '../src/jev.js';

test('Jev context evaluator sends bounded state and parses relevance scores', async () => {
  let request;
  const evaluate = createJevContextEvaluator({ apiKey: 'test-key', maxItemChars: 128,
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, async json() { return {
        model: 'jev-1.13.0',
        answers: { context_0: { type: 'noul', noul: 0.91 }, context_1: { type: 'noul', noul: 0.12 } },
        usage: { input_tokens: 33, output_tokens: 12 }
      }; } };
    }
  });
  const result = await evaluate({ task: 'Fix the parser', state: { file: 'parser.js' }, items: [
    { id: 'a', text: 'x'.repeat(300), kind: 'source' },
    { id: 'b', text: 'test failure', kind: 'test' }
  ] });
  assert.deepEqual(result.scores, [0.91, 0.12]);
  assert.deepEqual(result.usage[0], { provider: 'typesafe', model: 'jev-1.13.0', status: 'succeeded', inputTokens: 33, outputTokens: 12 });
  assert.equal(request.state.context_items[0].text.length, 128);
  assert.match(request.questions.context_0.instructions, /context_items\[0\]/);
});
