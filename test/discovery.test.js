import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenWorldLearner } from '../src/discovery.js';

test('open-world learner records any unmatched episode and promotes repeated safe work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-discovery-'));
  try {
    const learner = createOpenWorldLearner({ directory, source: 'test-harness' });
    for (const id of ['first', 'second']) {
      const episode = learner.begin({
        task: 'inspect package.json',
        routeResolution: 'unmatched',
        metadata: { initialState: { id } }
      });
      episode.recordToolCall({ toolCallId: id, toolName: 'read', input: { path: 'package.json' } });
      episode.recordToolResult({ toolCallId: id, isError: false, content: [{ type: 'text', text: 'ok' }] });
      const saved = await episode.finish({ outcome: 'success' });
      assert.equal(saved.routeResolution, 'unmatched');
    }

    const routes = JSON.parse(await readFile(join(directory, 'routes.json'), 'utf8'));
    const dataset = (await readFile(join(directory, 'dataset.jsonl'), 'utf8'))
      .trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(routes.length, 1);
    assert.equal(routes[0].status, 'active');
    assert.equal(dataset.length, 2);
    assert.ok(dataset.every(example => example.routeResolution === 'unmatched'));
    const snapshot = await learner.snapshot();
    assert.deepEqual(snapshot.resolutions, { unmatched: 2 });
    assert.deepEqual(snapshot.replay, {
      attempts: 0,
      successes: 0,
      failures: 0,
      successRate: null,
      activeRoutesWithReplays: 0,
      estimatedFrontierStepsAvoided: 0
    });
    assert.equal(snapshot.replayTelemetry[0].observations, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('open-world snapshot reports replay value and quarantined failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-discovery-telemetry-'));
  try {
    const learner = createOpenWorldLearner({ directory });
    for (const id of ['first', 'second']) {
      const episode = learner.begin({ task: 'inspect package.json', routeResolution: 'unmatched' });
      episode.recordToolCall({ toolCallId: id, toolName: 'read', input: { path: 'package.json' } });
      episode.recordToolResult({ toolCallId: id, isError: false, content: [{ type: 'text', text: 'ok' }] });
      await episode.finish({ outcome: 'success' });
    }
    const route = (await learner.store.readRoutes())[0];
    await learner.store.recordRouteSuccess(route.id);
    let snapshot = await learner.snapshot();
    assert.deepEqual(snapshot.replay, {
      attempts: 1,
      successes: 1,
      failures: 0,
      successRate: 1,
      activeRoutesWithReplays: 1,
      estimatedFrontierStepsAvoided: 1
    });
    assert.equal(snapshot.replayTelemetry[0].replaySuccessRate, 1);

    await learner.store.recordRouteFailure(route.id, { reason: 'capability changed' });
    snapshot = await learner.snapshot();
    assert.equal(snapshot.replay.failures, 1);
    assert.equal(snapshot.replay.successRate, 0.5);
    assert.equal(snapshot.replayTelemetry[0].status, 'quarantined');
    assert.equal(snapshot.replayTelemetry[0].failures, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('open-world learner keeps no-tool frontier work as demand evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-discovery-empty-'));
  try {
    const learner = createOpenWorldLearner({ directory });
    const episode = learner.begin({ task: 'explain the architecture', routeResolution: 'unmatched' });
    const saved = await episode.finish({ outcome: 'unknown' });
    assert.equal(saved.toolCalls.length, 0);
    const dataset = (await readFile(join(directory, 'dataset.jsonl'), 'utf8'))
      .trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(dataset[0].reusable, false);
    assert.equal(dataset[0].routeResolution, 'unmatched');
    assert.equal((await learner.snapshot()).outcomes.unknown, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('open-world snapshot totals recorded frontier usage without retaining secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-discovery-usage-'));
  try {
    const learner = createOpenWorldLearner({ directory });
    const episode = learner.begin({ task: 'inspect package.json', routeResolution: 'unmatched' });
    episode.recordToolCall({
      toolCallId: 'usage-1',
      toolName: 'read',
      input: { path: 'package.json' },
      context: { selection: { usage: [{ inputTokens: 123, outputTokens: 7, apiKey: 'apikey_should_not_persist_1234567890' }] } }
    });
    episode.recordToolResult({ toolCallId: 'usage-1', isError: false, output: 'ok' });
    await episode.finish({ outcome: 'success' });
    const snapshot = await learner.snapshot();
    assert.deepEqual(snapshot.usage, {
      usageRows: 1,
      observedInputRows: 1,
      observedOutputRows: 1,
      inputTokens: 123,
      outputTokens: 7,
      totalTokens: 130
    });
    const [trace] = await learner.store.readTraces();
    assert.equal(trace.toolCalls[0].context.selection.usage[0].apiKey, '[REDACTED]');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('open-world learner ingests a completed frontier trajectory in one call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jbrancher-discovery-ingest-'));
  try {
    const learner = createOpenWorldLearner({ directory, source: 'batch-harness' });
    const saved = await learner.recordEpisode({
      task: 'inspect package.json',
      metadata: { candidateCount: 0, apiKey: 'apikey_should_not_persist_1234567890' },
      toolCalls: [{
        toolName: 'read',
        input: { path: 'package.json' },
        ok: true,
        output: 'package contents'
      }],
      outcome: 'success'
    });
    assert.equal(saved.source, 'batch-harness');
    assert.equal(saved.routeResolution, 'unmatched');
    assert.equal((await learner.store.readTraces()).length, 1);
    const datasetText = await readFile(join(directory, 'dataset.jsonl'), 'utf8');
    assert.doesNotMatch(datasetText, /apikey_should_not_persist/);
    assert.equal((await learner.store.readRoutes()).length, 1);
    await assert.rejects(
      learner.recordEpisode({ task: 'bad input', toolCalls: [{ input: {} }] }),
      /toolName/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
