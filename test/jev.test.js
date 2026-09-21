import test from 'node:test';
import assert from 'node:assert/strict';
import { createJevEvaluator } from '../src/jev.js';

test('Jev route evaluator uses a bounded Choice with an explicit no-match option', async () => {
  let request;
  const evaluate = createJevEvaluator({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return {
            model: 'jev-1.13.0',
            answers: {
              route_choice: {
                type: 'choice',
                choice: 'candidate_1',
                confidence: 0.82,
                probabilities: { candidate_0: 0.08, candidate_1: 0.82, no_match: 0.1 }
              }
            },
            usage: { input_tokens: 44, output_tokens: 18 }
          };
        }
      };
    }
  });

  const result = await evaluate({
    task: 'Inspect the failing test',
    state: { ready: true },
    history: [],
    candidates: [
      { tool: 'read', args: { path: 'README.md' }, description: 'Read the overview' },
      { tool: 'read', args: { path: 'tests/example.js' }, description: 'Read the failing test' }
    ]
  });

  assert.deepEqual(result.scores, [0.08, 0.82]);
  assert.equal(result.noMatchScore, 0.1);
  assert.equal(result.selected, 1);
  assert.equal(result.confidence, 0.82);
  assert.deepEqual(result.usage[0], {
    provider: 'typesafe', model: 'jev-1.13.0', status: 'succeeded', inputTokens: 44, outputTokens: 18
  });
  assert.equal(request.questions.route_choice.type, 'choice');
  assert.match(request.questions.route_choice.criteria.candidate_1, /failing test/);
  assert.equal(request.questions.route_choice.criteria.no_match, 'No supplied candidate is appropriate or safe; defer to the frontier actor.');
});

test('Jev route evaluator preserves the legacy Noul question mode', async () => {
  let request;
  const evaluate = createJevEvaluator({
    apiKey: 'test-key',
    questionType: 'noul',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return {
            model: 'jev-1.13.0',
            answers: {
              candidate_0: { type: 'noul', noul: 0.91 },
              candidate_1: { type: 'noul', noul: 0.12 }
            },
            usage: { input_tokens: 21, output_tokens: 9 }
          };
        }
      };
    }
  });

  const result = await evaluate({ task: 'Choose', state: {}, history: [], candidates: [{ tool: 'a', args: {} }, { tool: 'b', args: {} }] });
  assert.deepEqual(result.scores, [0.91, 0.12]);
  assert.equal(request.questions.candidate_0.type, 'noul');
});
