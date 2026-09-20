import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyActionSafety, createEpisodeRecorder, createLocalLearningStore, createLearnedRoutes, proposeRoutes, redactText, refreshAndPromoteReadOnly } from '../src/learning.js';
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
    assert.equal((await readFile(store.datasetPath, 'utf8')).trim().split(/\r?\n/).length, 1);
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

test('a single successful fallback becomes a candidate before promotion evidence is complete', async () => {
  const directory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'jbrancher-learning-candidate-'));
  try {
    const store = createLocalLearningStore({ directory });
    await store.appendTrace({
      task: 'read README.md',
      source: 'test',
      outcome: 'success',
      toolCalls: [{ toolName: 'read', input: { path: 'README.md' }, ok: true }]
    });
    const learned = await refreshAndPromoteReadOnly(store);
    const routes = await store.readRoutes();
    assert.equal(learned.promoted.length, 0);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].status, 'candidate');
    assert.equal(routes[0].observations, 1);
    assert.equal((await store.writeDataset()).examples.length, 1);
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

test('the learning recorder is harness-neutral and writes one episode dataset row', async () => {
  const directory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'jbrancher-learning-'));
  try {
    const store = createLocalLearningStore({ directory });
    const recorder = createEpisodeRecorder({
      store,
      task: 'inspect package.json',
      source: 'custom-harness',
      metadata: { initialState: { path: 'src/index.js', apiKey: 'do-not-store' } }
    });
    recorder.recordToolCall({ toolCallId: 'call-1', toolName: 'read', input: { path: 'package.json' } });
    recorder.recordToolResult({ toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'package contents' }] });
    const saved = await recorder.finish();
    assert.equal(saved.source, 'custom-harness');
    assert.equal(saved.outcome, 'success');
    assert.equal((await store.readTraces()).length, 1);
    assert.equal((await readFile(store.datasetPath, 'utf8')).trim().split(/\r?\n/).length, 1);
    const [example] = (await store.writeDataset()).examples;
    assert.equal(example.context.initialState.path, 'src/index.js');
    assert.equal(example.context.initialState.apiKey, '[REDACTED]');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('safe inspection commands can be learned while shell escapes and sensitive paths stay unsafe', () => {
  assert.equal(classifyActionSafety('bash', { command: 'rg "TODO" src' }), 'read-only');
  assert.equal(classifyActionSafety('bash', { command: 'cat .env' }), 'side-effect-or-unknown');
  assert.equal(classifyActionSafety('bash', { command: 'cat ../secrets.txt' }), 'side-effect-or-unknown');
  assert.equal(classifyActionSafety('bash', { command: 'rg TODO src && rm -rf build' }), 'side-effect-or-unknown');
  assert.equal(classifyActionSafety('bash', { command: 'find . -delete' }), 'side-effect-or-unknown');
  assert.equal(classifyActionSafety('bash', { command: 'rg --pre=./scanner TODO src' }), 'side-effect-or-unknown');
});

test('learned inspection commands replay through the Pi executor', async () => {
  const traces = [
    { task: 'inspect TODO markers', outcome: 'success', toolCalls: [{ toolName: 'bash', input: { command: 'rg "TODO" src' }, ok: true }] },
    { task: 'inspect TODO markers', outcome: 'success', toolCalls: [{ toolName: 'bash', input: { command: 'rg "TODO" src' }, ok: true }] }
  ];
  const [candidate] = proposeRoutes(traces);
  candidate.status = 'active';
  const router = createPiRouter({ routes: createLearnedRoutes([candidate]) });
  const result = await router.handle({
    task: 'inspect TODO markers',
    exec: async (program, args) => {
      assert.equal(program, 'bash');
      assert.deepEqual(args, ['-lc', 'rg "TODO" src']);
      return { code: 0, stdout: 'src/app.js:1:TODO', stderr: '' };
    }
  });
  assert.equal(result.source, 'deterministic');
  assert.equal(result.result, 'src/app.js:1:TODO');
});

test('learning generalizes repeated read workflows across conservative paraphrases', async () => {
  const traces = ['read package.json', 'read package.json', 'open package.json', 'open package.json']
    .map((task, index) => ({
      id: String(index),
      task,
      outcome: 'success',
      toolCalls: [{ toolName: 'read', input: { path: 'package.json' }, ok: true }]
    }));
  const [candidate] = proposeRoutes(traces);
  assert.equal(candidate.matcher.type, 'token-similarity');
  assert.equal(candidate.observations, 4);

  candidate.status = 'active';
  const router = createPiRouter({ routes: createLearnedRoutes([candidate]) });
  const generalized = await router.handle({
    task: 'show package.json',
    readFile: async path => `contents of ${path}`
  });
  assert.equal(generalized.source, 'deterministic');
  assert.equal(generalized.result, 'contents of package.json');

  const unrelated = await router.decide({ task: 'read license file' });
  assert.equal(unrelated.source, 'frontier');
});

test('learning can bind a safe read route to a new relative path', async () => {
  const traces = [
    { task: 'read package.json', outcome: 'success', toolCalls: [{ toolName: 'read', input: { path: 'package.json' }, ok: true }] },
    { task: 'open README.md', outcome: 'success', toolCalls: [{ toolName: 'read', input: { path: 'README.md' }, ok: true }] }
  ];
  const [candidate] = proposeRoutes(traces);
  assert.equal(candidate.matcher.type, 'read-path');
  candidate.status = 'active';
  const router = createPiRouter({ routes: createLearnedRoutes([candidate]) });
  const result = await router.handle({
    task: 'inspect src/index.js',
    readFile: async path => `contents of ${path}`
  });
  assert.equal(result.source, 'deterministic');
  assert.equal(result.result, 'contents of src/index.js');
  assert.equal((await router.decide({ task: 'delete secrets.pem' })).source, 'frontier');
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

test('sensitive or out-of-project reads are never replayable learned routes', () => {
  const traces = [
    { task: 'read .env', outcome: 'success', toolCalls: [{ toolName: 'read', input: { path: '.env' }, ok: true }] },
    { task: 'read .env', outcome: 'success', toolCalls: [{ toolName: 'read', input: { path: '.env' }, ok: true }] }
  ];
  const [candidate] = proposeRoutes(traces);
  assert.equal(candidate.safety, 'side-effect-or-unknown');
  assert.equal(classifyActionSafety('read', { path: 'password.txt' }), 'side-effect-or-unknown');
  candidate.status = 'active';
  assert.deepEqual(createLearnedRoutes([candidate]), []);
});
