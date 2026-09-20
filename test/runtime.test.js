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
    const first = await brancher.step({ task: 'Read README.md', state: { phase: 0, credentials: { apiKey: 'apikey_1234567890123456' } } });
    const second = await brancher.step({ task: 'Read README.md', state: { phase: 0, credentials: { apiKey: 'apikey_1234567890123456' } } });
    assert.equal(first.decision.source, 'actor');
    assert.equal(second.decision.source, 'actor');
    assert.equal(actorCalls, 2);
    const traces = await store.readTraces();
    assert.equal(traces.length, 2);
    assert.equal(traces[0].source, 'custom-harness');
    assert.equal(traces[0].outcome, 'success');
    assert.equal(traces[0].toolCalls[0].toolName, 'read');
    assert.equal(traces[0].toolCalls[0].output, 'contents of README.md');
    assert.equal(traces[0].toolCalls[0].context.state.phase, 0);
    assert.equal(traces[0].toolCalls[0].context.state.credentials.apiKey, '[REDACTED]');
    assert.equal(traces[0].toolCalls[0].context.selection.source, 'actor');
    assert.equal(traces[0].toolCalls[0].context.selection.candidateCount, 1);
    assert.deepEqual(traces[0].toolCalls[0].context.selection.candidates, [{ tool: 'read', args: { path: 'README.md' } }]);
    assert.equal(traces[0].metadata.initialState.phase, 0);
    assert.equal(traces[0].routeResolution, 'uncertain');
    const routes = await store.readRoutes();
    assert.equal(routes.length, 1);
    assert.equal(routes[0].status, 'active');
    const learned = await brancher.step({ task: 'Read README.md' });
    assert.equal(learned.decision.source, 'learned');
    assert.equal(actorCalls, 2);
    assert.equal((await store.readRoutes())[0].successfulReplays, 1);
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

