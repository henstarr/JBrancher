import { createJevBrancher } from '../src/index.js';

const state = { artifact: { value: 10 }, expected: 8, verified: false };

const brancher = createJevBrancher({
  rules: [
    ({ state: current }) => current.verified ? { action: null, reason: 'Current artifact is already verified' } : null
  ],
  getCandidates: ({ state: current }) => current.verified ? [null] : [
    { tool: 'write', args: { value: current.expected } },
    { tool: 'verify', args: {} },
    null
  ],
  evaluate: async ({ candidates }) => ({
    // Replace this with createJevEvaluator(...) when using a TypeSafe key.
    scores: candidates.map(candidate => candidate?.tool === 'write' ? 0.91 : candidate?.tool === 'verify' ? 0.56 : 0.12),
    usage: [{ provider: 'mock', status: 'succeeded', inputTokens: 0, outputTokens: 0 }]
  }),
  actor: async () => ({ action: { tool: 'verify', args: {} }, usage: [{ provider: 'actor', status: 'succeeded' }] }),
  execute: async action => action.tool === 'write' ? { written: action.args.value } : { verified: true }
});

const result = await brancher.step({ task: 'Make the artifact equal 8', state });
console.log(JSON.stringify(result, null, 2));
