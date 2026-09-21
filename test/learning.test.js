import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyActionSafety, createEpisodeRecorder, createLocalLearningStore, createLearnedRoutes, deduplicateDataset, findLearnedActions, proposeRoutes, redactText, refreshAndPromoteReadOnly, taskSimilarity, traceToDatasetExample } from '../src/learning.js';
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

test('curated exports stay separate from the append-only live dataset', async () => {
  const directory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'jbrancher-learning-curated-file-'));
  try {
    const store = createLocalLearningStore({ directory });
    const trace = {
      task: 'read README.md',
      source: 'test',
      routeResolution: 'unmatched',
      outcome: 'success',
      toolCalls: [{ toolName: 'read', input: { path: 'README.md' }, ok: true }]
    };
    await store.appendTrace(trace);
    const curated = await store.writeDataset({ deduplicate: true });
    assert.equal(curated.path, store.curatedDatasetPath);
    assert.notEqual(curated.path, store.datasetPath);
    assert.equal((await readFile(store.datasetPath, 'utf8')).trim().split(/\r?\n/).length, 1);
    assert.equal((await readFile(store.curatedDatasetPath, 'utf8')).trim().split(/\r?\n/).length, 1);

    await store.appendTrace({ ...trace, id: 'second-observation' });
    assert.equal((await readFile(store.datasetPath, 'utf8')).trim().split(/\r?\n/).length, 2);
    assert.equal((await readFile(store.curatedDatasetPath, 'utf8')).trim().split(/\r?\n/).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local learning stores serialize concurrent route mutations across store instances', async () => {
  const directory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'jbrancher-learning-lock-'));
  try {
    const firstStore = createLocalLearningStore({ directory });
    const secondStore = createLocalLearningStore({ directory });
    await firstStore.writeRoutes([
      { id: 'route-a', status: 'candidate', safety: 'read-only' },
      { id: 'route-b', status: 'candidate', safety: 'read-only' }
    ]);

    await Promise.all([
      firstStore.promote('route-a'),
      secondStore.promote('route-b')
    ]);
    let routes = await firstStore.readRoutes();
    assert.deepEqual(routes.map(route => route.status), ['active', 'active']);

    await Promise.all([
      firstStore.recordRouteFailure('route-a', { reason: 'first failure' }),
      secondStore.recordRouteFailure('route-b', { reason: 'second failure' })
    ]);
    routes = await firstStore.readRoutes();
    assert.deepEqual(routes.map(route => route.status), ['quarantined', 'quarantined']);
    assert.deepEqual(routes.map(route => route.failures), [1, 1]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local learning stores promote and quarantine exact route preferences', async () => {
  const directory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'jbrancher-learning-preference-'));
  try {
    const store = createLocalLearningStore({ directory });
    const concurrentStore = createLocalLearningStore({ directory });
    const [first, second] = await Promise.all([
      store.recordPreferenceSuccess({ task: 'choose the safe inspection route', routeId: 'inspect', minimumObservations: 2 }),
      concurrentStore.recordPreferenceSuccess({ task: 'choose the safe inspection route', routeId: 'inspect', minimumObservations: 2 })
    ]);
    assert.deepEqual(new Set([first.status, second.status]), new Set(['candidate', 'active']));
    assert.equal((await store.findPreference('choose the safe inspection route', ['inspect'])).routeId, 'inspect');
    assert.equal((await store.readPreferences())[0].observations, 2);
    assert.equal(await store.findPreference('choose the safe inspection route', ['other']), null);
    const failed = await store.recordPreferenceFailure({ task: 'choose the safe inspection route', routeId: 'inspect', reason: 'route became invalid' });
    assert.equal(failed.status, 'quarantined');
    assert.equal(await store.findPreference('choose the safe inspection route', ['inspect']), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('candidate refresh accumulates new evidence without reviving quarantined routes', async () => {
  const directory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'jbrancher-learning-refresh-'));
  try {
    const store = createLocalLearningStore({ directory });
    const trace = id => ({
      id,
      task: 'inspect package.json',
      toolCalls: [{ toolCallId: id, toolName: 'read', input: { path: 'package.json' }, ok: true }],
      outcome: 'success'
    });
    await store.appendTrace(trace('one'));
    await store.appendTrace(trace('two'));
    await refreshAndPromoteReadOnly(store, { minimumObservations: 2 });
    let routes = await store.readRoutes();
    assert.equal(routes.length, 1);
    assert.equal(routes[0].status, 'active');
    assert.equal(routes[0].observations, 2);
    await store.recordRouteSuccess(routes[0].id);

    await store.appendTrace(trace('three'));
    await store.refreshCandidates();
    routes = await store.readRoutes();
    assert.equal(routes[0].status, 'active');
    assert.equal(routes[0].observations, 3);
    assert.equal(routes[0].successfulReplays, 1);

    await store.recordRouteFailure(routes[0].id, { reason: 'authorization changed' });
    await store.appendTrace(trace('four'));
    await store.refreshCandidates();
    routes = await store.readRoutes();
    assert.equal(routes[0].status, 'quarantined');
    assert.equal(routes[0].observations, 4);
    assert.equal(routes[0].failures, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local preferences are isolated by redacted execution context', async () => {
  const directory = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'jbrancher-learning-context-'));
  try {
    const store = createLocalLearningStore({ directory });
    const firstContext = { cwd: '/workspace/one', mode: 'json', providerToken: 'apikey_sensitive_value_1234567890' };
    const secondContext = { cwd: '/workspace/two', mode: 'json', providerToken: 'apikey_sensitive_value_1234567890' };
    await store.recordPreferenceSuccess({ task: 'choose a route', routeId: 'inspect', context: firstContext, minimumObservations: 2 });
    await store.recordPreferenceSuccess({ task: 'choose a route', routeId: 'inspect', context: firstContext, minimumObservations: 2 });
    assert.equal((await store.findPreference('choose a route', ['inspect'], { context: firstContext })).routeId, 'inspect');
    assert.equal(await store.findPreference('choose a route', ['inspect'], { context: secondContext }), null);
    assert.equal(await store.findPreference('choose a route', ['inspect']), null);
    const persisted = JSON.stringify(await store.readPreferences());
    assert.doesNotMatch(persisted, /workspace\/one|providerToken|apikey_sensitive_value/);
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

test('dataset fingerprints and splits remain stable across repeated episodes', () => {
  const first = traceToDatasetExample({
    id: 'episode-a',
    task: 'Read package.json',
    toolCalls: [{ toolCallId: 'call-a', toolName: 'read', input: { path: 'package.json' }, ok: true }]
  });
  const repeated = traceToDatasetExample({
    id: 'episode-b',
    task: 'Read package.json',
    toolCalls: [{ toolCallId: 'call-b', toolName: 'read', input: { path: 'package.json' }, ok: true }]
  });
  assert.equal(first.fingerprint, repeated.fingerprint);
  assert.equal(first.split, repeated.split);
  assert.notEqual(first.exampleId, repeated.exampleId);
});

test('task similarity ignores a conservative investigation wrapper', () => {
  const task = 'astropy__astropy-12907: separability is wrong for nested compound models';
  const wrapped = 'Please open the relevant test file to investigate this issue: ' + task;
  assert.ok(taskSimilarity(task, wrapped) >= 0.8);
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

test('learning derives a conservative action template from varied frontier arguments', () => {
  const traces = [
    { task: 'lookup auth in docs', outcome: 'success', metadata: { postconditionValidated: true }, toolCalls: [{ toolName: 'lookup', input: { query: 'auth', scope: 'docs' }, ok: true }] },
    { task: 'lookup billing in docs', outcome: 'success', metadata: { postconditionValidated: true }, toolCalls: [{ toolName: 'lookup', input: { query: 'billing', scope: 'docs' }, ok: true }] }
  ];
  const candidates = proposeRoutes(traces);
  const candidate = candidates.find(route => route.matcher?.type === 'action-template');
  assert.ok(candidate);
  assert.equal(candidate.matcher.template, 'lookup {{jbrancher.slot.key-query}} in docs');
  assert.deepEqual(candidate.action.input, {
    query: '{{jbrancher.slot.key-query}}',
    scope: 'docs'
  });
  assert.equal(candidate.verified, true);
  candidate.status = 'active';
  assert.deepEqual(findLearnedActions([candidate], 'lookup payments in docs', { allowVerified: true }), [{
    id: candidate.id,
    action: { tool: 'lookup', args: { query: 'payments', scope: 'docs' } }
  }]);
  assert.deepEqual(findLearnedActions([candidate], 'lookup payments in tickets', { allowVerified: true }), []);
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

test('curated dataset export collapses duplicate trajectories but preserves evidence counts', () => {
  const examples = [
    traceToDatasetExample({
      id: 'unknown',
      task: 'inspect package.json',
      source: 'pi',
      routeResolution: 'unmatched',
      outcome: 'unknown',
      createdAt: '2026-09-20T00:00:00.000Z',
      toolCalls: [{ toolName: 'read', input: { path: 'package.json' }, ok: true }]
    }),
    traceToDatasetExample({
      id: 'success',
      task: 'inspect package.json',
      source: 'harbor',
      routeResolution: 'unmatched',
      outcome: 'success',
      createdAt: '2026-09-20T00:01:00.000Z',
      toolCalls: [{ toolName: 'read', input: { path: 'package.json' }, ok: true }]
    })
  ];

  const [curated] = deduplicateDataset(examples);
  assert.equal(curated.schemaVersion, 2);
  assert.equal(curated.exampleId, `curated-${examples[0].fingerprint}`);
  assert.equal(curated.outcome, 'success');
  assert.equal(curated.reusable, true);
  assert.deepEqual(curated.evidence, {
    observations: 2,
    outcomes: { unknown: 1, success: 1 },
    routeResolutions: { unmatched: 2 },
    sources: ['harbor', 'pi']
  });
  assert.equal(curated.firstSeen, '2026-09-20T00:00:00.000Z');
  assert.equal(curated.lastSeen, '2026-09-20T00:01:00.000Z');
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