test('generic runtime learns an open-world route before replaying it when authorized', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-runtime-open-world-'));
  try {
    const store = createLocalLearningStore({ directory });
    let actorCalls = 0;
    const action = { tool: 'read', args: { path: 'notes.md' } };
    const brancher = createJBrancher({
      // The frontier actor can invent/choose the action on a cold request.
      // The action becomes replayable only when the harness exposes it as a
      // currently authorized capability.
      getCandidates: async ({ state }) => state.capabilitiesReady ? [action] : [],
      actor: async () => {
        actorCalls++;
        return { action };
      },
      execute: async () => 'notes',
      learningStore: store,
      learningSource: 'open-world-test',
      learningCwd: directory
    });

    const first = await brancher.step({ task: 'Read notes.md', state: { capabilitiesReady: false } });
    const second = await brancher.step({ task: 'Read notes.md', state: { capabilitiesReady: false } });
    assert.deepEqual([first.decision.source, second.decision.source], ['actor', 'actor']);
    assert.equal(first.decision.routeResolution, 'unmatched');
    assert.equal(second.decision.routeResolution, 'unmatched');
    assert.equal(actorCalls, 2);

    const routes = await store.readRoutes();
    assert.equal(routes.length, 1);
    assert.equal(routes[0].status, 'active');

    const warm = await brancher.step({ task: 'Read notes.md', state: { capabilitiesReady: true } });
    assert.equal(warm.decision.source, 'learned');
    assert.equal(actorCalls, 2);
    assert.equal((await store.readTraces()).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generic runtime exposes a first fallback as a candidate without activating it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-runtime-candidate-'));
  try {
    const store = createLocalLearningStore({ directory });
    const brancher = createJBrancher({
      getCandidates: async () => [{ tool: 'read', args: { path: 'README.md' } }],
      actor: async () => ({ action: { tool: 'read', args: { path: 'README.md' } } }),
      execute: async () => 'ok',
      learningStore: store
    });
    await brancher.step({ task: 'Read README.md' });
    const routes = await store.readRoutes();
    assert.equal(routes.length, 1);
    assert.equal(routes[0].status, 'candidate');
    const second = await brancher.step({ task: 'Read README.md' });
    assert.equal(second.decision.source, 'actor');
    const third = await brancher.step({ task: 'Read README.md' });
    assert.equal(third.decision.source, 'learned');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generic runtime can learn successful Jev decisions and bypass Jev on reuse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-runtime-jev-learning-'));
  try {
    const store = createLocalLearningStore({ directory });
    let evaluatorCalls = 0;
    const brancher = createJBrancher({
      getCandidates: async () => [{ tool: 'read', args: { path: 'README.md' } }],
      evaluate: async () => {
        evaluatorCalls++;
        return { scores: [0.98] };
      },
      actor: async () => ({ action: { tool: 'read', args: { path: 'README.md' } } }),
      execute: async () => 'ok',
      learningStore: store,
      learningOnlyFallback: false
    });

    const first = await brancher.step({ task: 'Read README.md' });
    const second = await brancher.step({ task: 'Read README.md' });
    const third = await brancher.step({ task: 'Read README.md' });

    assert.equal(first.decision.source, 'jev');
    assert.equal(second.decision.source, 'jev');
    assert.equal(third.decision.source, 'learned');
    assert.equal(evaluatorCalls, 2);
    assert.equal((await store.readTraces()).length, 2);
    assert.equal((await store.readRoutes())[0].status, 'active');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generic runtime records an unregistered no-tool fallback as dataset evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-runtime-empty-learning-'));
  try {
    const store = createLocalLearningStore({ directory });
    const brancher = createJBrancher({
      getCandidates: async () => [],
      actor: async () => ({ action: null }),
      learningStore: store,
      learningSource: 'answer-harness',
      learningCwd: directory
    });

    const result = await brancher.step({ task: 'Explain the current routing policy' });
    assert.equal(result.decision.source, 'actor');
    const [trace] = await store.readTraces();
    assert.equal(trace.task, 'Explain the current routing policy');
    assert.deepEqual(trace.toolCalls, []);
    assert.equal(trace.outcome, 'unknown');
    assert.equal(trace.routeResolution, 'unmatched');
    const [example] = (await store.writeDataset()).examples;
    assert.equal(example.steps.length, 0);
    assert.equal(example.reusable, false);
    assert.equal((await store.readRoutes()).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generic brancher lets the harness veto promotion when a postcondition is not met', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-runtime-outcome-'));
  try {
    const store = createLocalLearningStore({ directory });
    let actorCalls = 0;
    const brancher = createJBrancher({
      getCandidates: async () => [{ tool: 'read', args: { path: 'README.md' } }],
      actor: async () => {
        actorCalls++;
        return { action: { tool: 'read', args: { path: 'README.md' } } };
      },
      execute: async () => 'read successfully',
      learningStore: store,
      learningOutcome: () => false
    });
    await brancher.step({ task: 'Read README.md' });
    await brancher.step({ task: 'Read README.md' });
    assert.equal(actorCalls, 2);
    assert.equal((await store.readTraces()).every(trace => trace.outcome === 'unknown'), true);
    assert.equal((await store.readRoutes()).some(route => route.status === 'active'), false);
    const fallback = await brancher.step({ task: 'Read README.md' });
    assert.equal(fallback.decision.source, 'actor');
    assert.equal(actorCalls, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generic runtime can opt into postcondition-verified promotion for harness-owned writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-runtime-verified-'));
  try {
    const store = createLocalLearningStore({ directory });
    let actorCalls = 0;
    const brancher = createJBrancher({
      getCandidates: async () => [{ tool: 'write', args: { path: 'out.txt', content: 'ok' } }],
      actor: async () => {
        actorCalls++;
        return { action: { tool: 'write', args: { path: 'out.txt', content: 'ok' } } };
      },
      execute: async () => 'written',
      learningStore: store,
      learningPromotionMode: 'verified',
      learningOutcome: () => true
    });
    await brancher.step({ task: 'write the verified artifact' });
    await brancher.step({ task: 'write the verified artifact' });
    const routes = await store.readRoutes();
    assert.equal(routes.length, 1);
    assert.equal(routes[0].status, 'active');
    assert.equal(routes[0].verified, true);
    assert.equal(routes[0].safety, 'side-effect-or-unknown');
    const learned = await brancher.step({ task: 'write the verified artifact' });
    assert.equal(learned.decision.source, 'learned');
    assert.equal(actorCalls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generic runtime quarantines a learned single step when its postcondition fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-runtime-verified-failure-'));
  try {
    const store = createLocalLearningStore({ directory });
    const makeBrancher = learningOutcome => createJBrancher({
      getCandidates: async () => [{ tool: 'write', args: { path: 'out.txt', content: 'ok' } }],
      actor: async () => ({ action: { tool: 'write', args: { path: 'out.txt', content: 'ok' } } }),
      execute: async () => ({ written: true }),
      learningStore: store,
      learningPromotionMode: 'verified',
      learningOutcome
    });
    await makeBrancher(() => true).step({ task: 'write verified output' });
    await makeBrancher(() => true).step({ task: 'write verified output' });
    const result = await makeBrancher(() => false).step({ task: 'write verified output' });
    assert.equal(result.decision.source, 'actor');
    assert.equal(result.learningOutcome, 'unknown');
    assert.equal(result.learnedRouteQuarantined, true);
    assert.equal(result.fallbackAfterLearnedRoute, (await store.readRoutes())[0].id);
    assert.equal((await store.readRoutes())[0].status, 'quarantined');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generic brancher replays a learned multi-step read workflow only when each step remains allowed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-runtime-workflow-'));
  try {
    const store = createLocalLearningStore({ directory });
    let actorCalls = 0;
    const createBrancher = () => createJBrancher({
      getCandidates: async ({ state }) => state.phase === 0
        ? [{ tool: 'read', args: { path: 'package.json' } }]
        : state.phase === 1 ? [{ tool: 'read', args: { path: 'README.md' } }] : [],
      actor: async ({ state }) => {
        actorCalls++;
        if (state.phase === 0) return { action: { tool: 'read', args: { path: 'package.json' } } };
        if (state.phase === 1) return { action: { tool: 'read', args: { path: 'README.md' } } };
        return { action: null };
      },
      execute: async action => `contents of ${action.args.path}`,
      learningStore: store,
      learningCwd: directory
    });
    const observe = async ({ state }) => ({ phase: state.phase + 1 });
    await createBrancher().run({ task: 'Inspect the project files', state: { phase: 0 }, observe });
    await createBrancher().run({ task: 'Inspect the project files', state: { phase: 0 }, observe });
    assert.equal(actorCalls, 6);
    assert.equal((await store.readRoutes()).some(route => route.status === 'active' && route.action?.actions), true);
    const replay = await createBrancher().run({ task: 'Inspect the project files', state: { phase: 0 }, observe });
    assert.deepEqual(replay.events.map(event => event.decision.source), ['learned', 'learned']);
    assert.equal(actorCalls, 6);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generic brancher revalidates learned workflows and quarantines a failed postcondition', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-runtime-replay-outcome-'));
  try {
    const store = createLocalLearningStore({ directory });
    const createBrancher = options => createJBrancher({
      getCandidates: async ({ state }) => state.phase === 0
        ? [{ tool: 'read', args: { path: 'package.json' } }]
        : state.phase === 1 ? [{ tool: 'read', args: { path: 'README.md' } }] : [],
      actor: async ({ state }) => state.phase === 0
        ? { action: { tool: 'read', args: { path: 'package.json' } } }
        : state.phase === 1
          ? { action: { tool: 'read', args: { path: 'README.md' } } }
          : { action: null },
      execute: async action => 'contents of ' + action.args.path,
      learningStore: store,
      ...options
    });
    const observe = async ({ state }) => ({ phase: state.phase + 1 });
    await createBrancher().run({ task: 'Inspect project files', state: { phase: 0 }, observe });
    await createBrancher().run({ task: 'Inspect project files', state: { phase: 0 }, observe });
    const replay = await createBrancher({ learningOutcome: () => false }).run({
      task: 'Inspect project files',
      state: { phase: 0 },
      observe
    });
    assert.equal(replay.learningOutcome, 'unknown');
    assert.equal(replay.learnedRouteQuarantined, true);
    assert.equal(replay.events.at(-1).decision.source, 'actor');
    assert.equal(replay.fallbackAfterLearnedRoute, (await store.readRoutes())[0].id);
    assert.equal((await store.readRoutes()).every(route => route.status === 'quarantined'), true);
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

test('decision service ingests open-world episodes into the local learning dataset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-runtime-proxy-learning-'));
  let evaluatorCalls = 0;
  const service = createJBrancherServer({
    evaluate: async () => { evaluatorCalls += 1; return { scores: [0.9], usage: [] }; },
    learningDirectory: directory,
    learningSource: 'test-proxy'
  });
  const address = await service.listen({ port: 0 });
  try {
    const baseUrl = `http://${address.host}:${address.port}`;
    const health = await fetch(`${baseUrl}/health`).then(response => response.json());
    assert.equal(health.learningConfigured, true);
    const postEpisode = () => fetch(`${baseUrl}/v1/episodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Inspect package.json',
        source: 'python-harness',
        routeResolution: 'unmatched',
        metadata: { runId: 'redacted-test-run' },
        toolCalls: [{
          toolCallId: 'call-1',
          toolName: 'read',
          input: { path: 'package.json' },
          context: { candidateCount: 0 },
          ok: true,
          output: 'all tests passed'
        }],
        outcome: 'success'
      })
    });
    const response = await postEpisode();
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.trace.outcome, 'success');
    assert.equal(body.trace.source, 'python-harness');
    assert.equal(body.learning.traces, 1);
    assert.equal(body.learning.outcomes.success, 1);
    assert.equal(body.learning.resolutions.unmatched, 1);
    await postEpisode();
    const replay = await fetch(`${baseUrl}/v1/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Inspect package.json',
        state: { ready: true },
        candidates: [{ tool: 'read', args: { path: 'package.json' } }]
      })
    }).then(result => result.json());
    assert.equal(replay.source, 'learned');
    assert.deepEqual(replay.action, { tool: 'read', args: { path: 'package.json' } });
    assert.equal(evaluatorCalls, 0);
    const replayFeedback = await fetch(`${baseUrl}/v1/episodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Inspect package.json',
        routeId: replay.routeId,
        routeResolution: 'learned',
        source: 'python-harness',
        toolCalls: [{
          toolCallId: 'learned-call-1',
          toolName: 'read',
          input: { path: 'package.json' },
          ok: true,
          output: 'package contents'
        }],
        outcome: 'success'
      })
    }).then(result => result.json());
    assert.equal(replayFeedback.routeSuccessRecorded, true);
    const stats = await fetch(`${baseUrl}/stats`).then(result => result.json());
    assert.equal(stats.episodesRecorded, 3);
    assert.equal(stats.sources.learned, 1);
    const learning = await fetch(`${baseUrl}/v1/learning`).then(result => result.json());
    assert.equal(learning.traces, 3);
    assert.equal(learning.successfulReplays, 1);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('decision service requires explicit postcondition verification for learned writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-runtime-proxy-verified-'));
  let evaluatorCalls = 0;
  const service = createJBrancherServer({
    evaluate: async () => { evaluatorCalls += 1; return { scores: [0.9], usage: [] }; },
    learningDirectory: directory,
    learningAllowVerified: true
  });
  const address = await service.listen({ port: 0 });
  try {
    const baseUrl = `http://${address.host}:${address.port}`;
    const post = () => fetch(`${baseUrl}/v1/episodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Update the generated artifact',
        routeResolution: 'unmatched',
        toolCalls: [{
          toolName: 'write',
          input: { path: 'output.txt', content: 'verified' },
          ok: true,
          output: 'written'
        }],
        finishMetadata: { postconditionValidated: true },
        outcome: 'success'
      })
    });
    assert.equal((await post()).status, 201);
    assert.equal((await post()).status, 201);
    const decision = await fetch(`${baseUrl}/v1/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Update the generated artifact',
        candidates: [{ tool: 'write', args: { path: 'output.txt', content: 'verified' } }]
      })
    }).then(result => result.json());
    assert.equal(decision.source, 'learned');
    assert.deepEqual(decision.action, { tool: 'write', args: { path: 'output.txt', content: 'verified' } });
    assert.equal(evaluatorCalls, 0);
    const failed = await fetch(`${baseUrl}/v1/episodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Update the generated artifact',
        routeId: decision.routeId,
        routeResolution: 'failed',
        toolCalls: [{
          toolName: 'write',
          input: { path: 'output.txt', content: 'verified' },
          ok: false,
          output: 'postcondition failed'
        }],
        failureReason: 'postcondition failed',
        outcome: 'failure'
      })
    }).then(result => result.json());
    assert.equal(failed.routeFailureRecorded, true);
    const recovered = await fetch(`${baseUrl}/v1/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Update the generated artifact',
        candidates: [{ tool: 'write', args: { path: 'output.txt', content: 'verified' } }]
      })
    }).then(result => result.json());
    assert.equal(recovered.source, 'jev');
    assert.equal(evaluatorCalls, 1);
    const learning = await fetch(`${baseUrl}/v1/learning`).then(result => result.json());
    assert.equal(learning.quarantinedRoutes, 1);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
