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
    assert.deepEqual((await learner.snapshot()).resolutions, { unmatched: 2 });
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

