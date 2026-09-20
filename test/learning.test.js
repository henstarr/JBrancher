import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createLocalLearningStore, createLearnedRoutes, proposeRoutes, redactText } from '../src/learning.js';
import { createPiRouter } from '../src/pi.js';

test('local learning stores redacted traces and proposes repeated read routes', async () => {
  const directory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'jbrancher-learning-'));
  try {
    const store = createLocalLearningStore({ directory });
    const trace = {
      task: 'Read the failing test file',
      cwd: directory,
      toolCalls: [{ toolCallId: '1', toolName: 'read', input: { path: 'test/parser.js', apiKey: 'secret-value' }, ok: true }],
      outcome: 'success'
    };
    await store.appendTrace(trace);
    await store.appendTrace({ ...trace, toolCalls: [{ ...trace.toolCalls[0], toolCallId: '2' }] });
    await store.appendTrace({ ...trace, outcome: 'unknown' });

    const traces = await store.readTraces();
    assert.equal(traces.length, 3);
    assert.equal(traces[0].toolCalls[0].input.apiKey, '[REDACTED]');
    const dataset = await store.writeDataset();
    assert.equal(dataset.examples.length, 3);
    assert.equal(dataset.examples[0].steps[0].input.apiKey, '[REDACTED]');
    assert.equal(dataset.examples[0].reusable, true);
    const candidates = await store.refreshCandidates();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].status, 'candidate');
    assert.equal(candidates[0].safety, 'read-only');
    await store.promote(candidates[0].id);
    const routes = createLearnedRoutes(await store.readRoutes());
    const router = createPiRouter({ routes });
    const result = await router.handle({
      task: 'Read the failing test file',
      readFile: async path => `contents of ${path}`
    });
    assert.equal(result.source, 'deterministic');
    assert.equal(result.result, 'contents of test/parser.js');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('learning can replay a repeated read-only workflow with multiple steps', async () => {
  const directory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'jbrancher-learning-'));
  try {
    const store = createLocalLearningStore({ directory });
    const trace = {
      task: 'Inspect the two config files',
      cwd: directory,
      toolCalls: [
        { toolName: 'read', input: { path: 'package.json' }, ok: true },
        { toolName: 'read', input: { path: 'jbrancher.config.js' }, ok: true }
      ],
      outcome: 'success'
    };
    await store.appendTrace(trace);
    await store.appendTrace({ ...trace, toolCalls: trace.toolCalls.map((call, index) => ({ ...call, toolCallId: String(index + 2) })) });
    const routes = await store.refreshCandidates();
    assert.equal(routes.length, 1);
    assert.equal(routes[0].safety, 'read-only');
    await store.promote(routes[0].id);
    const router = createPiRouter({ routes: createLearnedRoutes(await store.readRoutes()) });
    const result = await router.handle({
      task: 'Inspect the two config files',
      readFile: async path => `contents of ${path}`
    });
    assert.deepEqual(result.result, ['contents of package.json', 'contents of jbrancher.config.js']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('learning proposals ignore failed traces and unsafe actions', () => {
  const traces = [
    { task: 'delete the build', taskNormalized: 'delete the build', outcome: 'success', toolCalls: [{ toolName: 'bash', input: { command: 'rm -rf build' } }] },
    { task: 'delete the build', taskNormalized: 'delete the build', outcome: 'success', toolCalls: [{ toolName: 'bash', input: { command: 'rm -rf build' } }] },
    { task: 'do not learn this', taskNormalized: 'do not learn this', outcome: 'unknown', toolCalls: [{ toolName: 'read', input: { path: 'x' } }] }
  ];
  const candidates = proposeRoutes(traces);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].safety, 'side-effect-or-unknown');
  assert.match(redactText('Authorization: Bearer abcdefghijklmnop'), /REDACTED/);
});

test('unsafe candidates require explicit force to promote', async () => {
  const directory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'jbrancher-learning-'));
  try {
    const store = createLocalLearningStore({ directory });
    await store.writeRoutes([{ id: 'unsafe', status: 'candidate', safety: 'side-effect-or-unknown' }]);
    await assert.rejects(store.promote('unsafe'), /Only read-only/);
    const promoted = await store.promote('unsafe', { force: true });
    assert.equal(promoted.status, 'active');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
